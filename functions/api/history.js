import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,pipeline} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {canReadWaybill,canWriteWaybill} from "./_waybill-acl.js";
import {getRoute} from "./_route.js";
import {dailyWaybillKey} from "./_waybill-identity.js";
import {Budget,scanKeysBudgeted,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_BUDGET_EXCEEDED} from "./_redis-budget.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;};
const endOfNextMonth=date=>{const [y,m]=date.split("-").map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10)};
// 历史查询/保存窗口：默认 13 个月滚动窗口，止于次月末。可经 WAYBILL_HISTORY_MONTHS 调整（仅影响可查询范围，不启用任何破坏性自动清理）。
const historyRange=(today,months)=>{const n=Math.max(1,Math.min(120,Math.floor(Number(months)||13)));const [y,m]=today.split("-").map(Number);let startIdx=(y*12+(m-1))-(n-2);const sy=Math.floor(startIdx/12),sm=startIdx%12+1;return {start:`${sy}-${String(sm).padStart(2,"0")}-01`,end:endOfNextMonth(today),months:n};};
const validDate=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d;};
const inRange=(date,range)=>date>=range.start&&date<=range.end;
const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED";
const historyReadable=x=>validWaybill(x)&&["PLANNED","CONFIRMED"].includes(x.stage);
const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;

async function readWaybills(env,ids,budget=null){
 const cleanIds=[...new Set((ids||[]).map(clean).filter(Boolean))];if(!cleanIds.length)return [];
 const decode=raw=>{if(!raw)return null;try{const x=typeof raw==="string"?JSON.parse(raw):raw;return historyReadable(x)?x:null}catch{return null}};
 try{
  if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-waybills");
  const rawList=await command(env,["MGET",...cleanIds.map(id=>"zp:waybill:"+id)]);
  return (Array.isArray(rawList)?rawList:[]).map(decode).filter(Boolean);
 }catch(error){
  // MGET 失败（如单次 URL 过长被拒）时降级为**分批** MGET，而非无预算的逐条 GET 循环
  if(budget){
   if(error?.code===SUBREQUEST_BUDGET_EXCEEDED)throw error;
   const {map,complete}=await mgetBatchMap(env,cleanIds.map(id=>"zp:waybill:"+id),budget,{batch:100});
   if(!complete)throwBudgetExceeded(budget.max,"history-read-waybills-fallback");
   const out=[];for(const id of cleanIds){const w=decode(map.get("zp:waybill:"+id));if(w)out.push(w)}
   return out;
  }
  const out=[];
  for(const id of cleanIds){const raw=await get(env,"waybill:"+id);const w=decode(raw);if(w)out.push(w)}
  return out;
 }
}

async function readIndexMembers(env,routeId,date,budget=null){
 if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-index");
 const raw=await command(env,["SMEMBERS",waybillIndexKey(routeId,date)]).catch(()=>[]);
 return Array.isArray(raw)?raw.map(clean).filter(Boolean):[];
}

