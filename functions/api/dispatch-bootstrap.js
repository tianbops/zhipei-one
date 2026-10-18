import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {canUseRoute} from "./_permissions.js";
import {readRoutes} from "./routes.js";
import {resolveDispatchRoute} from "./dispatch.js";
import {guard} from "./_safe.js";

/* 线路页聚合接口：一次往返同时返回「调度线路」与「可选线路列表」。
 * 历史：页面 Promise.all([/api/routes,/api/dispatch])——两次 Worker 调用、
 * 两次 currentUser（各 2 次 Redis 往返）、两次 HTTP RTT；弱网下任一挂起
 * 整个页面就停在「读取中」（已由前端 10s 超时兜底，但根因是两次往返）。
 * 实时性语义不变：/api/* 本就永不进 SW 缓存，聚合不改变数据新鲜度。
 * 错误契约：未登录 401；管理员 403（与 /api/dispatch 一致）；
 * 线路数据异常 409（与 /api/routes 一致，消息逐字相同）。 */
async function bootstrapGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(!canUseRoute(user))return json({success:false,error:"管理员不参与业务调度"},403);
 let routesResult;
 try{
  routesResult=await readRoutes(env,user);
 }catch(e){
  if(e&&(e.code==="ROUTES_INDEX_INVALID"||e.code==="ROUTE_DATA_INVALID"))return json({success:false,code:e.code,error:e.message||"线路数据异常，请联系管理员处理"},409);
  throw e;
 }
 const dispatchRoute=await resolveDispatchRoute(env,user);
 return json({success:true,dispatchRoute,routes:routesResult.routes});
}
export const onRequestGet=guard(bootstrapGet,"DISPATCH_BOOTSTRAP_FAILED");
