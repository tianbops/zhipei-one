import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,del,command} from "../_redis.js";
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
 const repairKey="route:"+routeId+":orders:index-repair";
 const repair=await command(env,["SMEMBERS","zp:"+repairKey]);
 if(Array.isArray(repair)&&repair.length){
  let repairedAny=false;
  for(const repairId of repair){
   const rawRepair=await get(env,"waybill:"+clean(repairId));
   let w=null;
   try{w=typeof rawRepair==="string"?JSON.parse(rawRepair):rawRepair}catch{}
   if(!validWaybill(w)||w.routeId!==routeId)continue;
   try{
    const currentLatestRaw=await get(env,"route:"+routeId+":orders:latest");
    let currentLatest=null;try{currentLatest=typeof currentLatestRaw==="string"?JSON.parse(currentLatestRaw):currentLatestRaw}catch{}
    if(!validWaybill(currentLatest)||currentLatest.routeId!==routeId||String(w.createdAt||"")>String(currentLatest.createdAt||""))await set(env,"route:"+routeId+":orders:latest",w);
    if(w.date===todayCN()){
     const currentTodayRaw=await get(env,"route:"+routeId+":orders:today");
     let currentToday=null;try{currentToday=typeof currentTodayRaw==="string"?JSON.parse(currentTodayRaw):currentTodayRaw}catch{}
     if(!validWaybill(currentToday)||currentToday.routeId!==routeId||String(w.createdAt||"")>String(currentToday.createdAt||""))await set(env,"route:"+routeId+":orders:today",w);
    }
    await command(env,["SREM","zp:"+repairKey,clean(repairId)]);
    repairedAny=true;
   }catch{}
  }
 }
 const todayRaw=await get(env,"route:"+routeId+":orders:today");
 let todayWaybill=null;if(todayRaw){try{const x=typeof todayRaw==="string"?JSON.parse(todayRaw):todayRaw;if(validWaybill(x)&&x.routeId===routeId&&x.date===todayCN())todayWaybill=x}catch{}}
 const raw=await get(env,"route:"+routeId+":orders:latest");
 if(raw){try{const latestWaybill=typeof raw==="string"?JSON.parse(raw):raw;if(validWaybill(latestWaybill)&&latestWaybill.routeId===routeId&&latestWaybill.date===todayCN()){if(!todayWaybill||String(latestWaybill.createdAt||"")>String(todayWaybill.createdAt||"")){try{await set(env,"route:"+routeId+":orders:today",latestWaybill);return json({success:true,waybill:latestWaybill})}catch{return json({success:true,waybill:latestWaybill,indexSync:"DEFERRED"})}}}}catch{}}
 if(todayWaybill)return json({success:true,waybill:todayWaybill});
 const found=await scanCurrentDay();
 if(found){try{await set(env,"route:"+routeId+":orders:today",found);await set(env,"route:"+routeId+":orders:latest",found);return json({success:true,waybill:found,indexSync:"REPAIRED"})}catch{return json({success:true,waybill:found,indexSync:"DEFERRED"})}}
 return json({success:true,waybill:null});
}
