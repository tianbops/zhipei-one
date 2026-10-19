import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command,pipeline} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {canReadWaybill,canWriteWaybill} from "./_waybill-acl.js";
import {getRoute} from "./_route.js";
import {dailyWaybillKey} from "./_waybill-identity.js";
import {recomputeDayMeta,dayMetaKey,parseMeta} from "./waybills/_waybill-meta.js";
import {Budget,scanKeysBudgeted,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_BUDGET_EXCEEDED} from "./_redis-budget.js";

export const clean=v=>String(v??"").trim();
const todayCN=()=>{const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;};
const endOfNextMonth=date=>{const [y,m]=date.split("-").map(Number);return new Date(Date.UTC(y,m+1,0)).toISOString().slice(0,10)};
// 历史查询/保存窗口：默认 13 个月滚动窗口，止于次月末。可经 WAYBILL_HISTORY_MONTHS 调整（仅影响可查询范围，不启用任何破坏性自动清理）。
export const historyRange=(today,months)=>{const n=Math.max(1,Math.min(120,Math.floor(Number(months)||13)));const [y,m]=today.split("-").map(Number);let startIdx=(y*12+(m-1))-(n-2);const sy=Math.floor(startIdx/12),sm=startIdx%12+1;return {start:`${sy}-${String(sm).padStart(2,"0")}-01`,end:endOfNextMonth(today),months:n};};
export const validDate=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()===m-1&&parsed.getUTCDate()===d;};
export const inRange=(date,range)=>date>=range.start&&date<=range.end;
export const monthInRange=(month,range)=>month>=range.start.slice(0,7)&&month<=range.end.slice(0,7);
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED";
const historyReadable=x=>validWaybill(x)&&["PLANNED","CONFIRMED"].includes(x.stage);
const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;

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

