/**
 * 智配One · 历史查询 —— 读取族
 * ----------------------------------------------------------
 * 本文件由 history.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 依赖：_history-range.js（范围工具）。
 * 原公开面经入口 re-export 保持不变：
 *   readWaybills / readDateWaybillsBatch / readDayAggregates / readDates / enrichFactory
 * 纪律：所有读取路径共享 Budget，超限抛 SUBREQUEST_BUDGET_EXCEEDED（P1-06 收口，
 *   不得回退为无预算裸循环）。
 */

import {get,command,pipeline,createD1SessionEnv} from "./_redis.js";
import {canReadWaybill} from "./_waybill-acl.js";
import {getRoute} from "./_route.js";
import {dayMetaKey,parseMeta} from "./waybills/_waybill-meta.js";
import {Budget,scanKeysBudgeted,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_BUDGET_EXCEEDED} from "./_redis-budget.js";
import {clean,historyReadable,waybillIndexKey,validDate,inRange} from "./_history-range.js";

export async function readWaybills(env,ids,budget=null,strictIndex=false){
 const cleanIds=[...new Set((ids||[]).map(clean).filter(Boolean))];if(!cleanIds.length)return [];
 const decode=raw=>{if(!raw)return null;try{const x=typeof raw==="string"?JSON.parse(raw):raw;return historyReadable(x)?x:null}catch{return null}};
 try{
  if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-waybills");
  const rawList=await command(env,["MGET",...cleanIds.map(id=>"zp:waybill:"+id)]);
  if(strictIndex && Array.isArray(rawList)){
   const missing=cleanIds.filter((id,i)=>!rawList[i]);
   if(missing.length)throw Object.assign(new Error("历史日期索引包含不存在的运单："+missing.slice(0,5).join(",")),{code:"WAYBILL_HISTORY_STALE_INDEX",missingCount:missing.length});
  }
  return (Array.isArray(rawList)?rawList:[]).map(decode).filter(Boolean);
 }catch(error){
  // 数据一致性错误不能被 MGET 降级吞掉；否则“索引有ID、主运单不存在”
  // 会再次被伪装成“暂无运单”。
  if(error?.code==="WAYBILL_HISTORY_STALE_INDEX")throw error;
  // MGET 失败（如单次 URL 过长被拒）时降级为**分批** MGET，而非无预算的逐条 GET 循环
  if(budget){
   if(error?.code===SUBREQUEST_BUDGET_EXCEEDED)throw error;
   const {map,complete}=await mgetBatchMap(env,cleanIds.map(id=>"zp:waybill:"+id),budget,{batch:100});
   if(!complete)throwBudgetExceeded(budget.max,"history-read-waybills-fallback");
   if(strictIndex){
    const missing=cleanIds.filter(id=>!map.get("zp:waybill:"+id));
    if(missing.length)throw Object.assign(new Error("历史日期索引包含不存在的运单："+missing.slice(0,5).join(",")),{code:"WAYBILL_HISTORY_STALE_INDEX",missingCount:missing.length});
   }
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
 const raw=await command(env,["SMEMBERS",waybillIndexKey(routeId,date)]);
 if(!Array.isArray(raw))throw Object.assign(new Error("历史运单索引读取结果异常"),{code:"WAYBILL_HISTORY_INDEX_READ_FAILED"});
 return raw.map(clean).filter(Boolean);
}

export async function readDateWaybills(env,user,routeId,date,budget=null){
 const ids=await readIndexMembers(env,routeId,date,budget);
 const waybills=await readWaybills(env,ids,budget,true);
 return waybills.filter(w=>w.routeId===routeId&&w.date===date&&canReadWaybill(user,w,env)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}

export async function readDateWaybillsBatch(env,user,entries,budget=null){
 const out=new Map();const valid=entries.filter(Boolean);
 // P1-06 收口：原实现调 readWaybills 时**不传 budget**，一旦 MGET 失败就静默降级为
 // 「逐条 GET waybill」的 O(N) 循环且无任何预算约束 → 大范围历史查询必然越过平台硬限。
 // 现把 budget 一路透传：预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED，
 // 由调用方转成结构化 503「请缩小范围」，而不是把 worker 拖到 Error 1101。
 for(let i=0;i<valid.length;i+=50){
  const chunk=valid.slice(i,i+50);
  if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-dates-batch");
  const results=await pipeline(idsEnv,chunk.map(x=>["SMEMBERS",waybillIndexKey(x.routeId,x.date)]));
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

// 方案C rollup：历史概览聚合改为读「每日汇总键」meta（O(天数) 小键）+ 索引 SMEMBERS（仅 id），
// 稳态下不再 MGET 全量运单完整体 → 响应体与单量脱钩。legacy 数据缺 meta 时**批量**读体回填
// （与旧 readDateWaybillsBatch 同效率：pipeline SMEMBERS + 分批 MGET，整段请求仅数次子请求），
// 受共享 budget 约束，超限即抛 → 调用方转结构化 503「请缩小范围」；meta 一回填，后续请求即走快路。
// 严格 owner 模式（WAYBILL_STRICT_OWNER=1）不信 meta（全线路口径，含他人运单），逐日按 createdBy
// 过滤读体，保证与单日详情口径一致，且绝不回写 meta（避免污染后续非严格读取）。
export async function readDayAggregates(env,{user,routeId,entries,budget=null}){
 const strictOwner=String(env?.WAYBILL_STRICT_OWNER||"")==="1";
 // 1) 索引 SMEMBERS（取每日运单 id，廉价）与 2) 每日汇总 meta（MGET）**互不依赖**：
 //    meta key 直接由 entries 派生，无需等 SMEMBERS 结果。故两段并发执行，
 //    把原本「SMEMBERS 全部串行完 → 再 MGET 全部串行」压缩为一段并发（墙钟 ≈ 单次 RTT）。
 //    分批再取大（200→500），13 个月(~390 天)每段各只需 1 次往返。
 const idsByDate=new Map();
 const metaByDate=new Map();
 // 两条独立读取流各自持有 Session，避免并发共享同一个 D1 Session；
 // 每条流内部仍按序执行，首读从主库开始，后续读由 D1 保证顺序一致性。
 const idsEnv=createD1SessionEnv(env);
 const metaEnv=createD1SessionEnv(env);
 const loadIds=async()=>{
  for(let i=0;i<entries.length;i+=500){
   if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-dates-ids");
   const chunk=entries.slice(i,i+500);
   const results=await pipeline(env,chunk.map(x=>["SMEMBERS",waybillIndexKey(x.routeId,x.date)]));
   for(let j=0;j<chunk.length;j++){const ids=Array.isArray(results?.[j])?results[j].map(clean).filter(Boolean):[];idsByDate.set(chunk[j].date,ids);}
  }
 };
 const loadMeta=async()=>{
  const metaKeys=entries.map(e=>dayMetaKey(e.routeId,e.date));
  for(let i=0;i<metaKeys.length;i+=500){
   if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-meta");
   const chunk=metaKeys.slice(i,i+500);
   const raws=await command(metaEnv,["MGET",...chunk]);
   for(let j=0;j<chunk.length;j++){const o=parseMeta(raws?.[j]);if(o)metaByDate.set(chunk[j],o);}
  }
 };
 await Promise.all([loadIds(),loadMeta()]);
 // 3) 有 meta 且非严格 → 直接用（rollup 快路）；严格模式不信 meta，其余天按 legacy 批量读体
 const dates=[];const legacy=[];
 for(const entry of entries){
  const ids=idsByDate.get(entry.date)||[];
  const m=strictOwner?null:metaByDate.get(dayMetaKey(entry.routeId,entry.date));
  if(m){
   if(m.count>0)dates.push({date:entry.date,count:m.count,waybillIds:ids,hasMultiple:m.count>1,storeCount:m.storeCount,totalWeight:m.totalWeight});
   continue; // count===0 空日跳过
  }
  legacy.push(entry);
 }
 if(legacy.length){
  // 批量读 legacy 天全部运单体（一次聚合所有 id 后分批 MGET，受 budget 约束，超限抛 → 503）。
  const allIds=[];const idsOf=new Map();
  for(const e of legacy){const ids=idsByDate.get(e.date)||[];idsOf.set(e.date,ids);allIds.push(...ids);}
  const bodies=await readWaybills(idsEnv,allIds,budget);
  const byId=new Map(bodies.map(w=>[w.id,w]));
  const metaWrites=[];
  for(const e of legacy){
   const list=(idsOf.get(e.date)||[]).map(id=>byId.get(id)).filter(w=>w&&w.routeId===e.routeId&&w.date===e.date&&canReadWaybill(user,w,env)).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
   const storeCount=list.reduce((sum,w)=>sum+(Number(w.summary?.finalCount)||Number(w.summary?.total)||w.stores.length),0);
   const totalWeight=list.reduce((sum,w)=>sum+(Number(w.totalWeight)||0),0);
   dates.push({date:e.date,count:list.length,waybillIds:list.map(w=>w.id),hasMultiple:list.length>1,storeCount,totalWeight});
   // 非严格模式下 canReadWaybill 对同线路成员恒 true，list 即全量可读运单，
   // 故此处计数与 recomputeDayMeta/aggregateWaybills 口径一致，可直接回写 meta。
   if(!strictOwner)metaWrites.push(["SET",dayMetaKey(e.routeId,e.date),JSON.stringify({v:1,count:list.length,storeCount,totalWeight})]);
  }
  // best-effort 批量回填 meta（一次 pipeline = 1 子请求）：让后续请求走 rollup 快路
  if(metaWrites.length&&budget&&budget.canTake(1)){
   budget.take(1);
   try{await pipeline(env,metaWrites)}catch{}
  }
 }
 return {dates,degraded:false};
}

export async function readDates(env,routeId,range,budget=null){
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

export async function enrichFactory(env,routeId){
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
