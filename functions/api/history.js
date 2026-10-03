import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,pipeline} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {getRoute} from "./_route.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;};
const startOfYear=date=>date.slice(0,4)+"-01-01";
const endOfNextMonth=date=>{const [y,m]=date.split("-").map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10)};
const historyRange=today=>({start:startOfYear(today),end:endOfNextMonth(today)});
const validDate=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d;};
const inRange=(date,range)=>date>=range.start&&date<=range.end;
const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED";
const historyReadable=x=>validWaybill(x)&&["PLANNED","CONFIRMED"].includes(x.stage);
const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;

async function readWaybills(env,ids){
 const cleanIds=[...new Set((ids||[]).map(clean).filter(Boolean))];if(!cleanIds.length)return [];
 try{
  const rawList=await command(env,["MGET",...cleanIds.map(id=>"zp:waybill:"+id)]);
  return (Array.isArray(rawList)?rawList:[]).map(raw=>{if(!raw)return null;try{const x=typeof raw==="string"?JSON.parse(raw):raw;return historyReadable(x)?x:null}catch{return null}}).filter(Boolean);
 }catch{
  const out=[];
  for(const id of cleanIds){const raw=await get(env,"waybill:"+id);try{const x=typeof raw==="string"?JSON.parse(raw):raw;if(historyReadable(x))out.push(x)}catch{}}
  return out;
 }
}

async function readIndexMembers(env,routeId,date){
 const raw=await command(env,["SMEMBERS",waybillIndexKey(routeId,date)]).catch(()=>[]);
 return Array.isArray(raw)?raw.map(clean).filter(Boolean):[];
}

async function readDateWaybills(env,routeId,date){
 const ids=await readIndexMembers(env,routeId,date);
 const waybills=await readWaybills(env,ids);
 return waybills.filter(w=>w.routeId===routeId&&w.date===date).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}

async function readDateWaybillsBatch(env,entries){
 const out=new Map();const valid=entries.filter(Boolean);
 for(let i=0;i<valid.length;i+=50){
  const chunk=valid.slice(i,i+50);
  const results=await pipeline(env,chunk.map(x=>["SMEMBERS",waybillIndexKey(x.routeId,x.date)]));
  const allIds=[];const idsByDate=new Map();
  for(let j=0;j<chunk.length;j++){const ids=Array.isArray(results?.[j])?results[j].map(clean).filter(Boolean):[];idsByDate.set(chunk[j].date,ids);allIds.push(...ids)}
  const waybills=await readWaybills(env,allIds);
  const byId=new Map(waybills.map(w=>[w.id,w]));
  for(const entry of chunk){
   const ids=idsByDate.get(entry.date)||[];
   const list=ids.map(id=>byId.get(id)).filter(w=>w&&w.routeId===entry.routeId&&w.date===entry.date).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
   out.set(entry.date,list);
  }
 }
 return out;
}

async function readDates(env,routeId,range){
 const dates=[];let cursor="0";const prefix="zp:route:"+routeId+":waybills:";
 do{
  const r=await command(env,["SCAN",cursor,"MATCH",prefix+"*","COUNT","100"]);
  cursor=String(r?.[0]??"0");
  for(const key of (r?.[1]||[])){const text=String(key);if(!text.startsWith(prefix))continue;const date=text.slice(prefix.length);if(validDate(date)&&inRange(date,range))dates.push({routeId,date})}
 }while(cursor!=="0");
 return [...new Map(dates.map(x=>[x.date,x])).values()].sort((a,b)=>b.date.localeCompare(a.date));
}

