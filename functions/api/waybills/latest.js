import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,command} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary;
export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const url=new URL(request.url),id=clean(url.searchParams.get("id")),routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:true,waybill:null});
 if(id){
  const raw=await get(env,"waybill:"+id);if(!raw)return json({success:true,waybill:null});
  try{const waybill=typeof raw==="string"?JSON.parse(raw):raw;if(!validWaybill(waybill)||waybill.routeId!==routeId)return json({success:true,waybill:null});return json({success:true,waybill})}catch{return json({success:false,code:"WAYBILL_DATA_INVALID",error:"运单数据异常"},500)}
 }
 const todayRaw=await get(env,"route:"+routeId+":orders:today");if(todayRaw){try{const todayWaybill=typeof todayRaw==="string"?JSON.parse(todayRaw):todayRaw;if(validWaybill(todayWaybill)&&todayWaybill.routeId===routeId&&todayWaybill.date===todayCN())return json({success:true,waybill:todayWaybill})}catch{}}
 const raw=await get(env,"route:"+routeId+":orders:latest");if(!raw)return json({success:true,waybill:null});
 try{const waybill=typeof raw==="string"?JSON.parse(raw):raw;if(!validWaybill(waybill))return json({success:true,waybill:null,code:"WAYBILL_LEGACY_DATA_IGNORED",message:"检测到旧版或异常今日运单数据，已忽略"});if(waybill.date!==todayCN())return json({success:true,waybill:null});await set(env,"route:"+routeId+":orders:today",waybill);return json({success:true,waybill})}catch{return json({success:false,code:"WAYBILL_LATEST_DATA_INVALID",error:"当日运单数据异常"},500)}
}