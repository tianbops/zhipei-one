import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {canUseRoute} from "./_permissions.js";
import {resolveDispatchRoute} from "./dispatch.js";
import {guard} from "./_safe.js";

/* 首页聚合接口：一次往返同时返回「调度线路」与「当前用户」。
 * 历史：loadHome Promise.all([/api/dispatch,/api/me])——两次 Worker 调用、
 * 两次 currentUser。合并后鉴权只做一次，用户字段与 /api/me 逐字一致，
 * 调度线路解析复用 resolveDispatchRoute（与 /api/dispatch 同一实现）。
 * 实时性语义不变：/api/* 本就永不进 SW 缓存。 */
async function bootstrapGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务调度"},403);
 const dispatchRoute=await resolveDispatchRoute(env,user);
 return json({success:true,dispatchRoute,user:{
  id:user.id,
  username:user.username,
  role:user.role||"user",
  name:user.name||"",
  boundRouteId:user.boundRouteId||null,
  routeDuty:user.routeDuty||null,
  dispatchRouteId:user.dispatchRouteId||null,
  disabled:!!user.disabled
 }});
}
export const onRequestGet=guard(bootstrapGet,"HOME_BOOTSTRAP_FAILED");
