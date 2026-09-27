import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {canUseRoute} from "../_permissions.js";

// Legacy compatibility endpoint intentionally disabled in the new architecture.
// The new version uses POST /api/waybills/process for the complete pipeline.
export async function onRequestPost({request,env}){
  const user=await currentUser(request,env);
  if(!user)return json({success:false,code:"AUTH_REQUIRED",error:"未登录"},401);
  if(user.role==="admin"||!canUseRoute(user))return json({success:false,code:"PERMISSION_DENIED",error:"无权限处理运单"},403);
  return json({success:false,code:"WAYBILL_LEGACY_ENDPOINT_DISABLED",error:"旧版运单接口已停用，请使用新的运单处理流程"},410);
}
