import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {getRoute} from "./_route.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const addMonths=(date,months)=>{
 const [y,m,d]=date.split("-").map(Number);
 const x=new Date(Date.UTC(y,m-1,1));
 x.setUTCMonth(x.getUTCMonth()+months);
 const last=new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth()+1,0)).getUTCDate();
 x.setUTCDate(Math.min(d,last));
 return x.toISOString().slice(0,10);
};
const startOfYear=date=>date.slice(0,4)+"-01-01";
const endOfNextMonth=date=>{const [y,m]=date.split("-").map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10)};
const historyRange=today=>({start:startOfYear(today),end:endOfNextMonth(today)});
const validDate=date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date));
const inRange=(date,range)=>date>=range.start&&date<=range.end;
const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.stage==="CONFIRMED"&&x.historyStatus!=="SUPERSEDED";
const historyKey=(routeId,date)=>"zp:route:"+routeId+":history:"+date;

async function readWaybill(env,id){
 const raw=await get(env,"waybill:"+id);
 if(!raw)return null;
 try{const x=typeof raw==="string"?JSON.parse(raw):raw;return validWaybill(x)?x:null}catch{return null}
}

async function scanConfirmedWaybill(env,routeId,date){
 let cursor="0",found=null;
 do{
  const r=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
  cursor=String(r?.[0]??"0");
  for(const key of (r?.[1]||[])){
   if(!/^zp:waybill:[^:]+$/.test(String(key)))continue;
   const raw=await get(env,String(key).replace(/^zp:/,""));
   try{
    const x=typeof raw==="string"?JSON.parse(raw):raw;
    if(validWaybill(x)&&x.routeId===routeId&&x.date===date&&(!found||String(x.createdAt||"")>String(found.createdAt||"")))found=x;
   }catch{}
  }
 }while(cursor!=="0");
 return found;
}


async function readHistoryEntry(env,key){
 const raw=await get(env,key);
 if(!raw)return null;
 try{
  const value=typeof raw==="string"?JSON.parse(raw):raw;
  if(value&&typeof value==="object"&&value.id)return validWaybill(value)?value:null;
  const id=clean(raw);
  return id?await readWaybill(env,id):null;
 }catch{
  const id=clean(raw);
  return id?await readWaybill(env,id):null;
 }
}

async function readHistoryIds(env,routeId){
 const ids=[];
 let cursor="0";
 do{
  const r=await command(env,["SCAN",cursor,"MATCH","zp:route:"+routeId+":history:*","COUNT","100"]);
  cursor=String(r?.[0]??"0");
  const prefix="zp:route:"+routeId+":history:";
  for(const key of (r?.[1]||[])){
   const text=String(key);if(!text.startsWith(prefix))continue;
   const date=text.slice(prefix.length);if(/^\d{4}-\d{2}-\d{2}$/.test(date))ids.push({date,key:text});
  }
 }while(cursor!=="0");
 return ids;
}

