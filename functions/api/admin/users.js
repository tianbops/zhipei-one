import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,del,command} from "../_redis.js";
import {Budget,scanKeysBudgeted,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_LIMIT} from "../_redis-budget.js";
import {atomicBind,atomicUnbind} from "../_binding.js";
import {getRoute} from "../_route.js";
import {isSystemAdmin} from "../_permissions.js";
async function read(env,id){const raw=await get(env,"user:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
// 批量路径的解析助手：与 read() 同语义（坏数据视为缺失，交由调用方报 USER_DATA_INVALID）
function parseUser(raw){if(raw===null||raw===undefined)return null;if(typeof raw==="object")return raw;try{return JSON.parse(raw)}catch{return null}}
async function ids(env){const raw=await get(env,"users:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v))throw new Error("INVALID_INDEX");return v}catch{throw Object.assign(new Error("USER_INDEX_INVALID"),{code:"USER_INDEX_INVALID"})}}
async function safe(env,u,routeMap=null){const r=u.boundRouteId?(routeMap?routeMap.get(u.boundRouteId)||null:await getRoute(env,u.boundRouteId)):null;return {id:u.id,username:u.username,name:u.name||"",role:u.role||"user",disabled:!!u.disabled,boundRouteId:u.boundRouteId||null,routeDuty:u.routeDuty||null,routeName:r?.name||null,createdAt:u.createdAt||null}}
async function loadRequestIds(env){const raw=await get(env,"route-requests:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v)||v.some(x=>typeof x!=="string"||!x.trim()))throw 0;return v}catch{return null}}
// 删用户时清理其会话：原实现 SCAN zp:session:* 全键空间遍历，会话多时 O(总会话数) 子请求 → 潜在 1101。
// 现统一收口到 _redis-budget.js：scanKeysBudgeted 受预算 + 迭代上限约束，MGET 分批(100)，绝不静默越限。
export async function cleanupUserSessions(env,userId){
  const budget=new Budget(SUBREQUEST_LIMIT);
  const {keys,complete:scanOk}=await scanKeysBudgeted(env,"zp:session:*",budget,{count:200,iterCap:12});
  let deleted=0, delOk=true;
  for(let i=0;i<keys.length;i+=100){
    if(!budget.take(1)){delOk=false;break;} // 预算门控 MGET
    const chunk=keys.slice(i,i+100);
    const vals=await command(env,["MGET",...chunk]);
    const gone=[];
    for(let j=0;j<chunk.length;j++){let v=vals?.[j];try{v=typeof v==="string"?JSON.parse(v):v}catch{v=null}if(v?.userId===userId)gone.push(chunk[j]);}
    if(gone.length){ if(!budget.take(1)){delOk=false;break;} await command(env,["DEL",...gone]); deleted+=gone.length; } // 预算门控 DEL
  }
  // 截断（iterCap / 预算 / 键数上限）显式上报 complete，复用删除路径的 503 重试语义，绝不静默漏清
  return {deleted, complete: scanOk && delOk};
}
async function cleanupUserRequests(env,userId){
 const budget=new Budget(SUBREQUEST_LIMIT);let removed=0;
 for(let attempt=0;attempt<3;attempt++){
  if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-user-requests-index");
  const raw=await get(env,"route-requests:index");if(!raw)return removed;
  let ids;try{ids=typeof raw==="string"?JSON.parse(raw):raw}catch{return removed}
  if(!Array.isArray(ids)||ids.some(x=>typeof x!=="string"||!x.trim()))return removed;
  const requestIds=[...new Set(ids.map(x=>String(x).trim()).filter(Boolean))];
  const {map,complete}=await mgetBatchMap(env,requestIds.map(rid=>"zp:route-request:"+rid),budget,{batch:100});
  if(!complete)throwBudgetExceeded(budget.max,"cleanup-user-requests-read");
  const keep=[],deleteKeys=[];
  for(const rid of requestIds){
   let q=null;try{const item=map.get("zp:route-request:"+rid);q=typeof item==="string"?JSON.parse(item):item}catch{}
   if(q?.userId===userId)deleteKeys.push("zp:route-request:"+rid);else keep.push(rid);
  }
  if(deleteKeys.length){if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-user-requests-delete");await command(env,["DEL",...deleteKeys]);removed+=deleteKeys.length}
  if(!budget.take(1))throwBudgetExceeded(budget.max,"cleanup-user-requests-cas");
  const check=await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[1],ARGV[2]); return 1 end; return 0',"1","zp:route-requests:index",String(raw),JSON.stringify(keep)]);
  if(Number(check)===1)return removed;
 }
 return removed;
}
// P1-02 收口：原实现 for(userIds){ read(逐个 GET 用户) → safe(内含逐个 GET 线路) }，
// 用户数 N 时子请求达 2N（用户 + 线路各一遍），必然越过 Workers 每请求约 50 子请求上限 → Error 1101。
// 现统一收口到 _redis-budget.js：用户 MGET 分批(100) + 线路 MGET 分批(100)，共享同一 Budget，
// 任一批次预算不足即 throwBudgetExceeded，绝不返回「只列了一半用户」的 success。
export async function onRequestGet({request,env}){
 const actor=await currentUser(request,env);
 if(!actor||!isSystemAdmin(actor))return json({success:false,error:"无权限"},403);
 let userIds;try{userIds=await ids(env)}catch{return json({success:false,code:"USER_INDEX_INVALID",error:"用户索引数据异常，请联系管理员处理"},409)}
 const budget=new Budget(SUBREQUEST_LIMIT);
 const {map,complete}=await mgetBatchMap(env,userIds.map(id=>"zp:user:"+id),budget,{batch:100});
 if(!complete)throwBudgetExceeded(budget.max,"admin-users-list");
 const users=[];
 for(const id of userIds){
  const u=parseUser(map.get("zp:user:"+id));
  if(!u)return json({success:false,code:"USER_DATA_INVALID",error:"用户索引包含缺失或损坏的用户数据，请联系管理员处理"},409);
  users.push(u);
 }
 // 线路名同样批量取，避免「每用户一次 GET route」的第二个 O(N)
 const routeIds=[...new Set(users.map(u=>String(u.boundRouteId||"")).filter(Boolean))];
 const routeMap=new Map();
 if(routeIds.length){
  const {map:rmap,complete:rOk}=await mgetBatchMap(env,routeIds.map(rid=>"zp:route:"+rid),budget,{batch:100});
  if(!rOk)throwBudgetExceeded(budget.max,"admin-users-routes");
  for(const rid of routeIds){const r=parseUser(rmap.get("zp:route:"+rid));if(r)routeMap.set(rid,r)}
 }
 const list=[];for(const u of users)list.push(await safe(env,u,routeMap));
 return json({success:true,users:list});
}
export async function onRequestPost({request,env}){const actor=await currentUser(request,env);if(!actor||!isSystemAdmin(actor))return json({success:false,error:"无权限"},403);const input=await body(request);const action=String(input.action||"");const id=String(input.userId||"");const u=await read(env,id);if(!u)return json({success:false,error:"用户不存在"},404);if(isSystemAdmin(u))return json({success:false,error:"系统管理员账号不能通过此接口修改"},403);
if(action==="disable"||action==="enable"){
 const disabling=action==="disable";
 if(!disabling){const key="zp:user:"+id;const next={...u,disabled:false,sessionVersion:(u.sessionVersion??1)+1};const code=Number(await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.disabled~=true then return 5 end; x.disabled=false; x.sessionVersion=(x.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(x)); return 1","1",key,id]));if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);return json({success:true,user:await safe(env,next)})}
 const boundRouteId=String(u.boundRouteId||"").trim();
 if(!boundRouteId){const key="zp:user:"+id;const next={...u,disabled:true,sessionVersion:(u.sessionVersion??1)+1};const code=Number(await command(env,["EVAL","local rawIds=redis.call('GET',KEYS[2]); local ids={}; if rawIds then local okIds,v=pcall(cjson.decode,rawIds); if not okIds or type(v)~='table' then return 8 end; ids=v; for _,rid in ipairs(ids) do if type(rid)~='string' or rid=='' then return 8 end end end; local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok or type(x)~='table' then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.disabled==true then return 5 end; if x.boundRouteId then return 6 end; if x.routeDuty then return 7 end; x.disabled=true; x.sessionVersion=(x.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(x)); for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local rq=redis.call('GET',k); if rq then local qok,q=pcall(cjson.decode,rq); if qok and type(q)=='table' and q.userId==x.id and q.status=='pending' then q.status='rejected'; q.reviewedAt=ARGV[4]; q.reviewedBy=ARGV[3]; redis.call('SET',k,cjson.encode(q)); end end end; return 1","2",key,"zp:route-requests:index",id,actor.id,new Date().toISOString()]));if(code===6||code===7)return json({success:false,code:"USER_BINDING_STATE_CHANGED",error:"账号绑定状态已发生变化，请刷新后重试"},409);if(code!==1)return json({success:false,error:"账号状态已发生变化，请刷新后重试"},409);return json({success:true,user:await safe(env,next)})}
 const rawRoute=await get(env,"route:"+boundRouteId);if(!rawRoute)return json({success:false,code:"BOUND_ROUTE_MISSING",error:"用户绑定线路不存在，无法安全停用账号"},409);let route;try{route=typeof rawRoute==="string"?JSON.parse(rawRoute):rawRoute}catch{return json({success:false,code:"BOUND_ROUTE_INVALID",error:"用户绑定线路数据异常，无法安全停用账号"},409)}
 const nextRoute={...route};if(u.routeDuty==="driver"){if(nextRoute.driverUserId!==u.id)return json({success:false,code:"BOUND_ROUTE_INCONSISTENT",error:"用户与线路岗位绑定数据不一致，无法安全停用账号"},409);nextRoute.driverUserId=null}else if(u.routeDuty==="delivery"){if(nextRoute.deliveryUserId!==u.id)return json({success:false,code:"BOUND_ROUTE_INCONSISTENT",error:"用户与线路岗位绑定数据不一致，无法安全停用账号"},409);nextRoute.deliveryUserId=null}else{return json({success:false,code:"BOUND_ROUTE_DUTY_INVALID",error:"用户绑定岗位数据异常，无法安全停用账号"},409)}
 const nextUser={...u,disabled:true,boundRouteId:null,routeDuty:null,sessionVersion:(u.sessionVersion??1)+1};const requestIndexRaw=await get(env,"route-requests:index");let requestIds=[];if(requestIndexRaw){try{const v=typeof requestIndexRaw==="string"?JSON.parse(requestIndexRaw):requestIndexRaw;if(!Array.isArray(v)||v.some(x=>typeof x!=="string"||!x.trim()))throw 0;requestIds=v}catch{return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请先修复后再停用账号"},409)}}
 const result=Number(await command(env,["EVAL","local rr=redis.call('GET',KEYS[1]); local uu=redis.call('GET',KEYS[2]); if not rr or not uu then return 2 end; local r=cjson.decode(rr); local old=cjson.decode(uu); if old.disabled==true then return 3 end; if old.boundRouteId~=ARGV[3] or old.routeDuty~=ARGV[4] then return 4 end; local ids=cjson.decode(ARGV[5]); if type(ids)~='table' then return 5 end; for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local raw=redis.call('GET',k); if not raw then return 6 end; local ok,q=pcall(cjson.decode,raw); if not ok or type(q)~='table' then return 6 end; if q.id~=rid then return 7 end end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local raw=redis.call('GET',k); if raw then local q=cjson.decode(raw); if q.userId==old.id and q.status=='pending' then q.status='rejected'; q.reviewedAt=ARGV[6]; q.reviewedBy=ARGV[7]; redis.call('SET',k,cjson.encode(q)) end end end; return 1","2","zp:route:"+boundRouteId,"zp:user:"+id,JSON.stringify(nextRoute),JSON.stringify(nextUser),boundRouteId,u.routeDuty,JSON.stringify(requestIds),new Date().toISOString(),actor.id]));if(result===6||result===7)return json({success:false,code:"ROUTE_REQUEST_DATA_INVALID",error:"线路申请数据异常，请先修复后再停用账号"},409);if(result!==1)return json({success:false,code:"USER_DISABLE_STATE_CHANGED",error:"账号状态已发生变化，请刷新后重试"},409);return json({success:true,user:await safe(env,nextUser)})
}
if(action==="bind"||action==="unbind"||action==="delete"){
 if(action==="unbind"){const route=await getRoute(env,String(u.boundRouteId||""));if(!route)return json({success:false,error:"用户绑定数据异常"},409);try{const next=await atomicUnbind(env,route,u);return json({success:true,user:await safe(env,next)})}catch{return json({success:false,error:"解除绑定失败，请刷新后重试"},409)}}
 if(action==="bind"){const route=await getRoute(env,String(input.routeId||"")),duty=String(input.duty||"");if(!route||route.status!=="active")return json({success:false,error:"线路不存在或已停用"},409);if(!["driver","delivery"].includes(duty))return json({success:false,error:"岗位无效"},400);if(u.boundRouteId)return json({success:false,error:"用户已绑定线路"},409);try{const next=await atomicBind(env,route,u,duty);return json({success:true,user:await safe(env,next)})}catch(e){return json({success:false,error:e.message==="ROUTE_SLOT_OCCUPIED"?"线路岗位已被占用":"绑定状态已变化，请刷新后重试"},409)}}
 const requestIdList=await loadRequestIds(env);if(requestIdList===null)return json({success:false,code:"ROUTE_REQUEST_INDEX_INVALID",error:"线路申请索引数据异常，请先修复后再删除账号"},409);
 const route=await getRoute(env,String(u.boundRouteId||""));
 if(u.boundRouteId&&u.routeDuty){if(!route)return json({success:false,code:"BOUND_ROUTE_MISSING",error:"用户绑定线路不存在，无法安全删除账号"},409);if(u.routeDuty==="driver"&&route.driverUserId!==u.id)return json({success:false,code:"BOUND_ROUTE_INCONSISTENT",error:"用户与线路岗位绑定数据不一致，无法安全删除账号"},409);if(u.routeDuty==="delivery"&&route.deliveryUserId!==u.id)return json({success:false,code:"BOUND_ROUTE_INCONSISTENT",error:"用户与线路岗位绑定数据不一致，无法安全删除账号"},409)}
 let userIds;try{userIds=await ids(env)}catch{return json({success:false,code:"USER_INDEX_INVALID",error:"用户索引数据异常，请先修复后再删除账号"},409)}
 if(!userIds.includes(id))return json({success:false,code:"USER_INDEX_MISSING",error:"用户索引中不存在该账号，请先修复数据后再删除"},409);
 const usernameKey="zp:user:index:"+String(u.username).toLowerCase();const userKey="zp:user:"+id;const routeKey=route?"zp:route:"+route.id:"";
 const keys=routeKey?[routeKey,userKey,"zp:users:index"]:[userKey,"zp:users:index"];
 const args=routeKey?[JSON.stringify({...route,[u.routeDuty==="driver"?"driverUserId":"deliveryUserId"]:null}),id,JSON.stringify(userIds.filter(x=>x!==id)),u.routeDuty||"",route.id]:[id,JSON.stringify(userIds.filter(x=>x!==id))];
 const script=routeKey?"local rr=redis.call('GET',KEYS[1]); local uu=redis.call('GET',KEYS[2]); if not rr or not uu then return 2 end; local r=cjson.decode(rr); local u=cjson.decode(uu); if u.id~=ARGV[2] then return 3 end; if u.boundRouteId~=r.id or u.routeDuty~=ARGV[4] then return 4 end; local slot=ARGV[4]=='driver' and 'driverUserId' or 'deliveryUserId'; if r[slot]~=u.id then return 5 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); redis.call('DEL',KEYS[2]); return 1":"local uu=redis.call('GET',KEYS[1]); if not uu then return 2 end; local u=cjson.decode(uu); if u.id~=ARGV[1] then return 3 end; redis.call('SET',KEYS[2],ARGV[2]); redis.call('DEL',KEYS[1]); return 1";
 const code=Number(await command(env,["EVAL",script,String(keys.length),...keys,...args]));if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);
    await del(env,"user:index:"+String(u.username).toLowerCase());
    try{
      const requestsCleaned=await cleanupUserRequests(env,id);
      const sess=await cleanupUserSessions(env,id);
      return json({success:true,requestsCleaned,sessionsCleaned:sess.deleted,sessionsCleanupComplete:sess.complete});
    }catch(e){if(e?.code==="SUBREQUEST_BUDGET_EXCEEDED")return json({success:false,code:"USER_DELETE_CLEANUP_BUDGET",error:"账号已删除，但关联清理达到资源预算，请稍后重试清理"},503);throw e}
}
if(action==="rename"){const name=String(input.name||"").trim();if(!name)return json({success:false,error:"名称不能为空"},400);const nextName=name.slice(0,40);const code=Number(await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.role=='admin' then return 5 end; x.name=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(x)); return 1","1","zp:user:"+id,nextName,id]));if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);u.name=nextName;return json({success:true,user:await safe(env,u)})}return json({success:false,error:"不支持的操作"},400)}
