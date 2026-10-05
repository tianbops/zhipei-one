import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";

export async function onRequestPost({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务线路绑定"},403);
 const userKey="zp:user:"+user.id;
 const routeId=String(user.boundRouteId||"").trim();
 if(!routeId||!["driver","delivery"].includes(user.routeDuty))return json({success:false,code:"USER_BINDING_INCONSISTENT",error:"当前账号绑定数据异常，请联系管理员处理"},409);
 const routeKey="zp:route:"+routeId;
 const script="local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); if not cu or not cr then return 2 end; local oku,u=pcall(cjson.decode,cu); local okr,r=pcall(cjson.decode,cr); if not oku or type(u)~='table' or not okr or type(r)~='table' then return 10 end; if u.id~=ARGV[1] or u.boundRouteId~=r.id or (u.routeDuty~='driver' and u.routeDuty~='delivery') then return 3 end; if u.routeDuty=='driver' then if r.driverUserId~=u.id then return 4 end; r.driverUserId=nil else if r.deliveryUserId~=u.id then return 5 end; r.deliveryUserId=nil end; u.boundRouteId=nil; u.routeDuty=nil; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); redis.call('SET',KEYS[2],cjson.encode(r)); return 1";
 const code=Number(await command(env,["EVAL",script,"2",userKey,routeKey,user.id]));
 if(code===2)return json({success:false,code:"BIND_DATA_MISSING",error:"绑定数据不存在，请联系管理员处理"},409);
 if(code===3||code===4||code===5)return json({success:false,code:"ROUTE_BINDING_INCONSISTENT",error:"用户与线路绑定状态不一致，请联系管理员处理"},409);
 if(code===10)return json({success:false,code:"BIND_DATA_INVALID",error:"用户或线路数据异常，请联系管理员处理"},409);
 if(code!==1)return json({success:false,code:"UNBIND_FAILED",error:"解绑失败，请稍后重试"},409);
 return json({success:true,binding:{boundRouteId:null,routeDuty:null},sessionVersion:Number(user.sessionVersion??1)+1});
}
