import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,set,newId,command} from "./_redis.js";
import {Budget,SUBREQUEST_LIMIT,scanKeysBudgeted,smembersBatch,mgetBatchMap,throwBudgetExceeded} from "./_redis-budget.js";
import {getRoute,saveRoute,routeId,cleanRouteName} from "./_route.js";
import {isSystemAdmin} from "./_permissions.js";
import {dailyWaybillKey} from "./_waybill-identity.js";
import {guard} from "./_safe.js";
const clean=v=>String(v??"").trim();
async function list(env){const raw=await get(env,"routes:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v))throw new Error("INVALID_INDEX");return v}catch{throw Object.assign(new Error("ROUTES_INDEX_INVALID"),{code:"ROUTES_INDEX_INVALID"})}}
async function writeList(env,items){return set(env,"routes:index",items)}
async function cleanupRouteRequests(env,routeId){
 const budget=new Budget(SUBREQUEST_LIMIT);
 for(let attempt=0;attempt<3;attempt++){
  if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-route-requests-index");
  const raw=await get(env,"route-requests:index");if(!raw)return 0;
  let ids;try{ids=typeof raw==="string"?JSON.parse(raw):raw}catch{return 0}
  if(!Array.isArray(ids)||ids.some(x=>typeof x!=="string"||!x.trim()))return 0;
  // 批量 MGET 全部申请（替代逐条 GET），纳入统一预算；截断即抛错，绝不部分清理后谎报成功（P1-07）
  const {map,complete}=await mgetBatchMap(env,ids.map(rid=>"zp:route-request:"+rid),budget,{batch:100});
  if(!complete)throwBudgetExceeded(budget.max,"cleanup-route-requests-read");
  const keep=[],deleteKeys=[];
  for(const rid of ids){const item=map.get("zp:route-request:"+rid);let q=null;try{q=typeof item==="string"?JSON.parse(item):item}catch{};if(q?.routeId===routeId){deleteKeys.push("zp:route-request:"+rid);}else keep.push(rid)}
  if(deleteKeys.length){if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-route-requests-delete");await command(env,["DEL",...deleteKeys]);}
  if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-route-requests-cas");
  const ok=await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[1],ARGV[2]); return 1 end; return 0',"1","zp:route-requests:index",String(raw),JSON.stringify(keep)]);
  if(Number(ok)===1)return deleteKeys.length;
 }
 return 0;
}
/**
 * 删除一条线路的全部运单（1.1 可靠性修复）。
 * 旧实现：SCAN 全部 `zp:waybill:*` → 逐键 GET 过滤 routeId → 再对每张运单 SCAN 子键，
 *   成本 O(全线路运单总数)，删除运单多的线路直接越过 Workers 子请求上限 → Error 1101。
 * 新实现：仅枚举**本线路**的日期桶索引（zp:route:<rid>:waybills:<date>），
 *   批量 SMEMBERS 取 id → 批量 MGET 主记录 → 批量 DEL，成本与本线路运单量近似常数级。
 * 另设预算护栏：估算子请求数超过平台上限（40）时明确拒绝，绝不静默触发 1101。
 */
async function cleanupRouteWaybills(env,routeId){
 const idxPrefix="zp:route:"+routeId+":waybills:";
 // 1) 枚举本线路日期桶（不再 SCAN 全键空间）；统一预算收口到 _redis-budget.js
 const budget=new Budget(SUBREQUEST_LIMIT);
 // 解构 complete：SCAN 被预算截断（iterCap / 预算 / 键数上限）时立即停止，绝不部分删除后谎报 success（P1-01）
 const {keys:buckets,complete:wbScanComplete}=await scanKeysBudgeted(env,idxPrefix+"*",budget,{count:200});
 if(!wbScanComplete)throwBudgetExceeded(budget.max,"route-waybill-scan");
 // 2) pipeline SMEMBERS 取每个桶成员（运单 id）
 const ids=new Set();
 {const members=await smembersBatch(env,buckets,budget,{batch:50});for(const b of buckets)for(const m of (Array.isArray(members.map.get(b))?members.map.get(b):[])){const id=clean(m);if(id)ids.add(id);}}
 // 3) 预算护栏：超大线路同步删除会越平台上限 → 明确拒绝而非 1101
 const est=1+Math.ceil(buckets.length/50)+Math.ceil(ids.size/100)+Math.ceil((ids.size*5+buckets.length)/100);
 if(est>40)throw Object.assign(new Error("线路运单量过大，单次删除预计需 "+est+" 次子请求，超过平台上限 40，请分批或联系平台"),{code:"ROUTE_TOO_LARGE"});
 // 4) 批量 MGET 主记录（取 businessFingerprint / requestId / dedupe 所需字段）
 const recs=new Map();
 {const all=[...ids];const r=await mgetBatchMap(env,all.map(id=>"zp:waybill:"+id),budget,{batch:100});for(const id of all){const raw=r.map.get("zp:waybill:"+id);if(!raw)continue;try{recs.set(id,typeof raw==="string"?JSON.parse(raw):raw)}catch{}}}
 // 5) 组装删除键（与 history.js 单删逻辑对齐：主键 / 事件 / 处理票据 / 指纹 / 去重）
 const del=[];
 for(const id of ids){const r=recs.get(id);del.push("zp:waybill:"+id,"zp:waybill:"+id+":events");if(r?.requestId)del.push("zp:waybill:proc:"+clean(r.requestId));if(r?.businessFingerprint)del.push("zp:waybill:fingerprint:"+r.businessFingerprint);if(r){try{const sig=await dailyWaybillKey(r);if(sig)del.push("zp:waybill:dedupe:"+sig)}catch{}}}
 for(const b of buckets){del.push(b);del.push(b+":meta");} // 整条线路删除，直接 DEL 日期桶及其汇总键
 // 6) 批量 DEL（每批 100 键）
 let deleted=0;for(let i=0;i<del.length;i+=100){const r=await command(env,["DEL",...del.slice(i,i+100)]);deleted+=Number(r||0);}
 return deleted;
}

/* 线路读取（司机端 / 管理端 / 聚合接口共用）——批量 MGET 版。
 * 历史实现：校验循环逐条 getRoute，构建循环再逐条 getRoute + base，
 *   合计 4M+2 次串行 Redis 往返（M=线路数，每次往返 = 一次 Upstash POST）；
 *   移动网络下 10 条线路就是 40+ 次串行往返，动辄数百毫秒。
 * 现：两次 MGET（线路主记录 / base）拿全量，往返数降为 4，与线路数无关。
 * 错误契约（409 结构化码与消息文本）逐字保留；管理员巡检修复逻辑原样保留，
 * 修复后重新批量读取，保证返回值与修复后一致（原实现靠二次 getRoute 天然达成）。 */
export async function readRoutes(env,user){
 let ids;
 try{ids=await list(env)}catch{throw Object.assign(new Error("线路索引数据异常，请联系管理员处理"),{code:"ROUTES_INDEX_INVALID"})}
 const routeDataError=msg=>Object.assign(new Error(msg),{code:"ROUTE_DATA_INVALID"});
 const budget=new Budget(SUBREQUEST_LIMIT);
 const {map:routeMap,complete:routeComplete}=await mgetBatchMap(env,ids.map(id=>"zp:route:"+id),budget,{batch:100});
 if(!routeComplete)throwBudgetExceeded(budget.max,"routes-read-main");
 const parseRoute=v=>{if(v==null)return null;try{return typeof v==="string"?JSON.parse(v):v}catch{return null}};
 const routeById=new Map();
for(const id of ids)routeById.set(id,parseRoute(routeMap.get("zp:route:"+id)));
const repairs=[];
for(const id of ids){if(typeof id!=="string"||!id.trim())throw routeDataError("线路索引包含无效数据，请联系管理员处理");const r=routeById.get(id);if(!r||r.id!==id||typeof r.name!=="string"||!r.name.trim()||!["active","disabled"].includes(r.status||"active"))throw routeDataError("线路数据异常，请联系管理员处理");if(r.driverUserId!=null&&typeof r.driverUserId!=="string")throw routeDataError("线路岗位数据异常，请联系管理员处理");if(r.deliveryUserId!=null&&typeof r.deliveryUserId!=="string")throw routeDataError("线路岗位数据异常，请联系管理员处理");
// 全局绑定一致性巡检 + 自动修复属于运维动作，仅系统管理员触发；普通业务用户只读取线路，绝不改写他人数据（P1-03）
if(isSystemAdmin(user)){
for(const [duty,field] of [["driver","driverUserId"],["delivery","deliveryUserId"]]){const uid=r[field];if(!uid)continue;const rawUser=await get(env,"user:"+uid);let linked=null;try{linked=typeof rawUser==="string"?JSON.parse(rawUser):rawUser}catch{};const valid=!!linked&&linked.id===uid&&!isSystemAdmin(linked)&&!linked.disabled&&linked.boundRouteId===r.id&&linked.routeDuty===duty;if(!valid){const canRestore=!!linked&&linked.id===uid&&!linked.disabled&&!isSystemAdmin(linked)&&linked.boundRouteId===r.id&&linked.routeDuty===duty;if(!canRestore){const routeKey="zp:route:"+r.id;await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local r=cjson.decode(raw); if r.id~=ARGV[1] or r[ARGV[2]]~=ARGV[3] then return 3 end; r[ARGV[2]]=cjson.null; redis.call('SET',KEYS[1],cjson.encode(r)); return 1","1",routeKey,r.id,field,uid]);r[field]=null;repairs.push({routeId:r.id,duty,userId:uid,action:"clear_orphan_route_slot"})}}}}}
if(isSystemAdmin(user)){
const rawUsers=await get(env,"users:index");let userIds=[];if(rawUsers){try{const v=typeof rawUsers==="string"?JSON.parse(rawUsers):rawUsers;if(!Array.isArray(v)||v.some(x=>typeof x!=="string"||!x.trim()))throw 0;userIds=v}catch{throw Object.assign(new Error("用户索引数据异常，请联系管理员处理"),{code:"USER_INDEX_INVALID"})}}
for(const uid of userIds){const raw=await get(env,"user:"+uid);let u=null;try{u=typeof raw==="string"?JSON.parse(raw):raw}catch{};if(!u||u.id!==uid)continue;if(!u.boundRouteId&&!u.routeDuty)continue;if(!u.boundRouteId||!["driver","delivery"].includes(u.routeDuty)){const key="zp:user:"+uid;await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local u=cjson.decode(raw); if u.id~=ARGV[1] then return 3 end; u.boundRouteId=cjson.null; u.routeDuty=cjson.null; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1","1",key,uid]);repairs.push({userId:uid,action:"clear_invalid_user_binding"});continue}
const rr=await getRoute(env,u.boundRouteId);if(!rr){const key="zp:user:"+uid;await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local u=cjson.decode(raw); if u.id~=ARGV[1] then return 3 end; u.boundRouteId=cjson.null; u.routeDuty=cjson.null; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1","1",key,uid]);repairs.push({userId:uid,action:"clear_missing_route_binding"});continue}
const field=u.routeDuty==="driver"?"driverUserId":"deliveryUserId";const occupant=rr[field];if(occupant===uid)continue;if(!occupant){const routeKey="zp:route:"+rr.id;await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local r=cjson.decode(raw); if r.id~=ARGV[1] or r[ARGV[2]]~=nil then return 3 end; r[ARGV[2]]=ARGV[3]; redis.call('SET',KEYS[1],cjson.encode(r)); return 1","1",routeKey,rr.id,field,uid]);repairs.push({routeId:rr.id,userId:uid,duty:u.routeDuty,action:"restore_route_slot"});continue}
// 两个用户同时声明同一岗位时，以线路当前占用者为准，清理冲突用户的绑定，避免任何窗口显示不同人员。
const key="zp:user:"+uid;await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local u=cjson.decode(raw); if u.id~=ARGV[1] or u.boundRouteId~=ARGV[2] or u.routeDuty~=ARGV[3] then return 3 end; u.boundRouteId=cjson.null; u.routeDuty=cjson.null; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1","1",key,uid,rr.id,u.routeDuty]);repairs.push({routeId:rr.id,userId:uid,duty:u.routeDuty,action:"clear_conflicting_user_binding",keptUserId:occupant})}
}
 // 管理员修复可能改写线路岗位（清孤儿占用 / 恢复占用）：重新批量读取，
 // 保证返回值反映修复后的状态（与原实现二次 getRoute 等效）。
 if(repairs.length){
  const {map:fixedMap,complete:fixedComplete}=await mgetBatchMap(env,ids.map(id=>"zp:route:"+id),budget,{batch:100});
  if(!fixedComplete)throwBudgetExceeded(budget.max,"routes-reread");
  for(const id of ids){const r2=parseRoute(fixedMap.get("zp:route:"+id));if(r2&&r2.id===id)routeById.set(id,r2)}
 }
 const {map:baseMap,complete:baseComplete}=await mgetBatchMap(env,ids.map(id=>"zp:route:"+id+":base"),budget,{batch:100});
 if(!baseComplete)throwBudgetExceeded(budget.max,"routes-read-base");
const routes=[];for(const id of ids){const r=routeById.get(id);const baseRaw=baseMap.get("zp:route:"+id+":base");let storeCount=0;try{const b=baseRaw?(typeof baseRaw==="string"?JSON.parse(baseRaw):baseRaw):null;storeCount=Array.isArray(b?.stores)?b.stores.length:0}catch{}routes.push({id:r.id,name:r.name,status:r.status||"active",driverUserId:r.driverUserId||null,deliveryUserId:r.deliveryUserId||null,storeCount})}
 return {routes,repairs};
}

async function routesGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 try{
  const {routes}=await readRoutes(env,user);
  return json({success:true,routes});
 }catch(e){
  if(e&&(e.code==="ROUTES_INDEX_INVALID"||e.code==="ROUTE_DATA_INVALID"))return json({success:false,code:e.code,error:e.message||"线路数据异常，请联系管理员处理"},409);
  throw e;
 }
}
// 错误兜底（1.1 可靠性）：未被业务捕获的异常不再返回裸 500，而是结构化 503/500 + 截断 detail
export const onRequestGet=guard(routesGet,"ROUTES_READ_FAILED");
export const onRequestPost=guard(async ({request,env})=>{const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(!isSystemAdmin(user))return json({success:false,error:"无权限"},403);const input=await body(request);if(input.action==="delete"){const rid=String(input.routeId||"").trim();if(!rid)return json({success:false,error:"线路不存在"},404);const raw=await get(env,"route:"+rid);if(!raw)return json({success:false,error:"线路不存在"},404);let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路数据异常，无法安全删除"},409)}if(x.id!==rid)return json({success:false,code:"ROUTE_DATA_INVALID",error:"线路数据异常，无法安全删除"},409);let routeIds;try{routeIds=await list(env)}catch{return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请先修复后再删除"},409)}if(!routeIds.includes(rid))return json({success:false,code:"ROUTE_INDEX_MISSING",error:"线路索引中不存在该线路，请先修复数据后再删除"},409);const bound=[];for(const [duty,uid] of [["driver",x.driverUserId],["delivery",x.deliveryUserId]]){if(!uid)continue;const ur=await get(env,"user:"+uid);if(!ur)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路绑定用户不存在，无法安全删除"},409);let z;try{z=typeof ur==="string"?JSON.parse(ur):ur}catch{return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路绑定用户数据异常，无法安全删除"},409)}if(z.id!==uid||z.disabled===true||z.boundRouteId!==rid||z.routeDuty!==duty)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"线路与用户绑定数据不一致，无法安全删除"},409);bound.push({duty,id:uid,user:z})}const requestRaw=await get(env,"route-requests:index");let requestIds=[];if(requestRaw){try{const v=typeof requestRaw==="string"?JSON.parse(requestRaw):requestRaw;if(!Array.isArray(v)||v.some(id=>typeof id!=="string"||!id.trim()))throw 0;requestIds=v}catch{return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请先修复后再删除线路"},409)}}const keys=["zp:route:"+rid,"zp:routes:index","zp:route:"+rid+":base",...bound.map(v=>"zp:user:"+v.id)];
// ARGV 布局（与下方脚本下标严格对应，1-indexed）：
//   [1]=rid  [2]=剔除本线路后的 routes:index
//   [3 .. 2+boundCount]      = 各绑定用户 id（校验用）
//   [3+boundCount .. 2+2*boundCount] = 各绑定用户 routeDuty（校验用）
//   [3+2*boundCount ..]      = 各绑定用户「清空绑定后」的 JSON（写入用）
// 旧实现 uidArg=2+i / jsonArg=2+bound.length+i 整体错位 1，导致 ARGV[2] 既被当作新索引又被当作
// 首个用户 id，且 routeDuty 校验拿到的永远是清空后的 null —— 任何带绑定用户的线路删除都 return 5 → 409。
const args=[rid,JSON.stringify(routeIds.filter(v=>v!==rid)),...bound.map(v=>v.id),...bound.map(v=>v.duty),...bound.map(v=>JSON.stringify({...v.user,boundRouteId:null,routeDuty:null,sessionVersion:(v.user.sessionVersion??1)+1}))];
let script="local boundCount=#KEYS-3; local raw=redis.call('GET',KEYS[1]); local ri=redis.call('GET',KEYS[2]); if not raw or not ri then return 2 end; local r=cjson.decode(raw); local ids=cjson.decode(ri); if r.id~=ARGV[1] or type(ids)~='table' then return 3 end;";
for(let i=0;i<bound.length;i++){const k=4+i;const idArg=3+i;const dutyArg=3+bound.length+i;script+=`local raw${i}=redis.call('GET',KEYS[${k}]); if not raw${i} then return 4 end; local ok${i},u${i}=pcall(cjson.decode,raw${i}); if not ok${i} or type(u${i})~='table' or u${i}.id~=ARGV[${idArg}] or u${i}.boundRouteId~=ARGV[1] or u${i}.routeDuty~=ARGV[${dutyArg}] then return 5 end; `}
script+=`redis.call('SET',KEYS[2],ARGV[2]);`;
for(let i=0;i<bound.length;i++){const k=3+i;const jsonArg=3+2*bound.length+i;script+=`redis.call('SET',KEYS[${k}],ARGV[${jsonArg}]);`;}
script+="redis.call('DEL',KEYS[1]); redis.call('DEL',KEYS[3]); return 1";
// 先清理子键（申请 / 运单）：任一步预算耗尽或 SCAN 截断都会抛错，线路主记录保持不删，绝不谎报 success（P1-01/P1-07）
const requestDeleted=await cleanupRouteRequests(env,rid);
const waybillDeleted=await cleanupRouteWaybills(env,rid);
// 子键清理无误后再原子删除线路主记录 + 索引 + 解绑用户（一行 EVAL，要么全成要么全不成）
const code=Number(await command(env,["EVAL",script,String(keys.length),...keys,...args]));if(code!==1)return json({success:false,error:"线路状态已变化，请刷新后重试"},409);
const deleted=1;return json({success:true,deleted,requestDeleted,waybillDeleted})}
const name=cleanRouteName(input.name);if(!name)return json({success:false,error:"请输入线路名称"},400);const id=routeId(),now=new Date().toISOString();
const route={id,name,status:"active",driverUserId:null,deliveryUserId:null,createdAt:now};
const routeKey="zp:route:"+id,baseKey="zp:route:"+id+":base",indexKey="zp:routes:index";
const script="local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,rid in ipairs(ids) do local rr=redis.call('GET','zp:route:'..rid); if rr then local ok,r=pcall(cjson.decode,rr); if ok and string.lower(tostring(r.name or ''))==string.lower(ARGV[2]) then return 2 end end end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1";
const base={routeId:id,version:1,updatedAt:now,updatedBy:user.id,stores:[]};
const code=Number(await command(env,["EVAL",script,"3",indexKey,routeKey,baseKey,JSON.stringify(route),name,JSON.stringify(base),id]));
if(code===2)return json({success:false,error:"线路已存在"},409);if(code===4)return json({success:false,code:"ROUTES_INDEX_INVALID",error:"线路索引数据异常，请联系管理员处理"},409);
if(code!==1)return json({success:false,code:"ROUTE_CREATE_FAILED",error:"线路创建失败，请稍后重试"},500);
return json({success:true,route})},"ROUTE_MUTATE_FAILED");
