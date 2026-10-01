import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {getRoute} from "./_route.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;};
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
const validDate=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d;};
const inRange=(date,range)=>date>=range.start&&date<=range.end;
const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED";
const historyReadable=x=>validWaybill(x)&&["PLANNED","CONFIRMED"].includes(x.stage);
const historyKey=(routeId,date)=>"zp:route:"+routeId+":history:"+date;

async function readWaybill(env,id){
 const raw=await get(env,"waybill:"+id);
 if(!raw)return null;
 try{const x=typeof raw==="string"?JSON.parse(raw):raw;return historyReadable(x)?x:null}catch{return null}
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
    if(historyReadable(x)&&x.routeId===routeId&&x.date===date&&(!found||String(x.createdAt||"")>String(found.createdAt||"")))found=x;
   }catch{}
  }
 }while(cursor!=="0");
 return found;
}


async function readHistoryEntries(env,key){
 const physical=String(key).startsWith("zp:")?String(key):"zp:"+String(key);
 let members=[];
 try{
  const type=await command(env,["TYPE",physical]);
  if(String(type)==="set")members=await command(env,["SMEMBERS",physical])||[];
  else{
   const raw=await get(env,physical.replace(/^zp:/,""));
   if(raw){
    try{
     const value=typeof raw==="string"?JSON.parse(raw):raw;
     if(value&&typeof value==="object"&&value.id)members=[value];
     else if(typeof value==="string"&&value)members=[value];
    }catch{members=[String(raw)];}
   }
  }
 }catch{return []}
 const out=[];
 for(const member of members){
  if(member&&typeof member==="object"&&member.id){if(historyReadable(member))out.push(member);continue}
  const id=clean(member);
  if(!id)continue;
  const w=await readWaybill(env,id);
  if(w)out.push(w);
 }
 const seen=new Set();
 return out.filter(w=>{if(seen.has(w.id))return false;seen.add(w.id);return true}).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}
async function readHistoryEntry(env,key){
 const entries=await readHistoryEntries(env,key);
 return entries.length?entries[entries.length-1]:null;
}
async function addHistoryId(env,routeId,date,id){
 if(!routeId||!date||!id)return;
 await command(env,["SADD",historyKey(routeId,date),id]);
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
  let waybills=await readHistoryEntries(env,historyIndexKey);
  if(!waybills.length){
   let cursor="0";
   do{
    const scan=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
    cursor=String(scan?.[0]??"0");
    for(const key of (scan?.[1]||[])){
     if(!/^zp:waybill:[^:]+$/.test(String(key)))continue;
     const raw=await get(env,String(key).replace(/^zp:/,""));
     try{
      const w=typeof raw==="string"?JSON.parse(raw):raw;
      if(historyReadable(w)&&w.routeId===routeId&&w.date===date)waybills.push(w);
     }catch{}
    }
   }while(cursor!=="0");
   const unique=[...new Map(waybills.map(w=>[w.id,w])).values()];
   waybills=unique.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
   if(waybills.length){for(const w of waybills)await addHistoryId(env,routeId,date,w.id).catch(()=>{});}
  }
  waybills=waybills.filter(w=>w.routeId===routeId&&w.date===date);
  const enriched=[];for(const w of waybills)enriched.push(await withRouteData(w));
  return json({
   success:true,routeId,date,
   waybills:enriched,
   count:enriched.length,
   waybill:enriched[enriched.length-1]||null
  });
 }
 const today=todayCN();
 const {start,end}=historyRange(today);
 const entries=await readHistoryIds(env,routeId);
 const byDate=new Map();
 for(const entry of entries){
  if(entry.date<start||entry.date>end)continue;
  const waybills=await readHistoryEntries(env,entry.key);
  for(const waybill of waybills){
   if(waybill.routeId!==routeId||waybill.date!==entry.date)continue;
   const list=byDate.get(entry.date)||[];
   if(!list.some(x=>x.id===waybill.id))list.push(waybill);
   byDate.set(entry.date,list);
  }
 }
 // 索引缺失时扫描主运单记录，恢复该日期的全部历史成员。
 let cursor="0";
 do{
  const scan=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
  cursor=String(scan?.[0]??"0");
  for(const key of (scan?.[1]||[])){
   if(!/^zp:waybill:[^:]+$/.test(String(key)))continue;
   const raw=await get(env,String(key).replace(/^zp:/,""));
   try{
    const w=typeof raw==="string"?JSON.parse(raw):raw;
    if(!historyReadable(w)||w.routeId!==routeId||w.date<start||w.date>end)continue;
    const list=byDate.get(w.date)||[];
    if(!list.some(x=>x.id===w.id))list.push(w);
    byDate.set(w.date,list);
   }catch{}
  }
 }while(cursor!=="0");
 const dates=[];
 for(const [date,list] of byDate){
  list.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
  for(const w of list)await addHistoryId(env,routeId,date,w.id).catch(()=>{});
  const storeCount=list.reduce((sum,w)=>sum+(Number(w.summary?.total)||w.stores.length),0);
  const totalWeight=list.reduce((sum,w)=>sum+(Number(w.totalWeight)||0),0);
  dates.push({date,count:list.length,waybillId:list[list.length-1]?.id||null,storeCount,totalWeight});
 }
 dates.sort((a,b)=>b.date.localeCompare(a.date));
 const monthMap=new Map();
 for(const item of dates){
  const month=item.date.slice(0,7);
  const current=monthMap.get(month)||{month,days:0,waybills:0,totalStores:0,totalWeight:0};
  current.days++;current.waybills+=item.count;current.totalStores+=item.storeCount;current.totalWeight+=item.totalWeight;
  monthMap.set(month,current);
 }
 return json({
  success:true,
  routeId,
  range:{start,end},
  months:[...monthMap.values()],
  history:dates
 });
}catch(e){return json({success:false,code:"HISTORY_READ_FAILED",error:"历史记录读取失败",detail:String(e?.message||e).slice(0,180)},500)
}
}

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