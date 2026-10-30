import {guard} from "./_safe.js";
import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,pipeline,createD1SessionEnv} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {canReadWaybill,canWriteWaybill} from "./_waybill-acl.js";
import {getRoute} from "./_route.js";
import {dailyWaybillKey} from "./_waybill-identity.js";
import {recomputeDayMeta,dayMetaKey,parseMeta} from "./waybills/_waybill-meta.js";
import {Budget,scanKeysBudgeted,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_BUDGET_EXCEEDED} from "./_redis-budget.js";
import {clean,todayCN,historyRange,validDate,inRange,monthInRange} from "./_history-range.js";
import {readDateWaybills,readDates,readDateWaybillsBatch,readDayAggregates,enrichFactory} from "./_history-read.js";
import {deleteWaybill} from "./_history-delete.js";

/* ================================================================
 * 入口（P1-1g 拆分）：实现已按职责拆到三个兄弟模块，本文件只保留
 * GET/DELETE 路由处理与 re-export，公开面与拆分前逐一对应。
 * ================================================================ */

export {clean,historyRange,validDate,inRange,monthInRange} from "./_history-range.js";
export {readWaybills,readDateWaybillsBatch,readDayAggregates,readDates,enrichFactory} from "./_history-read.js";

async function historyGet({request,env}){
 const timing={};let phaseStart=performance.now();
 const mark=(name,started)=>{timing[name]=Math.max(0,Number((performance.now()-started).toFixed(1)));};
 const respond=(body,status=200)=>{const responseStart=performance.now();const response=json(body,status);mark("history-response-build",responseStart);const metrics=Object.entries(timing).map(([name,dur])=>name+";dur="+dur).join(", ");if(metrics)response.headers.set("Server-Timing",metrics);return response;};
 try{
  const user=await currentUser(request,env);mark("history-auth",phaseStart);if(!user)return respond({success:false,error:"未登录"},401);
  if(user.role==="admin"||!canUseRoute(user))return respond({success:false,error:"无权查看配送业务"},403);
  const url=new URL(request.url),routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId),date=clean(url.searchParams.get("date"));
  if(!routeId)return respond({success:true,routeId:null,months:[],history:[]});
  const currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);if(routeId!==currentRoute)return respond({success:false,error:"无权查看该线路历史"},403);
  const monthsParam=clean(url.searchParams.get("months"));
  // 前端可经 ?months= 放宽查询窗口（仅 GET 生效，受 1–13 钳制）；默认沿用 env WAYBILL_HISTORY_MONTHS。
  // DELETE 路径不使用此参数，维持 env 默认窗口，避免客户端扩大可删除范围。
  const searchQuery=clean(url.searchParams.get("q")).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const monthsN=monthsParam?Math.max(1,Math.min(13,Math.floor(Number(monthsParam)||3))):(searchQuery?3:env?.WAYBILL_HISTORY_MONTHS);
  // 性能：enrichFactory 仅在 date 详情分支用到（默认概览/搜索分支都不用），
  // 原先无条件在公共路径算一次 = 每次概览白白多 1 次 Redis 往返（~190ms）。
  // 下面各分支按需再取，概览/搜索路径直接省掉这一步。
  const range=historyRange(todayCN(),monthsN);
  if(date){
   if(!validDate(date))return respond({success:false,code:"DATE_INVALID",error:"日期无效"},400);
   if(!inRange(date,range))return respond({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
   // 日期详情分支的 D1 读取按顺序执行，可安全使用请求级 Session；
   // 不复用共享 env 上可能存在的 D1Backend 缓存。
   const historyEnv=createD1SessionEnv(env);
   const budget=new Budget();
   let waybills;phaseStart=performance.now();
   try{waybills=await readDateWaybills(historyEnv,user,routeId,date,budget);mark("history-detail-read",phaseStart)}catch(e){
    if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return respond({success:false,code:"PARTIAL_FAILURE",error:"该日期运单查询资源不足，请稍后重试",date,budgetUsed:budget.used,budgetMax:budget.max},503);
    if(e?.code==="WAYBILL_HISTORY_INDEX_READ_FAILED")return respond({success:false,code:"WAYBILL_HISTORY_INDEX_READ_FAILED",error:"历史运单索引读取失败，请稍后重试",date},503);
    if(e?.code==="WAYBILL_HISTORY_STALE_INDEX")return respond({success:false,code:"WAYBILL_HISTORY_STALE_INDEX",error:"历史运单索引与运单数据不一致，请稍后重试",date,missingCount:e.missingCount},503);
    throw e;
   }
   phaseStart=performance.now();const enrich=await enrichFactory(historyEnv,routeId);mark("history-route",phaseStart);
   phaseStart=performance.now();const enriched=[];for(const w of waybills)enriched.push(await enrich(w));mark("history-detail-enrich",phaseStart);
   return respond({success:true,routeId,date,waybills:enriched,count:enriched.length,waybillIds:enriched.map(w=>w.id),hasMultiple:enriched.length>1});
  }
  if(searchQuery){
   if(searchQuery.length>80)return respond({success:false,code:"SEARCH_QUERY_TOO_LONG",error:"搜索内容最多 80 个字符"},400);
   // 搜索分支的索引扫描与分批读取为串行链路，可安全共享请求级 D1 Session。
   const historyEnv=createD1SessionEnv(env);
   const budget=new Budget();
   let entries,batch;
   try{
    phaseStart=performance.now();entries=await readDates(historyEnv,routeId,range,budget);mark("history-search-index",phaseStart);
    phaseStart=performance.now();batch=await readDateWaybillsBatch(historyEnv,user,entries,budget);mark("history-search-read",phaseStart);
   }catch(e){
    if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return respond({success:false,code:"PARTIAL_FAILURE",error:"当前历史范围较大，请缩小月份范围后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
    throw e;
   }
   const normalize=v=>String(v??"").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");
   const needle=normalize(searchQuery);
   if(!needle)return respond({success:false,code:"SEARCH_QUERY_INVALID",error:"请输入有效的搜索关键词"},400);
   const results=[];
   for(const entry of entries){
    for(const w of (batch.get(entry.date)||[])){
     const stores=Array.isArray(w.stores)?w.stores:[];
     const fields=[w.id,w.date,w.routeName,w.vehicle,w.vehicleNo,w.plateNumber,w.licensePlate,w.driverName,w.customerName,w.contactName,w.phone,w.mobile,w.address,w.rawText,w.ocrText];
     for(const store of stores){
      if(!store||typeof store!=="object")continue;
      fields.push(store.name,store.rawName,store.originalName,store.storeName,store.storeId,store.phone,store.mobile,store.contact,store.contactName,store.address,store.navigation,store.note,store.remark);
     }
     if(!fields.some(v=>normalize(v).includes(needle)))continue;
     results.push({id:w.id,date:w.date,routeName:w.routeName||"",vehicle:w.vehicle||w.vehicleNo||w.licensePlate||"",storeCount:Number(w.summary?.finalCount)||Number(w.summary?.total)||stores.length,totalWeight:Number(w.totalWeight)||0,storeNames:stores.map(s=>clean(s?.name||s?.rawName)).filter(Boolean).slice(0,5)});
     if(results.length>=100)break;
    }
    if(results.length>=100)break;
   }
   return respond({success:true,routeId,query:searchQuery,range,results,count:results.length,limited:results.length>=100});
  }
  // P1-06 收口：readDates / readDateWaybillsBatch 共享同一 Budget，
 // 预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED → 转结构化 503「请缩小查询范围」，
 // 而不是让 worker 在无预算的裸循环里撞上平台硬限（Error 1101）。
 const budget=new Budget();
 let entries;
 try{
  phaseStart=performance.now();entries=await readDates(env,routeId,range,budget);mark("history-index",phaseStart);
 }catch(e){
  if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return respond({success:false,code:"PARTIAL_FAILURE",error:"历史查询范围过大，请缩小查询月份后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
  throw e;
 }
 // 方案C rollup：概览只依赖「每日汇总键」(O(天数) 小键) + 索引 SMEMBERS(仅 id，不含运单完整体)，
 // 稳态成本与单量彻底脱钩。legacy 数据缺 meta 时批量读体回填（同旧 readDateWaybillsBatch 效率），
 // 受同一 budget 约束；超限即转结构化 503「请缩小范围」，绝不谎报半截数据。
 let agg;
 try{
  phaseStart=performance.now();agg=await readDayAggregates(env,{user,routeId,entries,budget});mark("history-aggregate",phaseStart);
 }catch(e){
  if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return respond({success:false,code:"PARTIAL_FAILURE",error:"当前历史范围较大，请缩小月份范围后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
  throw e;
 }
 const dates=agg.dates;
 const monthMap=new Map();
 for(const item of dates){const month=item.date.slice(0,7),current=monthMap.get(month)||{month,days:0,waybills:0,totalStores:0,totalWeight:0};current.days++;current.waybills+=item.count;current.totalStores+=item.storeCount;current.totalWeight+=item.totalWeight;monthMap.set(month,current)}
 return respond({success:true,routeId,range,months:[...monthMap.values()],history:dates,degraded:agg.degraded||undefined});
 }catch(e){return respond({success:false,code:"HISTORY_READ_FAILED",error:"统一运单查询失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,180)},500)}
}

async function historyDelete({request,env}){
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

// 统一记录历史接口服务端耗时与请求 ID；保持原有业务处理、响应体和状态码。
export const onRequestGet = guard(historyGet, "HISTORY_READ_FAILED");
export const onRequestDelete = guard(historyDelete, "HISTORY_DELETE_FAILED");
