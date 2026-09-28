import {get,set} from "./_redis.js";
export async function getRoute(env,id){const raw=await get(env,"route:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
export async function saveRoute(env,route){return set(env,"route:"+route.id,route)}
export function routeId(){return "route_"+crypto.randomUUID().replace(/-/g,"")}
export function cleanRouteName(value){return String(value||"").trim().replace(/\s+/g," ").slice(0,40)}
export function validDuty(value){return value==="driver"||value==="delivery"}
export async function ensureUserUnbound(env,user){if(user?.boundRouteId)throw Object.assign(new Error("USER_ALREADY_BOUND"),{status:409})}
export async function ensureSlotFree(env,route,duty,userId){const key=duty==="driver"?"driverUserId":"deliveryUserId";if(route?.[key]&&route[key]!==userId)throw Object.assign(new Error("ROUTE_SLOT_OCCUPIED"),{status:409})}
