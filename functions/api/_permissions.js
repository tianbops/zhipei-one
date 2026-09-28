import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
export async function requireBusinessUser(request,env){const user=await currentUser(request,env);if(!user)return {response:json({success:false,error:"未登录"},401),user:null};if(user.role==="admin")return {response:json({success:false,error:"系统管理员不能进入配送业务"},403),user:null};return {response:null,user}}
export function canMaintainRoute(user,routeId){return !!user&&user.role!=="admin"&&user.boundRouteId===routeId&&(user.routeDuty==="driver"||user.routeDuty==="delivery")}
export function canUseRoute(user){return !!user&&user.role!=="admin"}
export function canManageBase(user,routeId){return canMaintainRoute(user,routeId)}
