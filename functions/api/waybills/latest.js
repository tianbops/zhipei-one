import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,set,command} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary;

async function writeIfNewer(env,key,waybill){
 const script=`local incoming=cjson.decode(ARGV[1]); local raw=redis.call("GET",KEYS[1]); if raw then local ok,current=pcall(cjson.decode,raw); if ok and type(current)=="table" and current.routeId==incoming.routeId and current.createdAt and incoming.createdAt and tostring(current.createdAt)>=tostring(incoming.createdAt) then return 0 end end; redis.call("SET",KEYS[1],ARGV[1]); return 1`;
 return command(env,["EVAL",script,"1","zp:"+key,JSON.stringify(waybill)]);
}

async function scanCurrentDay(env,routeId){
 let cursor="0",found=null;
 do{
  const r=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
  cursor=String(r?.[0]??"0");
  for(const key of (r?.[1]||[])){
   const v=await get(env,String(key).replace(/^zp:/,""));
   try{
    const w=typeof v==="string"?JSON.parse(v):v;
    if(validWaybill(w)&&w.routeId===routeId&&w.date===todayCN()&&(!found||String(w.createdAt||"")>String(found.createdAt||"")))found=w;
   }catch{}
  }
 }while(cursor!=="0");
 return found;
}

export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const url=new URL(request.url),id=clean(url.searchParams.get("id")),routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:true,waybill:null});
 if(id){
  const raw=await get(env,"waybill:"+id);if(!raw)return json({success:true,waybill:null});
  try{const waybill=typeof raw==="string"?JSON.parse(raw):raw;if(!validWaybill(waybill)||waybill.routeId!==routeId)return json({success:true,waybill:null});return json({success:true,waybill})}catch{return json({success:false,code:"WAYBILL_DATA_INVALID",error:"运单数据异常"},500)}
 }
 const repairKey="route:"+routeId+":orders:index-repair";
 const repairInvalidKey=repairKey+":invalid";
 const repair=await command(env,["SMEMBERS","zp:"+repairKey]);
 if(Array.isArray(repair)&&repair.length){
  for(const repairId of repair){
   const repairIdClean=clean(repairId);
   const rawRepair=await get(env,"waybill:"+repairIdClean);
   let w=null;
   try{w=typeof rawRepair==="string"?JSON.parse(rawRepair):rawRepair}catch{}
   if(!validWaybill(w)||w.routeId!==routeId){
    await command(env,["HSET","zp:"+repairInvalidKey,repairIdClean,JSON.stringify({status:"INVALID",waybillId:repairIdClean,routeId,reason:rawRepair?"INVALID_WAYBILL":"WAYBILL_MISSING",markedAt:new Date().toISOString()})]).catch(()=>{});
    await command(env,["SREM","zp:"+repairKey,repairIdClean]).catch(()=>{});
    continue;
   }
   try{
    await writeIfNewer(env,"route:"+routeId+":orders:latest",w);
    if(w.date===todayCN())await writeIfNewer(env,"route:"+routeId+":orders:today",w);
    await command(env,["SREM","zp:"+repairKey,repairIdClean]);
   }catch{}
  }
 }
 const todayRaw=await get(env,"route:"+routeId+":orders:today");
 let todayWaybill=null;
 if(todayRaw){try{const x=typeof todayRaw==="string"?JSON.parse(todayRaw):todayRaw;if(validWaybill(x)&&x.routeId===routeId&&x.date===todayCN())todayWaybill=x}catch{}}
 const raw=await get(env,"route:"+routeId+":orders:latest");
 if(raw){
  try{
   const latestWaybill=typeof raw==="string"?JSON.parse(raw):raw;
   if(validWaybill(latestWaybill)&&latestWaybill.routeId===routeId&&latestWaybill.date===todayCN()){
    if(!todayWaybill||String(latestWaybill.createdAt||"")>String(todayWaybill.createdAt||"")){
     try{await writeIfNewer(env,"route:"+routeId+":orders:today",latestWaybill);return json({success:true,waybill:latestWaybill})}
     catch{return json({success:true,waybill:latestWaybill,indexSync:"DEFERRED"})}
    }
   }
  }catch{}
 }
 if(todayWaybill)return json({success:true,waybill:todayWaybill});
 const found=await scanCurrentDay(env,routeId);
 if(found){
  try{
   await writeIfNewer(env,"route:"+routeId+":orders:today",found);
   await writeIfNewer(env,"route:"+routeId+":orders:latest",found);
   return json({success:true,waybill:found,indexSync:"REPAIRED"});
  }catch{return json({success:true,waybill:found,indexSync:"DEFERRED"})}
 }
 return json({success:true,waybill:null});
}
