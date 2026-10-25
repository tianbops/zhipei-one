import {json} from "./_json.js";
import {guard} from "./_safe.js";
import {currentUser} from "./_auth.js";
// guard：给响应补 Server-Timing: app;dur=<ms> 与 X-ZP-Request-Id。
// /api/me 是每次进页面都要打的接口，诊断面板里它的服务端耗时一直是空的（没上报计时头），
// 只能看到「客户端 2s、服务端未知」，分不清是后端慢还是网络慢。包一层不影响任何业务返回。
const handleMe=guard(async ({request,env})=>{
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 return json({success:true,user:{
  id:user.id,
  username:user.username,
  role:user.role||"user",
  name:user.name||"",
  boundRouteId:user.boundRouteId||null,
  routeDuty:user.routeDuty||null,
  dispatchRouteId:user.dispatchRouteId||null,
  disabled:!!user.disabled
 }});
},"ACCOUNT_ME_FAILED");

/**
 * GET /api/me —— 取当前登录用户（会话 Cookie 校验）。
 * 未登录返回 401；页面靠它判断要不要跳登录页，管理端 boot 靠它确认 admin 角色。
 * 同样导出成函数形式，避免端点从 API 文档里消失（原因见 login.js 的同名注释）。
 */
export async function onRequestGet(ctx){return handleMe(ctx)}
