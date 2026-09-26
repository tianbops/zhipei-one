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
 try{return json({success:true,waybill:typeof raw==="string"?JSON.parse(raw):raw})}catch{return json({success:false,error:"今日运单数据异常"},500)}
}