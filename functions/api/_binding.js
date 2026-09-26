import {command} from "./_redis.js";
function resultError(code){const e=new Error(code);e.status=409;return e}
export async function atomicBind(env,route,user,duty){
 const routeKey="zp:route:"+route.id,userKey="zp:user:"+user.id;
 const r={...route};const u={...user,boundRouteId:route.id,routeDuty:duty,sessionVersion:(user.sessionVersion??1)+1};
 if(duty==="driver")r.driverUserId=user.id;else r.deliveryUserId=user.id;
 const script="local r=cjson.decode(ARGV[1]); local u=cjson.decode(ARGV[2]); local cr=redis.call('GET',KEYS[1]); local cu=redis.call('GET',KEYS[2]); if not cr or not cu then return 2 end; local rr=cjson.decode(cr); local uu=cjson.decode(cu); if uu.boundRouteId then return 3 end; local slot=ARGV[3]; if slot=='driver' and rr.driverUserId and rr.driverUserId~=uu.id then return 4 end; if slot=='delivery' and rr.deliveryUserId and rr.deliveryUserId~=uu.id then return 5 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1";
 const code=await command(env,["EVAL",script,"2",routeKey,userKey,JSON.stringify(r),JSON.stringify(u),duty]);
 if(code!==1)throw resultError(code===3?"USER_ALREADY_BOUND":code===4||code===5?"ROUTE_SLOT_OCCUPIED":"BIND_STATE_CHANGED");
 return u;
}
export async function atomicUnbind(env,route,user){
 const routeKey="zp:route:"+route.id,userKey="zp:user:"+user.id;
 const r={...route};if(user.routeDuty==="driver"&&r.driverUserId===user.id)r.driverUserId=null;if(user.routeDuty==="delivery"&&r.deliveryUserId===user.id)r.deliveryUserId=null;
 const u={...user,boundRouteId:null,routeDuty:null,sessionVersion:(user.sessionVersion??1)+1};
 const script="local cr=redis.call('GET',KEYS[1]); local cu=redis.call('GET',KEYS[2]); if not cr or not cu then return 2 end; local rr=cjson.decode(cr); local uu=cjson.decode(cu); if uu.boundRouteId~=ARGV[3] then return 3 end; if uu.routeDuty~=ARGV[4] then return 4 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1";
 const code=await command(env,["EVAL",script,"2",routeKey,userKey,JSON.stringify(r),JSON.stringify(u),route.id,user.routeDuty]);
 if(code!==1)throw resultError("UNBIND_STATE_CHANGED");
 return u;
}