async function enrichFactory(env,routeId){
 const route=await getRoute(env,routeId);const routeName=clean(route?.name)||"临时";let baseStoresCache=null;
 return async w=>{
  if(!w)return w;
  const out={...w,routeName:clean(w.routeName)||routeName};
  if(!Array.isArray(out.stores)||!out.stores.length)return out;
  try{
   if(baseStoresCache===null){const raw=await get(env,"route:"+routeId+":base");const parsed=typeof raw==="string"?JSON.parse(raw):raw;baseStoresCache=Array.isArray(parsed?.stores)?parsed.stores:[]}
   const baseStores=baseStoresCache,byId=new Map(baseStores.map(s=>[clean(s?.storeId),s]).filter(x=>x[0]));
   const baseKey=v=>clean(v).normalize("NFKC").replace(/\s+/g,"").replace(/[，。；;：:、（）()【】\[\]{}<>《》“”"'‘’]/g,"").toLowerCase(),byName=new Map();
   for(const bs of baseStores)for(const field of [bs?.name,bs?.originalName,...(Array.isArray(bs?.aliases)?bs.aliases:[])]){const key=baseKey(field);if(key&&!byName.has(key))byName.set(key,bs)}
   out.stores=out.stores.map(s=>{const baseStore=byId.get(clean(s?.storeId))||byName.get(baseKey(s?.name||s?.rawName));if(!baseStore)return s;const navigation=clean(baseStore.navigation)||clean(s?.navigation),note=clean(baseStore.note||baseStore.remark)||clean(s?.note||s?.remark);return navigation||note?{...s,...(navigation?{navigation}:{}),...(note?{note}:{})}:s});
  }catch{}
  return out;
 };
}

export async function onRequestGet({request,env}){
 try{
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
  if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
  const url=new URL(request.url),routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId),date=clean(url.searchParams.get("date"));
  if(!routeId)return json({success:true,routeId:null,months:[],history:[]});
  const currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);if(routeId!==currentRoute)return json({success:false,error:"无权查看该线路历史"},403);
  const range=historyRange(todayCN()),enrich=await enrichFactory(env,routeId);
  if(date){
   if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期无效"},400);
   if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
   const waybills=await readDateWaybills(env,routeId,date),enriched=[];for(const w of waybills)enriched.push(await enrich(w));
   return json({success:true,routeId,date,waybills:enriched,count:enriched.length,waybill:enriched[enriched.length-1]||null});
  }
  const entries=await readDates(env,routeId,range),batch=await readDateWaybillsBatch(env,entries),dates=[];
  for(const entry of entries){
   const list=batch.get(entry.date)||[];if(!list.length)continue;
   const storeCount=list.reduce((sum,w)=>sum+(Number(w.summary?.total)||w.stores.length),0),totalWeight=list.reduce((sum,w)=>sum+(Number(w.totalWeight)||0),0);
   dates.push({date:entry.date,count:list.length,waybillId:list[list.length-1]?.id||null,storeCount,totalWeight});
  }
  const monthMap=new Map();
  for(const item of dates){const month=item.date.slice(0,7),current=monthMap.get(month)||{month,days:0,waybills:0,totalStores:0,totalWeight:0};current.days++;current.waybills+=item.count;current.totalStores+=item.storeCount;current.totalWeight+=item.totalWeight;monthMap.set(month,current)}
  return json({success:true,routeId,range,months:[...monthMap.values()],history:dates});
 }catch(e){return json({success:false,code:"HISTORY_READ_FAILED",error:"统一运单查询失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,180)},500)}
}

async function deleteWaybill(env,routeId,date,waybillId){
 await command(env,["SREM",waybillIndexKey(routeId,date),waybillId]).catch(()=>{});
 await command(env,["DEL","zp:waybill:"+waybillId]).catch(()=>{});
 let cursor="0";const prefix="zp:waybill:"+waybillId+":";
 do{const r=await command(env,["SCAN",cursor,"MATCH",prefix+"*","COUNT","100"]);cursor=String(r?.[0]??"0");const keys=Array.isArray(r?.[1])?r[1]:[];if(keys.length)await command(env,["DEL",...keys]).catch(()=>{})}while(cursor!=="0");
}

export async function onRequestDelete({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权删除历史数据"},403);
 const url=new URL(request.url),routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId),date=clean(url.searchParams.get("date")),month=clean(url.searchParams.get("month")),currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);
 if(!routeId||routeId!==currentRoute)return json({success:false,error:"无权操作该线路历史"},403);
 const range=historyRange(todayCN());
 if(month){
  if(!/^\d{4}-\d{2}$/.test(month))return json({success:false,code:"MONTH_INVALID",error:"月份格式错误"},400);
  if(!monthInRange(month,range))return json({success:false,code:"MONTH_OUT_OF_RANGE",error:"月份不在历史查询范围内"},400);
  const entries=await readDates(env,routeId,range);let deleted=0;
  // readDateWaybills 已按 historyReadable 过滤（PLANNED / CONFIRMED），
  // 这里不再按 stage 二次拦截：用户看到的历史运单都应该删得掉。
  // 旧逻辑只删 CONFIRMED，导致「待确认」运单点了删除却报「仅可删除已确认运单」，
  // 或整日删除后记录仍在 —— 与实际预期不符。
  for(const entry of entries){if(!entry.date.startsWith(month))continue;for(const order of await readDateWaybills(env,routeId,entry.date)){await deleteWaybill(env,routeId,entry.date,order.id);deleted++}}
  return json({success:true,deleted,deletedWaybills:deleted,month});
 }
 if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期格式错误"},400);
 if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
 const waybillId=clean(url.searchParams.get("waybillId")||url.searchParams.get("id"));
 if(waybillId){
  const orders=await readDateWaybills(env,routeId,date);
  const target=orders.find(order=>order.id===waybillId);
  if(!target)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在或已删除"},404);
  await deleteWaybill(env,routeId,date,target.id);
  return json({success:true,deleted:1,deletedWaybills:1,waybillId});
 }
 let deleted=0;for(const order of await readDateWaybills(env,routeId,date)){await deleteWaybill(env,routeId,date,order.id);deleted++}
 return json({success:true,deleted,deletedWaybills:deleted});
}
