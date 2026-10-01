import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,pipeline} from "./_redis.js";
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
async function readWaybills(env,ids){
 const cleanIds=[...new Set((ids||[]).map(clean).filter(Boolean))];
 if(!cleanIds.length)return [];
 try{
  const rawList=await command(env,["MGET",...cleanIds.map(id=>"zp:waybill:"+id)]);
  const list=Array.isArray(rawList)?rawList:[];
  return list.map((raw,i)=>{
   if(!raw)return null;
   try{const x=typeof raw==="string"?JSON.parse(raw):raw;return historyReadable(x)?x:null}catch{return null}
  }).filter(Boolean);
 }catch{
  const out=[];
  for(const id of cleanIds){const w=await readWaybill(env,id);if(w)out.push(w)}
  return out;
 }
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
  const setMembers=await command(env,["SMEMBERS",physical]);
  if(Array.isArray(setMembers))members=setMembers;
 }catch{
  try{
   const raw=await get(env,physical.replace(/^zp:/,""));
   if(raw){
    try{
     const value=typeof raw==="string"?JSON.parse(raw):raw;
     if(Array.isArray(value))members=value;
     else if(value&&typeof value==="object"&&value.id)members=[value];
     else if(typeof value==="string"&&value)members=[value];
    }catch{members=[String(raw)];}
   }
  }catch{}
 }
 return readHistoryMembers(env,members);
}
async function readHistoryMembers(env,members){
 const out=[],ids=[];
 for(const member of members||[]){
  if(member&&typeof member==="object"&&member.id){if(historyReadable(member))out.push(member);continue}
  const id=clean(member);if(id)ids.push(id);
 }
 out.push(...await readWaybills(env,ids));
 const seen=new Set();
 return out.filter(w=>{if(seen.has(w.id))return false;seen.add(w.id);return true}).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}
async function readHistoryEntriesBatch(env,entries){
 const out=new Map();
 const valid=entries.filter(Boolean);
 if(!valid.length)return out;
 try{
  for(let i=0;i<valid.length;i+=50){
   const chunk=valid.slice(i,i+50);
   const results=await pipeline(env,chunk.map(x=>["SMEMBERS",x.key]));
   for(let j=0;j<chunk.length;j++)out.set(chunk[j].date,await readHistoryMembers(env,results[j]||[]));
  }
 }catch{
  for(const entry of valid)out.set(entry.date,await readHistoryEntries(env,entry.key));
 }
 return out;
}
async function readHistoryEntry(env,key){
 const entries=await readHistoryEntries(env,key);
 return entries.length?entries[entries.length-1]:null;
}
async function addHistoryId(env,routeId,date,id){
 if(!routeId||!date||!id)return;
 await command(env,["SADD",historyKey(routeId,date),id]);
}