async function readDateWaybills(env,user,routeId,date,budget=null){
 const ids=await readIndexMembers(env,routeId,date,budget);
 const waybills=await readWaybills(env,ids,budget);
 return waybills.filter(w=>w.routeId===routeId&&w.date===date&&canReadWaybill(user,w,env)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}

async function readDateWaybillsBatch(env,user,entries,budget=null){
 const out=new Map();const valid=entries.filter(Boolean);
 // P1-06 收口：原实现调 readWaybills 时**不传 budget**，一旦 MGET 失败就静默降级为
 // 「逐条 GET waybill」的 O(N) 循环且无任何预算约束 → 大范围历史查询必然越过平台硬限。
 // 现把 budget 一路透传：预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED，
 // 由调用方转成结构化 503「请缩小范围」，而不是把 worker 拖到 Error 1101。
 for(let i=0;i<valid.length;i+=50){
  const chunk=valid.slice(i,i+50);
  if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-dates-batch");
  const results=await pipeline(env,chunk.map(x=>["SMEMBERS",waybillIndexKey(x.routeId,x.date)]));
  const allIds=[];const idsByDate=new Map();
  for(let j=0;j<chunk.length;j++){const ids=Array.isArray(results?.[j])?results[j].map(clean).filter(Boolean):[];idsByDate.set(chunk[j].date,ids);allIds.push(...ids)}
  const waybills=await readWaybills(env,allIds,budget);
  const byId=new Map(waybills.map(w=>[w.id,w]));
  for(const entry of chunk){
   const ids=idsByDate.get(entry.date)||[];
   const list=ids.map(id=>byId.get(id)).filter(w=>w&&w.routeId===entry.routeId&&w.date===entry.date&&canReadWaybill(user,w,env)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
   out.set(entry.date,list);
  }
 }
 return out;
}

async function readDates(env,routeId,range,budget=null){
 const dates=[];const prefix="zp:route:"+routeId+":waybills:";
 if(budget){
  const scanned=await scanKeysBudgeted(env,prefix+"*",budget,{count:500,cap:5000});
  for(const key of scanned.keys){const text=String(key);if(!text.startsWith(prefix))continue;const date=text.slice(prefix.length);if(validDate(date)&&inRange(date,range))dates.push({routeId,date})}
  if(!scanned.complete)throwBudgetExceeded(budget.max,"history-read-dates");
 }else{
  let cursor="0";
  do{
   const r=await command(env,["SCAN",cursor,"MATCH",prefix+"*","COUNT","100"]);
   cursor=String(r?.[0]??"0");
   for(const key of (r?.[1]||[])){const text=String(key);if(!text.startsWith(prefix))continue;const date=text.slice(prefix.length);if(validDate(date)&&inRange(date,range))dates.push({routeId,date})}
  }while(cursor!=="0");
 }
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
  // 响应瘦身：sourceLine 是处理阶段的调试字段（整条原始线路文本，逐门店重复），
  // 前端（home/order_detail/history）均不消费；25 家门店时它会把单日响应撑大数十 KB，
  // 在弱网（VPN/移动网络）下直接拖垮首页 8s 超时 → 今日配送「暂无运单」。
  // 仅剥离响应副本，不改动 KV 中的存储数据。
  if(Array.isArray(out.stores))out.stores=out.stores.map(s=>{if(!s||typeof s!=="object")return s;const c={...s};delete c.sourceLine;return c});
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
  const monthsParam=clean(url.searchParams.get("months"));
  // 前端可经 ?months= 放宽查询窗口（仅 GET 生效，受 1–120 钳制）；默认沿用 env WAYBILL_HISTORY_MONTHS。
  // DELETE 路径不使用此参数，维持 env 默认窗口，避免客户端扩大可删除范围。
  const monthsN=monthsParam?Math.max(1,Math.min(120,Math.floor(Number(monthsParam)||13))):env?.WAYBILL_HISTORY_MONTHS;
  const range=historyRange(todayCN(),monthsN),enrich=await enrichFactory(env,routeId);
  if(date){
   if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期无效"},400);
   if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
   const budget=new Budget();
   const waybills=await readDateWaybills(env,user,routeId,date,budget),enriched=[];for(const w of waybills)enriched.push(await enrich(w));
   return json({success:true,routeId,date,waybills:enriched,count:enriched.length,waybillIds:enriched.map(w=>w.id),hasMultiple:enriched.length>1});
  }
  // P1-06 收口：readDates / readDateWaybillsBatch 共享同一 Budget，
 // 预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED → 转结构化 503「请缩小查询范围」，
 // 而不是让 worker 在无预算的裸循环里撞上平台硬限（Error 1101）。
 const budget=new Budget();
 let entries,batch;
 try{
  entries=await readDates(env,routeId,range,budget);
  batch=await readDateWaybillsBatch(env,user,entries,budget);
 }catch(e){
  if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"历史查询范围过大，请缩小查询月份后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
  throw e;
 }
 const dates=[];
  for(const entry of entries){
   const list=batch.get(entry.date)||[];if(!list.length)continue;
   const storeCount=list.reduce((sum,w)=>sum+(Number(w.summary?.finalCount)||Number(w.summary?.total)||w.stores.length),0),totalWeight=list.reduce((sum,w)=>sum+(Number(w.totalWeight)||0),0);
   dates.push({date:entry.date,count:list.length,waybillIds:list.map(w=>w.id),hasMultiple:list.length>1,storeCount,totalWeight});
  }
  const monthMap=new Map();
  for(const item of dates){const month=item.date.slice(0,7),current=monthMap.get(month)||{month,days:0,waybills:0,totalStores:0,totalWeight:0};current.days++;current.waybills+=item.count;current.totalStores+=item.storeCount;current.totalWeight+=item.totalWeight;monthMap.set(month,current)}
  return json({success:true,routeId,range,months:[...monthMap.values()],history:dates});
 }catch(e){return json({success:false,code:"HISTORY_READ_FAILED",error:"统一运单查询失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,180)},500)}
}

async function deleteWaybill(env,routeId,date,waybillId,budget){
 const errors=[];let mainOk=false,indexOk=false,childrenOk=true,refOk=true;
 let record=null;
 try{if(!budget.take(1))throwBudgetExceeded(budget.max,"history-delete-read");const raw=await command(env,["GET","zp:waybill:"+waybillId]);if(raw)record=typeof raw==="string"?JSON.parse(raw):raw}catch(e){errors.push(e)}
 const prefix="zp:waybill:"+waybillId+":";
 let childKeys=[];
 try{
  const scanned=await scanKeysBudgeted(env,prefix+"*",budget,{count:500,cap:5000});
  if(!scanned.complete){
   return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:true,errors:[Object.assign(new Error("历史删除子键扫描未完成"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
  }
  childKeys=scanned.keys;
 }catch(e){
  return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:e?.code===SUBREQUEST_BUDGET_EXCEEDED,errors:[e]};
 }
 const refKeys=[];
 if(record?.businessFingerprint)refKeys.push("zp:waybill:fingerprint:"+record.businessFingerprint);
 if(record){try{const sig=await dailyWaybillKey(record);refKeys.push("zp:waybill:dedupe:"+sig)}catch{}}
 // P1 生命周期收口：
 // 1) 先清理可独立重试的子键；
 // 2) 再用单次 EVAL 原子删除「主记录 + 日期索引 + 反向引用」；
 // 3) EVAL 失败时主记录和索引都保留，下一次 DELETE 仍可找到原单继续清理。
 // 这样不会出现“主记录已 DEL，但日期索引/指纹清理失败后无法再次定位原单”的不可恢复窗口。
 // EVAL 内再次校验反向引用仍指向本运单，避免删除已被复用的 fingerprint/dedupe 键。
 const required=2+(childKeys.length?1:0);
 if(!budget.canTake(required)){
  return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:true,errors:[Object.assign(new Error("历史删除资源预算不足"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
 }
 if(childKeys.length){
  try{budget.take(1);await command(env,["DEL",...childKeys])}catch(e){errors.push(e);childrenOk=false}
  if(!childrenOk)return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:false,errors};
 }
 const indexKey=waybillIndexKey(routeId,date);
 const mainKey="zp:waybill:"+waybillId;
 const lua=`
local mainKey=KEYS[1]
local indexKey=KEYS[2]
local waybillId=ARGV[1]
if redis.call("EXISTS",mainKey)==0 then
  return {0,0,0}
end
local removedRefs=0
for i=3,#KEYS do
  local key=KEYS[i]
  local v=redis.call("GET",key)
  if tostring(v or "")==tostring(waybillId) then
    redis.call("DEL",key)
    removedRefs=removedRefs+1
  end
end
local mainRemoved=redis.call("DEL",mainKey)
local indexRemoved=redis.call("SREM",indexKey,waybillId)
return {mainRemoved,indexRemoved,removedRefs}
`;
 const keys=[mainKey,indexKey,...refKeys];
 try{
  budget.take(1);
  const result=await command(env,["EVAL",lua,String(keys.length),...keys,waybillId]);
  const values=Array.isArray(result)?result.map(Number):[];
  if(values[0]===0){
   mainOk=true;indexOk=true;
   // 主记录已不存在时，日期索引仍可能是历史残留；单独清掉不会影响任何新运单。
   if(!budget.canTake(1))return {mainOk,indexOk,childrenOk,refOk,budgetExceeded:true,errors:[Object.assign(new Error("历史删除尾部索引清理预算不足"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
   budget.take(1);await command(env,["SREM",indexKey,waybillId]);
  }else{
   mainOk=values[0]>0;
   indexOk=values[1]>0||values[1]===0;
   const expectedRefs=refKeys.length;
   const removedRefs=Number(values[2]||0);
   refOk=removedRefs===expectedRefs;
  }
 }catch(e){
  errors.push(e);
  return {mainOk:false,indexOk:true,childrenOk,refOk:true,budgetExceeded:e?.code===SUBREQUEST_BUDGET_EXCEEDED,errors};
 }
 return {mainOk,indexOk,childrenOk,refOk,budgetExceeded:false,errors};
}
export async function onRequestDelete({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权删除历史数据"},403);
 const url=new URL(request.url),routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId),date=clean(url.searchParams.get("date")),month=clean(url.searchParams.get("month")),currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);
 if(!routeId||routeId!==currentRoute)return json({success:false,error:"无权操作该线路历史"},403);
  const range=historyRange(todayCN(),env?.WAYBILL_HISTORY_MONTHS);
  const summarize=results=>{let deleted=0,mainFailed=false,partial=false,budgetExceeded=false;for(const r of results){if(r.mainOk)deleted++;else mainFailed=true;if(!r.indexOk||!r.childrenOk||!r.refOk)partial=true;if(r.budgetExceeded)budgetExceeded=true}return {deleted,mainFailed,partial,budgetExceeded}};
  if(month){
   if(!/^\d{4}-\d{2}$/.test(month))return json({success:false,code:"MONTH_INVALID",error:"月份格式错误"},400);
   if(!monthInRange(month,range))return json({success:false,code:"MONTH_OUT_OF_RANGE",error:"月份不在历史查询范围内"},400);
   const budget=new Budget();let entries;try{entries=await readDates(env,routeId,range,budget)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"删除范围读取已达到资源预算，请缩小范围或稍后重试",deleted:0,month,budgetUsed:budget.used,budgetMax:budget.max},503);throw e}const results=[];let total=0;
   for(const entry of entries){if(!entry.date.startsWith(month))continue;let list;try{list=await readDateWaybills(env,user,routeId,entry.date,budget)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请继续重试完成剩余运单",deleted:results.filter(x=>x.mainOk).length,month,partial:true,budgetUsed:budget.used,budgetMax:budget.max},503);throw e}total+=list.length;for(const order of list.filter(w=>canWriteWaybill(user,w,env))){try{const r=await deleteWaybill(env,routeId,entry.date,order.id,budget);if(r.budgetExceeded)return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请继续重试完成剩余运单",deleted:results.filter(x=>x.mainOk).length,month,partial:true,budgetUsed:budget.used,budgetMax:budget.max},503);results.push(r)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请继续重试完成剩余运单",deleted:results.filter(x=>x.mainOk).length,month,partial:true,budgetUsed:budget.used,budgetMax:budget.max},503);throw e}}}
   const s=summarize(results);const skipped=total-results.length;
   if(s.mainFailed)return json({success:false,code:"WAYBILL_DELETE_FAILED",error:"部分运单主记录删除失败,请重试",deleted:s.deleted,skipped,total,month});
   return json({success:true,code:skipped>0?"PARTIAL_DELETE":(s.partial?"PARTIAL_FAILURE":undefined),message:skipped>0?`已删除 ${s.deleted} 单，另有 ${skipped} 单因无权限未删除`:(s.partial?"部分索引或子键清理未完成,建议稍后执行修复":undefined),deleted:s.deleted,skipped,total,deletedWaybills:s.deleted,month});
  }
 if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期格式错误"},400);
 if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
 const waybillId=clean(url.searchParams.get("waybillId")||url.searchParams.get("id"));
 if(waybillId){
  const budget=new Budget();
  const orders=await readDateWaybills(env,user,routeId,date,budget);
  const target=orders.find(order=>order.id===waybillId);
  if(!target)return json({success:false,code:"WAYBILL_NOT_FOUND",error:"运单不存在或已删除"},404);
  if(!canWriteWaybill(user,target,env))return json({success:false,code:"WAYBILL_FORBIDDEN",error:"无权删除该运单"},403);
  const deleteBudget=new Budget();let r;try{r=await deleteWaybill(env,routeId,date,target.id,deleteBudget);if(r.budgetExceeded)return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请稍后重试",deleted:0,waybillId,budgetUsed:deleteBudget.used,budgetMax:deleteBudget.max},503)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请稍后重试",deleted:0,waybillId,budgetUsed:budget.used,budgetMax:budget.max},503);throw e}
  if(!r.mainOk)return json({success:false,code:"WAYBILL_DELETE_FAILED",error:"运单主记录删除失败,请重试",deleted:0,waybillId});
  return json({success:true,code:r.indexOk&&r.childrenOk&&r.refOk?undefined:"PARTIAL_FAILURE",message:r.indexOk&&r.childrenOk&&r.refOk?undefined:"部分索引或子键清理未完成,建议稍后执行修复",deleted:1,deletedWaybills:1,waybillId});
 }
 const budget=new Budget();let readable;try{readable=await readDateWaybills(env,user,routeId,date,budget)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"删除范围读取已达到资源预算，请稍后重试",deleted:0,date,budgetUsed:budget.used,budgetMax:budget.max},503);throw e}const results=[];
 for(const order of readable.filter(w=>canWriteWaybill(user,w,env))){try{const r=await deleteWaybill(env,routeId,date,order.id,budget);if(r.budgetExceeded){const s=summarize(results);return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请继续重试完成剩余运单",deleted:s.deleted,skipped:readable.length-results.length,date,budgetUsed:budget.used,budgetMax:budget.max},503)}results.push(r)}catch(e){if(e?.code===SUBREQUEST_BUDGET_EXCEEDED){const s=summarize(results);return json({success:false,code:"PARTIAL_FAILURE",error:"删除已达到单次资源预算，请继续重试完成剩余运单",deleted:s.deleted,skipped:readable.length-results.length,date,budgetUsed:budget.used,budgetMax:budget.max},503)}throw e}}
 const s=summarize(results);const skipped=readable.length-results.length;
 if(s.mainFailed)return json({success:false,code:"WAYBILL_DELETE_FAILED",error:"运单主记录删除失败,请重试",deleted:s.deleted,skipped,total:readable.length,date});
 return json({success:true,code:skipped>0?"PARTIAL_DELETE":(s.partial?"PARTIAL_FAILURE":undefined),message:skipped>0?`已删除 ${s.deleted} 单，另有 ${skipped} 单因无权限未删除`:(s.partial?"部分索引或子键清理未完成,建议稍后执行修复":undefined),deleted:s.deleted,skipped,total:readable.length,deletedWaybills:s.deleted,date});
}
