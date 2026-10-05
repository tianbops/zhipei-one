import {json,body} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {getRoute} from "./_route.js";
import {canUseRoute} from "./_permissions.js";

// 临时用户采用每人独立的临时线路（routeId = __temp__:<userId>），
// 与正式线路共用同一索引结构（zp:route:<routeId>:waybills:<date>），
// 因此不同临时用户的运单数据天然隔离，不会互相读取、误删或误确认。
// 各临时用户共享全局学习库（learnGlobal）提升识别准确率。
export const TEMP_ROUTE_PREFIX="__temp__:";
export function isTempRoute(routeId){return !!routeId&&typeof routeId==="string"&&routeId.startsWith(TEMP_ROUTE_PREFIX)}

export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务调度"},403);
 const routeId=user.dispatchRouteId||null;
 let routeInfo=null;
 if(routeId){
  if(isTempRoute(routeId))routeInfo={id:routeId,name:"临时用户",type:"temporary"};
  else{const route=await getRoute(env,routeId);if(route&&route.status==="active")routeInfo={id:route.id,name:route.name,type:"route"}}
 }
 // 未选择调度线路且无业务线路绑定的用户（含新注册用户），自动分配独立的临时线路，
 // 保证所有用户都有可用调度线路，同时不与他人共享运单数据。
 if(!routeInfo&&!user.dispatchRouteId&&!user.boundRouteId){
  const tempId=TEMP_ROUTE_PREFIX+user.id;
  const script=`local raw=redis.call("GET",KEYS[1]);if not raw then return -1 end;local ok,u=pcall(cjson.decode,raw);if not ok or type(u)~="table" then return -2 end;if u.id~=ARGV[1] or u.disabled==true or u.role=="admin" then return -3 end;u.dispatchRouteId=ARGV[2];redis.call("SET",KEYS[1],cjson.encode(u));return 1`;
  const result=await command(env,["EVAL",script,"1","zp:user:"+user.id,user.id,tempId]);
  if(Number(result)===1)routeInfo={id:tempId,name:"临时用户",type:"temporary"};
 }
 return json({success:true,dispatchRoute:routeInfo});
}

export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务调度"},403);
 const input=await body(request);
 const routeId=String(input.routeId||"").trim();
 if(!routeId)return json({success:false,error:"请选择调度线路"},400);
 if(isTempRoute(routeId))return json({success:false,error:"临时线路无需手动选择，已自动分配"},400);
 const route=await getRoute(env,routeId);
 if(!route||route.status!=="active")return json({success:false,error:"线路不存在或已停用"},404);
 const script=`local raw=redis.call("GET",KEYS[1]);if not raw then return -1 end;local ok,u=pcall(cjson.decode,raw);if not ok or type(u)~="table" then return -2 end;if u.id~=ARGV[1] or u.disabled==true or u.role=="admin" then return -3 end;u.dispatchRouteId=ARGV[2];redis.call("SET",KEYS[1],cjson.encode(u));return 1`;
 const result=await command(env,["EVAL",script,"1","zp:user:"+user.id,user.id,routeId]);
 if(Number(result)===-1||Number(result)===-3)return json({success:false,error:"用户状态已变化，请重新登录"},409);
 if(Number(result)===-2)return json({success:false,error:"用户数据异常"},409);
 return json({success:true,dispatchRoute:{id:route.id,name:route.name,type:"route"}});
}