async function readDateWaybills(env,user,routeId,date,budget=null){
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

// 方案C rollup：历史概览聚合改为读「每日汇总键」meta（O(天数) 小键）+ 索引 SMEMBERS（仅 id），
// 稳态下不再 MGET 全量运单完整体 → 响应体与单量脱钩。legacy 数据缺 meta 时**批量**读体回填
// （与旧 readDateWaybillsBatch 同效率：pipeline SMEMBERS + 分批 MGET，整段请求仅数次子请求），
// 受共享 budget 约束，超限即抛 → 调用方转结构化 503「请缩小范围」；meta 一回填，后续请求即走快路。
// 严格 owner 模式（WAYBILL_STRICT_OWNER=1）不信 meta（全线路口径，含他人运单），逐日按 createdBy
// 过滤读体，保证与单日详情口径一致，且绝不回写 meta（避免污染后续非严格读取）。
export async function readDayAggregates(env,{user,routeId,entries,budget=null}){
 const strictOwner=String(env?.WAYBILL_STRICT_OWNER||"")==="1";
 // 1) 索引 SMEMBERS：取每日运单 id（不含完整体，廉价）
 const idsByDate=new Map();
 for(let i=0;i<entries.length;i+=50){
  if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-dates-ids");
  const chunk=entries.slice(i,i+50);
  const results=await pipeline(env,chunk.map(x=>["SMEMBERS",waybillIndexKey(x.routeId,x.date)]));
  for(let j=0;j<chunk.length;j++){const ids=Array.isArray(results?.[j])?results[j].map(clean).filter(Boolean):[];idsByDate.set(chunk[j].date,ids);}
 }
 // 2) 每日汇总键 meta（批量 MGET）
 const metaByDate=new Map();
 {
  const metaKeys=entries.map(e=>dayMetaKey(e.routeId,e.date));
  for(let i=0;i<metaKeys.length;i+=100){
   if(budget&&!budget.take(1))throwBudgetExceeded(budget.max,"history-read-meta");
   const chunk=metaKeys.slice(i,i+100);
   const raws=await command(env,["MGET",...chunk]);
   for(let j=0;j<chunk.length;j++){const o=parseMeta(raws?.[j]);if(o)metaByDate.set(chunk[j],o);}
  }
 }
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
  const bodies=await readWaybills(env,allIds,budget);
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

export async function onRequestGet({request,env}){
 try{
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
  if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
  const url=new URL(request.url),routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId),date=clean(url.searchParams.get("date"));
  if(!routeId)return json({success:true,routeId:null,months:[],history:[]});
  const currentRoute=clean(user.dispatchRouteId)||clean(user.boundRouteId);if(routeId!==currentRoute)return json({success:false,error:"无权查看该线路历史"},403);
  const monthsParam=clean(url.searchParams.get("months"));
  // 前端可经 ?months= 放宽查询窗口（仅 GET 生效，受 1–13 钳制）；默认沿用 env WAYBILL_HISTORY_MONTHS。
  // DELETE 路径不使用此参数，维持 env 默认窗口，避免客户端扩大可删除范围。
  const searchQuery=clean(url.searchParams.get("q")).normalize("NFKC").toLocaleLowerCase("zh-CN");
  const monthsN=monthsParam?Math.max(1,Math.min(13,Math.floor(Number(monthsParam)||3))):(searchQuery?3:env?.WAYBILL_HISTORY_MONTHS);
  const range=historyRange(todayCN(),monthsN),enrich=await enrichFactory(env,routeId);
  if(date){
   if(!validDate(date))return json({success:false,code:"DATE_INVALID",error:"日期无效"},400);
   if(!inRange(date,range))return json({success:false,code:"DATE_OUT_OF_RANGE",error:"日期不在历史查询范围内"},400);
   const budget=new Budget();
   let waybills;
   try{waybills=await readDateWaybills(env,user,routeId,date,budget)}catch(e){
    if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"该日期运单查询资源不足，请稍后重试",date,budgetUsed:budget.used,budgetMax:budget.max},503);
    if(e?.code==="WAYBILL_HISTORY_INDEX_READ_FAILED")return json({success:false,code:"WAYBILL_HISTORY_INDEX_READ_FAILED",error:"历史运单索引读取失败，请稍后重试",date},503);
    if(e?.code==="WAYBILL_HISTORY_STALE_INDEX")return json({success:false,code:"WAYBILL_HISTORY_STALE_INDEX",error:"历史运单索引与运单数据不一致，请稍后重试",date,missingCount:e.missingCount},503);
    throw e;
   }
   const enriched=[];for(const w of waybills)enriched.push(await enrich(w));
   return json({success:true,routeId,date,waybills:enriched,count:enriched.length,waybillIds:enriched.map(w=>w.id),hasMultiple:enriched.length>1});
  }
  if(searchQuery){
   if(searchQuery.length>80)return json({success:false,code:"SEARCH_QUERY_TOO_LONG",error:"搜索内容最多 80 个字符"},400);
   const budget=new Budget();
   let entries,batch;
   try{
    entries=await readDates(env,routeId,range,budget);
    batch=await readDateWaybillsBatch(env,user,entries,budget);
   }catch(e){
    if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"当前历史范围较大，请缩小月份范围后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
    throw e;
   }
   const normalize=v=>String(v??"").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu,"");
   const needle=normalize(searchQuery);
   if(!needle)return json({success:false,code:"SEARCH_QUERY_INVALID",error:"请输入有效的搜索关键词"},400);
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
   return json({success:true,routeId,query:searchQuery,range,results,count:results.length,limited:results.length>=100});
  }
  // P1-06 收口：readDates / readDateWaybillsBatch 共享同一 Budget，
 // 预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED → 转结构化 503「请缩小查询范围」，
 // 而不是让 worker 在无预算的裸循环里撞上平台硬限（Error 1101）。
 const budget=new Budget();
 let entries;
 try{
  entries=await readDates(env,routeId,range,budget);
 }catch(e){
  if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"历史查询范围过大，请缩小查询月份后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
  throw e;
 }
 // 方案C rollup：概览只依赖「每日汇总键」(O(天数) 小键) + 索引 SMEMBERS(仅 id，不含运单完整体)，
 // 稳态成本与单量彻底脱钩。legacy 数据缺 meta 时批量读体回填（同旧 readDateWaybillsBatch 效率），
 // 受同一 budget 约束；超限即转结构化 503「请缩小范围」，绝不谎报半截数据。
 let agg;
 try{
  agg=await readDayAggregates(env,{user,routeId,entries,budget});
 }catch(e){
  if(e?.code===SUBREQUEST_BUDGET_EXCEEDED)return json({success:false,code:"PARTIAL_FAILURE",error:"当前历史范围较大，请缩小月份范围后重试",range,budgetUsed:budget.used,budgetMax:budget.max},503);
  throw e;
 }
 const dates=agg.dates;
 const monthMap=new Map();
 for(const item of dates){const month=item.date.slice(0,7),current=monthMap.get(month)||{month,days:0,waybills:0,totalStores:0,totalWeight:0};current.days++;current.waybills+=item.count;current.totalStores+=item.storeCount;current.totalWeight+=item.totalWeight;monthMap.set(month,current)}
 return json({success:true,routeId,range,months:[...monthMap.values()],history:dates,degraded:agg.degraded||undefined});
 }catch(e){return json({success:false,code:"HISTORY_READ_FAILED",error:"统一运单查询失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,180)},500)}
}

// 回收站：软删除用（P2-3）。主记录与子键迁入 zp:waybill:trash:<id>[:*]，TTL 7 天由 Upstash 自动消亡。
const TRASH_TTL_SECONDS=604800;
const trashMainKey=id=>"zp:waybill:trash:"+id;
const trashChildKey=id=>"zp:waybill:trash:"+id+":";
const isTrashKey=k=>String(k).startsWith("zp:waybill:trash:");
async function deleteWaybill(env,routeId,date,waybillId,budget){
 const errors=[];let mainOk=false,indexOk=false,childrenOk=true,refOk=true;
 let record=null;
 try{if(!budget.take(1))throwBudgetExceeded(budget.max,"history-delete-read");const raw=await command(env,["GET","zp:waybill:"+waybillId]);if(raw)record=typeof raw==="string"?JSON.parse(raw):raw}catch(e){errors.push(e)}
 // 主记录已不存在：幂等视为成功，仅清理可能残留的日期索引尾部。
 if(!record){
  const indexKey=waybillIndexKey(routeId,date);
  if(budget.canTake(1)){budget.take(1);try{await command(env,["SREM",indexKey,waybillId]);indexOk=true}catch(e){errors.push(e)}}
  else indexOk=true;
  return {mainOk:true,indexOk,childrenOk:true,refOk:true,budgetExceeded:false,errors};
 }
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
 // 预算：写 trash 主记录(1) + 每子键 RENAME+EXPIRE(2*N) + 索引 SREM(1) + 反引清理(2) + DEL 原主(1)
 const required=2+(childKeys.length?childKeys.length*2:0);
 if(!budget.canTake(required)){
  return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:true,errors:[Object.assign(new Error("历史删除资源预算不足"),{code:SUBREQUEST_BUDGET_EXCEEDED})]};
 }
 // 1) 先把主记录搬入回收站（覆盖式 SET + EXPIRE），保证可恢复；之后任意步骤失败都可直接重试。
 const mainKey="zp:waybill:"+waybillId;
 try{
  budget.take(1);await command(env,["SET",trashMainKey(waybillId),JSON.stringify(record),"EX",String(TRASH_TTL_SECONDS)]);
  budget.take(1);await command(env,["EXPIRE",trashMainKey(waybillId),String(TRASH_TTL_SECONDS)]);
 }catch(e){errors.push(e);return {mainOk:false,indexOk:true,childrenOk:false,refOk:true,budgetExceeded:e?.code===SUBREQUEST_BUDGET_EXCEEDED,errors};}
 // 2) 子键迁入回收站命名空间，并各自 EXPIRE，保证 7 天后整体干净（也避免一致性巡检把残留子键报孤儿）。
 if(childKeys.length){
  try{
   for(const ck of childKeys){
    budget.take(1);await command(env,["RENAME",ck,trashChildKey(waybillId)+ck.slice(prefix.length)]);
    budget.take(1);await command(env,["EXPIRE",trashChildKey(waybillId)+ck.slice(prefix.length),String(TRASH_TTL_SECONDS)]);
   }
  }catch(e){errors.push(e);childrenOk=false}
 }
 // 3) 日期索引移除（查询对用户立即干净）。
 const indexKey=waybillIndexKey(routeId,date);
 try{budget.take(1);await command(env,["SREM",indexKey,waybillId]);indexOk=true}catch(e){errors.push(e)}
 // 方案C rollup：删除后同步重算当日汇总键（best-effort；读路径缺失 meta 会自动自愈）
 try{await recomputeDayMeta(env,routeId,date)}catch{}
 // 4) 反向引用（指纹/日去重）按原逻辑清理：仅当仍指向本单才 DEL，已被覆盖/复用的键不动，保护重传幂等。
 const refKeys=[];
 if(record?.businessFingerprint)refKeys.push("zp:waybill:fingerprint:"+record.businessFingerprint);
 if(record){try{const sig=await dailyWaybillKey(record);refKeys.push("zp:waybill:dedupe:"+sig)}catch{}}
 try{
  for(const rk of refKeys){
   if(!budget.canTake(1))break;
   budget.take(1);
   const v=await command(env,["GET",rk]);
   if(String(v??"")===String(waybillId)){await command(env,["DEL",rk])}
  }
  refOk=!refKeys.length||refKeys.every(rk=>true);
 }catch(e){errors.push(e);refOk=false}
 // 5) 最后删除原主记录（若此前任一步失败，原主记录仍在，下次 DELETE 从读取阶段重新走完整流程）。
 try{budget.take(1);await command(env,["DEL",mainKey]);mainOk=true}catch(e){errors.push(e)}
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