export async function onRequestGet({request,env}){
 try{
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const url=new URL(request.url);
 const routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId);
 const date=clean(url.searchParams.get("date"));
 if(!routeId)return json({success:true,routeId:null,months:[],history:[]});
 const route=await getRoute(env,routeId);const routeName=clean(route?.name)||"临时";
 async function withRouteData(w){
  if(!w)return w;
  w.routeName=clean(w.routeName)||routeName;
  if(!Array.isArray(w.stores)||!w.stores.length)return w;
  try{
   const rawBase=await get(env,"route:"+routeId+":base");
   const parsed=typeof rawBase==="string"?JSON.parse(rawBase):rawBase;
   const baseStores=Array.isArray(parsed?.stores)?parsed.stores:[];
   const byId=new Map(baseStores.map(s=>[clean(s?.storeId),s]).filter(x=>x[0]));
   const baseKey=v=>clean(v).normalize("NFKC").replace(/\s+/g,"").replace(/[，。；;：:、（）()【】\[\]{}<>《》“”"'‘’]/g,"").toLowerCase();
   const byName=new Map();
   for(const bs of baseStores){
    for(const field of [bs?.name,bs?.originalName,...(Array.isArray(bs?.aliases)?bs.aliases:[])]){
     const key=baseKey(field); if(key&&!byName.has(key))byName.set(key,bs);
    }
   }
   w.stores=w.stores.map(s=>{
    const baseStore=byId.get(clean(s?.storeId))||byName.get(baseKey(s?.name||s?.rawName))||null;
    if(!baseStore)return s;
    const navigation=clean(baseStore.navigation)||clean(s?.navigation);
    const note=clean(baseStore.note||baseStore.remark)||clean(s?.note||s?.remark);
    return navigation||note?{...s,...(navigation?{navigation}:{}),...(note?{note}: {})}:s;
   });
  }catch{}
  return w;
 }
 if(routeId!==(clean(user.dispatchRouteId)||clean(user.boundRouteId)))return json({success:false,error:"无权查看该线路历史"},403);

 if(date){
  if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期无效"},400);
  const range=historyRange(todayCN());
  if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
  const historyIndexKey=historyKey(routeId,date);
  const indexed=await readHistoryEntry(env,historyIndexKey);
  if(!indexed){
   const recovered=await scanConfirmedWaybill(env,routeId,date);
   if(!recovered)return json({success:true,routeId,date,waybill:null});
   try{await command(env,["SET",historyIndexKey,recovered.id]);}catch{}
   return json({success:true,routeId,date,waybill:await withRouteData(recovered),indexSync:"REPAIRED"});
  }
  const waybill=indexed;
  if(!waybill||waybill.routeId!==routeId||waybill.date!==date){
   await command(env,["DEL",historyKey(routeId,date)]).catch(()=>{});
   return json({success:true,routeId,date,waybill:null,indexSync:"INVALID_REMOVED"});
  }
  return json({success:true,routeId,date,waybill:await withRouteData(waybill)});
 }

 const today=todayCN();
 const {start,end}=historyRange(today);
 const entries=await readHistoryIds(env,routeId);
 const dates=[];
 const indexedDates=new Set();
 for(const entry of entries){
  if(entry.date<start||entry.date>end)continue;
  const waybill=await readHistoryEntry(env,entry.key);
  if(!waybill)continue;
  if(!waybill||waybill.routeId!==routeId||waybill.date!==entry.date){
   await command(env,["DEL",entry.key]).catch(()=>{});
   continue;
  }
  indexedDates.add(entry.date);
  dates.push({
   date:entry.date,
   waybillId:waybill.id,
   storeCount:Number(waybill.summary?.total)||waybill.stores.length,
   totalWeight:Number(waybill.totalWeight)||0
  });
 }
 // 历史索引缺失时，先从“今日/最新”主索引恢复，再扫描主运单记录。
 // 这样即使规划保存时 history:{date} 索引同步暂时失败，只要今日运单已经可读，历史查询也能立即恢复。
 const primaryKeys=["route:"+routeId+":orders:today","route:"+routeId+":orders:latest"];
 for(const primaryKey of primaryKeys){
  try{
   const raw=await get(env,primaryKey);
   const w=typeof raw==="string"?JSON.parse(raw):raw;
   if(!validWaybill(w)||w.routeId!==routeId||w.date<start||w.date>end||indexedDates.has(w.date))continue;
   indexedDates.add(w.date);
   dates.push({date:w.date,waybillId:w.id,storeCount:Number(w.summary?.total)||w.stores.length,totalWeight:Number(w.totalWeight)||0});
   await command(env,["SET",historyKey(routeId,w.date),w.id]).catch(()=>{});
  }catch{}
 }
 // 再扫描主运单记录，恢复其它缺失的历史索引。
 let cursor="0";
 do{
  const scan=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
  cursor=String(scan?.[0]??"0");
  for(const key of (scan?.[1]||[])){
   if(!/^zp:waybill:[^:]+$/.test(String(key)))continue;
   const raw=await get(env,String(key).replace(/^zp:/,""));
   try{
    const w=typeof raw==="string"?JSON.parse(raw):raw;
    if(!validWaybill(w)||w.routeId!==routeId||w.date<start||w.date>end||indexedDates.has(w.date))continue;
    indexedDates.add(w.date);
    dates.push({date:w.date,waybillId:w.id,storeCount:Number(w.summary?.total)||w.stores.length,totalWeight:Number(w.totalWeight)||0});
    await command(env,["SET",historyKey(routeId,w.date),w.id]).catch(()=>{});
   }catch{}
  }
 }while(cursor!=="0");
 dates.sort((a,b)=>b.date.localeCompare(a.date));
 const monthMap=new Map();
 for(const item of dates){
  const month=item.date.slice(0,7);
  const current=monthMap.get(month)||{month,days:0,totalStores:0,totalWeight:0};
  current.days++;
  current.totalStores+=item.storeCount;
  current.totalWeight+=item.totalWeight;
  monthMap.set(month,current);
 }
 return json({
  success:true,
  routeId,
  range:{start,end},
  months:[...monthMap.values()],
  history:dates
 });
}catch(e){return json({success:false,code:"HISTORY_READ_FAILED",error:"历史记录读取失败",detail:String(e?.message||e).slice(0,180)},500)}

export async function onRequestDelete({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权删除历史数据"},403);
 const url=new URL(request.url);
 const routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId);
 const date=clean(url.searchParams.get("date"));
 const month=clean(url.searchParams.get("month"));
 const currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);
 if(!routeId||routeId!==currentRoute)return json({success:false,error:"无权操作该线路历史"},403);
 if(month){
  if(!/^\d{4}-\d{2}$/.test(month))return json({success:false,code:"MONTH_INVALID",error:"月份格式错误"},400);
  const range=historyRange(todayCN());
  if(!monthInRange(month,range))return json({success:false,code:"MONTH_OUT_OF_RANGE",error:"月份不在历史查询范围内"},400);
  const monthLock="zp:route:"+routeId+":history-delete-month-lock:"+month,monthToken=crypto.randomUUID();
  if(await command(env,["SET",monthLock,monthToken,"NX","EX","120"])!=="OK")return json({success:false,code:"HISTORY_DELETE_BUSY",error:"该月份历史记录正在处理中，请稍后再试"},409);
  let deleted=0,deletedWaybills=0;
  try{
   const entries=await readHistoryIds(env,routeId);
   for(const entry of entries){
    if(!entry.date.startsWith(month))continue;
    const key=entry.key,order=await readHistoryEntry(env,key),waybillId=clean(order?.id);
    if(!order||!waybillId){await command(env,["DEL",key]).catch(()=>{});continue}
    if(order.routeId!==routeId||order.date!==entry.date||order.stage!=="CONFIRMED"){await command(env,["DEL",key]).catch(()=>{});continue}
    const lockKey="zp:route:"+routeId+":history-delete-lock:"+entry.date,token=crypto.randomUUID();
    if(await command(env,["SET",lockKey,token,"NX","EX","60"])!=="OK")continue;
    try{
     if(clean(await get(env,key))!==waybillId)continue;
     const extra=[];
     for(const indexName of ["route:"+routeId+":orders:today","route:"+routeId+":orders:latest"]){
      const indexRaw=await get(env,indexName);let indexed=null;try{indexed=typeof indexRaw==="string"?JSON.parse(indexRaw):indexRaw}catch{}
      if(indexed?.id===waybillId)extra.push("zp:"+indexName);
     }
     await command(env,["DEL",key,...extra]);
     const keys=["zp:waybill:"+waybillId];let cursor="0";
     do{
      const s=await command(env,["SCAN",cursor,"MATCH","zp:waybill:"+waybillId+":*","COUNT","100"]);
      cursor=String(s?.[0]??"0");if(Array.isArray(s?.[1]))keys.push(...s[1]);
     }while(cursor!=="0");
     const unique=[...new Set(keys)];if(unique.length)await command(env,["DEL",...unique]);
     deleted++;deletedWaybills++;
    }finally{await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1",lockKey,token]).catch(()=>{})}
   }
   return json({success:true,deleted,deletedWaybills,month});
  }finally{await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1",monthLock,monthToken]).catch(()=>{})}
 }
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({success:false,code:"DATE_INVALID",error:"日期格式错误"},400);
 const range=historyRange(todayCN());
 if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
 const key=historyKey(routeId,date);
 const order=await readHistoryEntry(env,key);
 const waybillId=clean(order?.id);
 if(!waybillId)return json({success:true,deleted:false});
 if(order.routeId!==routeId||order.date!==date||order.stage!=="CONFIRMED"){
  await command(env,["DEL",key]);
  return json({success:true,deleted:false,indexSync:"INVALID_REMOVED"});
 }
 const lockKey="zp:route:"+routeId+":history-delete-lock:"+date,token=crypto.randomUUID();
 if(await command(env,["SET",lockKey,token,"NX","EX","60"])!=="OK")return json({success:false,code:"HISTORY_DELETE_BUSY",error:"该历史记录正在处理中，请稍后再试"},409);
 try{
  if(clean(await get(env,key))!==waybillId)return json({success:false,code:"HISTORY_CHANGED",error:"历史记录已发生变化，请刷新后重试"},409);
  const extra=[];
  for(const indexName of ["route:"+routeId+":orders:today","route:"+routeId+":orders:latest"]){
   const indexRaw=await get(env,indexName);let indexed=null;try{indexed=typeof indexRaw==="string"?JSON.parse(indexRaw):indexRaw}catch{}
   if(indexed?.id===waybillId)extra.push("zp:"+indexName);
  }
  await command(env,["DEL",key,...extra]);
  const keys=["zp:waybill:"+waybillId];let cursor="0";
  do{
   const s=await command(env,["SCAN",cursor,"MATCH","zp:waybill:"+waybillId+":*","COUNT","100"]);
   cursor=String(s?.[0]??"0");if(Array.isArray(s?.[1]))keys.push(...s[1]);
  }while(cursor!=="0");
  const unique=[...new Set(keys)];if(unique.length)await command(env,["DEL",...unique]);
  return json({success:true,deleted:true,waybillId,deletedKeys:unique.length});
 }finally{
  await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1",lockKey,token]).catch(()=>{});
 }
}