async function repairLegacyHistoryIndex(env,routeId,start,end){
 const script='local cursor="0"; local out={}; repeat local scan=redis.call("SCAN",cursor,"MATCH","zp:waybill:*","COUNT","500"); cursor=tostring(scan[1] or "0"); for _,key in ipairs(scan[2] or {}) do local raw=redis.call("GET",key); if raw then local ok,w=pcall(cjson.decode,raw); if ok and type(w)=="table" and type(w.id)=="string" and type(w.routeId)=="string" and type(w.date)=="string" and w.routeId==ARGV[1] and w.date>=ARGV[2] and w.date<=ARGV[3] and (w.stage=="PLANNED" or w.stage=="CONFIRMED") and w.historyStatus~="SUPERSEDED" then table.insert(out,w.id) end end end until cursor=="0"; return out';
 const idsRaw=await command(env,["EVAL",script,"0",routeId,start,end]);
 const ids=[...new Set((Array.isArray(idsRaw)?idsRaw:[]).map(clean).filter(Boolean))];
 if(!ids.length)return [];
 return readWaybills(env,ids);
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
 let baseStoresCache=null;
 async function withRouteData(w){
  if(!w)return w;
  w.routeName=clean(w.routeName)||routeName;
  if(!Array.isArray(w.stores)||!w.stores.length)return w;
  try{
   if(baseStoresCache===null){
    const rawBase=await get(env,"route:"+routeId+":base");
    const parsed=typeof rawBase==="string"?JSON.parse(rawBase):rawBase;
    baseStoresCache=Array.isArray(parsed?.stores)?parsed.stores:[];
   }
   const baseStores=baseStoresCache;
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
 const validEntries=entries.filter(entry=>entry.date>=start&&entry.date<=end);
 const historyBatch=await readHistoryEntriesBatch(env,validEntries);
 for(const entry of validEntries){
  const waybills=historyBatch.get(entry.date)||[];
  for(const waybill of waybills){
   if(waybill.routeId!==routeId||waybill.date!==entry.date)continue;
   const list=byDate.get(entry.date)||[];
   if(!list.some(x=>x.id===waybill.id))list.push(waybill);
   byDate.set(entry.date,list);
  }
 }
 // 兼容历史索引建立前已经存在的旧运单：只做一次按线路/日期范围的恢复扫描。
 // 恢复结果写回日期索引，后续正常历史查询不再扫描整个 waybill:*。
 const repairMarker="route:"+routeId+":history:index-repaired-v2";
 const repaired=await get(env,repairMarker).catch(()=>null);
 if(!repaired){
  const legacy=await repairLegacyHistoryIndex(env,routeId,start,end);
  for(const w of legacy){
   const list=byDate.get(w.date)||[];
   if(!list.some(x=>x.id===w.id))list.push(w);
   byDate.set(w.date,list);
  }
  const repairCommands=[];
  for(const w of legacy){if(/^\\d{4}-\\d{2}-\\d{2}$/.test(String(w.date)))repairCommands.push(["SADD",historyKey(routeId,w.date),w.id]);}
  for(let i=0;i<repairCommands.length;i+=100)await pipeline(env,repairCommands.slice(i,i+100));
  await command(env,["SET","zp:"+repairMarker,"1"]);
 }
 const dates=[];
 for(const [date,list] of byDate){
  list.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
  // 历史索引已经存在时无需重复 SADD，避免每个日期产生额外 Redis 请求。
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
}catch(e){
 const detail=String(e?.message||e||"UNKNOWN_ERROR").slice(0,180);
 return json({success:false,code:"HISTORY_READ_FAILED",error:"历史记录读取失败",detail},500)
}
}

async function deleteWaybill(env,routeId,date,waybillId){
 const key=historyKey(routeId,date);
 const type=await command(env,["TYPE",key]).catch(()=>null);
 if(String(type)==="set")await command(env,["SREM",key,waybillId]).catch(()=>{});
 else{
  const raw=await get(env,key);
  if(clean(raw)===waybillId)await command(env,["DEL",key]).catch(()=>{});
 }
 const extra=[];
 for(const indexName of ["route:"+routeId+":orders:today","route:"+routeId+":orders:latest"]){
  const indexRaw=await get(env,indexName);let indexed=null;
  try{indexed=typeof indexRaw==="string"?JSON.parse(indexRaw):indexRaw}catch{}
  if(indexed?.id===waybillId)extra.push("zp:"+indexName);
 }
 const keys=["zp:waybill:"+waybillId,...extra];
 let cursor="0";
 do{
  const s=await command(env,["SCAN",cursor,"MATCH","zp:waybill:"+waybillId+":*","COUNT","100"]);
  cursor=String(s?.[0]??"0");if(Array.isArray(s?.[1]))keys.push(...s[1]);
 }while(cursor!=="0");
 await command(env,["DEL",...[...new Set(keys)]]);
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
 const range=historyRange(todayCN());
 if(month){
  if(!/^\d{4}-\d{2}$/.test(month))return json({success:false,code:"MONTH_INVALID",error:"月份格式错误"},400);
  if(!monthInRange(month,range))return json({success:false,code:"MONTH_OUT_OF_RANGE",error:"月份不在历史查询范围内"},400);
  const entries=await readHistoryIds(env,routeId);
  let deleted=0,deletedWaybills=0;
  for(const entry of entries){
   if(!entry.date.startsWith(month))continue;
   const list=await readHistoryEntries(env,entry.key);
   for(const order of list){
    if(order.routeId!==routeId||order.date!==entry.date||order.stage!=="CONFIRMED")continue;
    await deleteWaybill(env,routeId,entry.date,order.id);
    deleted++;deletedWaybills++;
   }
  }
  return json({success:true,deleted,deletedWaybills,month});
 }
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({success:false,code:"DATE_INVALID",error:"日期格式错误"},400);
 if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
 const list=await readHistoryEntries(env,historyKey(routeId,date));
 let deleted=0;
 for(const order of list){
  if(order.routeId!==routeId||order.date!==date||order.stage!=="CONFIRMED")continue;
  await deleteWaybill(env,routeId,date,order.id);deleted++;
 }
 return json({success:true,deleted,deletedWaybills:deleted});
}
