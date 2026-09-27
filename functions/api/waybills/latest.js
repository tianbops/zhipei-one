import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
const clean=v=>String(v??"").trim();
export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:true,waybill:null});
 const raw=await get(env,"route:"+routeId+":orders:latest");if(!raw)return json({success:true,waybill:null});
 try{const waybill=typeof raw==="string"?JSON.parse(raw):raw;if(!waybill||waybill.schemaVersion!=="2"||typeof waybill.id!=="string"||typeof waybill.routeId!=="string"||!Array.isArray(waybill.stores)||!waybill.summary)return json({success:true,waybill:null,code:"WAYBILL_LEGACY_DATA_IGNORED",message:"检测到旧版或异常今日运单数据，已忽略"},200);return json({success:true,waybill})}catch{return json({success:false,code:"WAYBILL_LATEST_DATA_INVALID",error:"今日运单数据异常"},500)}
}