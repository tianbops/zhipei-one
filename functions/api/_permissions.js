import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
export function isSystemAdmin(user){return !!user&&(user.role==="admin"||user.role==="system_admin")}
export function isBusinessUser(user){return !!user&&user.role!=="admin"&&user.role!=="system_admin"}
export async function requireBusinessUser(request,env){const user=await currentUser(request,env);if(!user)return {response:json({success:false,error:"未登录"},401),user:null};if(isSystemAdmin(user))return {response:json({success:false,error:"系统管理员不能进入配送业务"},403),user:null};return {response:null,user}}
export function canMaintainRoute(user,routeId){return isBusinessUser(user)&&user.boundRouteId===routeId&&(user.routeDuty==="driver"||user.routeDuty==="delivery")}
export function canUseRoute(user){return !!user&&!isSystemAdmin(user)}
export function canReadRouteData(user,routeId){return isBusinessUser(user)&&(canMaintainRoute(user,routeId)||user.dispatchRouteId===routeId)}
export function canManageBase(user,routeId){return canMaintainRoute(user,routeId)}
