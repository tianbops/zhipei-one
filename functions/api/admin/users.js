import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,command} from "../_redis.js";
async function read(env,id){const raw=await get(env,"user:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
async function ids(env){const raw=await get(env,"users:index");if(!raw)return [];try{const v=typeof raw==="string"?JSON.parse(raw):raw;if(!Array.isArray(v))throw new Error("INVALID_INDEX");return v}catch(error){throw Object.assign(new Error("USER_INDEX_INVALID"),{code:"USER_INDEX_INVALID"})}}
async function saveIds(env,a){return set(env,"users:index",a)}
function safe(u){return {id:u.id,username:u.username,name:u.name||"",role:u.role||"user",disabled:!!u.disabled,boundRouteId:u.boundRouteId||null,routeDuty:u.routeDuty||null,createdAt:u.createdAt||null}}
export async function onRequestGet({request,env}){const actor=await currentUser(request,env);if(!actor||actor.role!=="admin")return json({success:false,error:"无权限"},403);let userIds;try{userIds=await ids(env)}catch{return json({success:false,code:"USER_INDEX_INVALID",error:"用户索引数据异常，请联系管理员处理"},409)}const list=[];for(const id of userIds){const u=await read(env,id);if(u)list.push(safe(u))}return json({success:true,users:list})}
export async function onRequestPost({request,env}){const actor=await currentUser(request,env);if(!actor||actor.role!=="admin")return json({success:false,error:"无权限"},403);const input=await body(request);const action=String(input.action||"");const id=String(input.userId||"");const u=await read(env,id);if(!u)return json({success:false,error:"用户不存在"},404);if(u.role==="admin")return json({success:false,error:"系统管理员账号不能通过此接口修改"},403);if(action==="disable"||action==="enable"){
 const disabling=action==="disable";
 if(!disabling){const key="zp:user:"+id;const next={...u,disabled:false,sessionVersion:(u.sessionVersion??1)+1};const code=Number(await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.disabled~=true then return 5 end; x.disabled=false; x.sessionVersion=(x.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(x)); return 1","1",key,id]));if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);next.disabled=false;next.sessionVersion=(u.sessionVersion??1)+1;return json({success:true,user:safe(next)})}
 const boundRouteId=String(u.boundRouteId||"").trim();
 if(!boundRouteId){u.disabled=true;u.sessionVersion=(u.sessionVersion??1)+1;await set(env,"user:"+id,u);return json({success:true,user:safe(u)})}
 const rawRoute=await get(env,"route:"+boundRouteId);
 if(!rawRoute)return json({success:false,code:"BOUND_ROUTE_MISSING",error:"用户绑定线路不存在，无法安全停用账号"},409);
 let route;try{route=typeof rawRoute==="string"?JSON.parse(rawRoute):rawRoute}catch{return json({success:false,code:"BOUND_ROUTE_INVALID",error:"用户绑定线路数据异常，无法安全停用账号"},409)}
 const nextRoute={...route};
 if(u.routeDuty==="driver"&&nextRoute.driverUserId===u.id)nextRoute.driverUserId=null;
 if(u.routeDuty==="delivery"&&nextRoute.deliveryUserId===u.id)nextRoute.deliveryUserId=null;
 const nextUser={...u,disabled:true,boundRouteId:null,routeDuty:null,sessionVersion:(u.sessionVersion??1)+1};
 const result=Number(await command(env,["EVAL","local rr=redis.call('GET',KEYS[1]); local uu=redis.call('GET',KEYS[2]); if not rr or not uu then return 2 end; local r=cjson.decode(rr); local old=cjson.decode(uu); if old.disabled==true then return 3 end; if old.boundRouteId~=ARGV[3] or old.routeDuty~=ARGV[4] then return 4 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1","2","zp:route:"+boundRouteId,"zp:user:"+id,JSON.stringify(nextRoute),JSON.stringify(nextUser),boundRouteId,u.routeDuty]));
 if(result!==1)return json({success:false,code:"USER_DISABLE_STATE_CHANGED",error:"账号状态已发生变化，请刷新后重试"},409);
 return json({success:true,user:safe(nextUser)})
}if(action==="rename"){const name=String(input.name||"").trim();if(!name)return json({success:false,error:"名称不能为空"},400);const nextName=name.slice(0,40);const code=Number(await command(env,["EVAL","local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.role=='admin' then return 5 end; x.name=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(x)); return 1","1","zp:user:"+id,nextName,id]));if(code!==1)return json({success:false,error:"账号状态已变化，请刷新后重试"},409);u.name=nextName;return json({success:true,user:safe(u)})}return json({success:false,error:"不支持的操作"},400)}
