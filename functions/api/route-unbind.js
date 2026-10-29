import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {getRoute} from "./_route.js";
import {atomicUnbind} from "./_binding.js";
export async function onRequestPost({request,env}){const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);if(!user.boundRouteId)return json({success:false,error:"当前没有绑定线路"},409);const route=await getRoute(env,user.boundRouteId);if(!route)return json({success:false,error:"线路不存在"},404);const updated=await atomicUnbind(env,route,user);return json({success:true,user:{id:updated.id,boundRouteId:null,routeDuty:null}})}
