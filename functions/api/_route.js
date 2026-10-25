import {get,set} from "./_redis.js";
export async function getRoute(env,id){const raw=await get(env,"route:"+id);if(!raw)return null;try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}}
export async function saveRoute(env,route){return set(env,"route:"+route.id,route)}
export function routeId(){return "route_"+crypto.randomUUID().replace(/-/g,"")}
export function cleanRouteName(value){return String(value||"").trim().replace(/\s+/g," ").slice(0,40)}
export function validDuty(value){return value==="driver"||value==="delivery"}
/* 线路名自然序比较（升序）：连续数字段按数值比——"2号线" < "10号线" < "17号线"
   （纯字典序会把 "10号线" 排到 "2号线" 前，不符合「线路排列升序」的直觉）；
   非数字段按 UTF-16 码元比；段数不同者短者在前。数字段数值相等但原串不同
   （如 "01" vs "1"）时按原串收尾，保证任何输入下顺序确定。 */
export function compareRouteName(a,b){
 const as=String(a==null?"":a),bs=String(b==null?"":b);
 const at=as.match(/\d+|\D+/g)||[],bt=bs.match(/\d+|\D+/g)||[];
 const n=Math.min(at.length,bt.length);
 for(let i=0;i<n;i++){
  const x=at[i],y=bt[i];
  if(x===y)continue;
  if(/^\d/.test(x)&&/^\d/.test(y)){
   const nx=Number(x),ny=Number(y);
   if(nx!==ny)return nx<ny?-1:1;
   return x<y?-1:1;
  }
  return x<y?-1:1;
 }
 if(at.length!==bt.length)return at.length<bt.length?-1:1;
 return 0;
}
export async function ensureUserUnbound(env,user){if(user?.boundRouteId)throw Object.assign(new Error("USER_ALREADY_BOUND"),{status:409})}
export async function ensureSlotFree(env,route,duty,userId){const key=duty==="driver"?"driverUserId":"deliveryUserId";if(route?.[key]&&route[key]!==userId)throw Object.assign(new Error("ROUTE_SLOT_OCCUPIED"),{status:409})}
