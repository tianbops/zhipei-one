import {json,body} from "../_json.js";
import {currentUser} from "../_auth.js";
import {command,pipeline} from "../_redis.js";

function admin(u){return u&&(u.role==="system_admin"||u.role==="admin")}
function clean(v){return String(v??"").trim()}

async function readWaybills(env,ids){
 const out=[];
 for(let i=0;i<ids.length;i+=50){
  const chunk=ids.slice(i,i+50);
  const raw=await pipeline(env,chunk.map(id=>["GET","zp:waybill:"+id]));
  for(const value of raw){
   if(!value)continue;
   try{const w=typeof value==="string"?JSON.parse(value):value;if(w&&typeof w==="object")out.push(w)}catch{}
  }
 }
 return out;
}

async function scanWaybillIds(env,routeId,start,end){
 let cursor="0";
 const ids=[];
 do{
  const result=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","500"]);
  if(!Array.isArray(result)||result.length<2)throw new Error("REDIS_SCAN_INVALID");
  cursor=String(result[0]??"0");
  const keys=Array.isArray(result[1])?result[1]:[];
  const candidates=keys.map(k=>String(k)).filter(k=>k.startsWith("zp:waybill:"));
  if(candidates.length){
   const values=await pipeline(env,candidates.map(key=>["GET",key]));
   for(let i=0;i<values.length;i++){
    const value=values[i];
    if(!value)continue;
    try{
     const w=typeof value==="string"?JSON.parse(value):value;
     if(w&&typeof w==="object"&&typeof w.id==="string"&&typeof w.routeId==="string"&&typeof w.date==="string"&&
        w.routeId===routeId&&/^\d{4}-\d{2}-\d{2}$/.test(w.date)&&w.date>=start&&w.date<=end&&
        (w.stage==="PLANNED"||w.stage==="CONFIRMED")&&w.historyStatus!=="SUPERSEDED"){
      ids.push(w.id);
     }
    }catch{}
   }
  }
 }while(cursor!=="0");
 return [...new Set(ids)];
}

async function repair(env,routeId,start,end){
 const ids=await scanWaybillIds(env,routeId,start,end);
 const waybills=await readWaybills(env,ids);
 const commands=[];
 for(const w of waybills){
  if(w.routeId!==routeId||!/^\d{4}-\d{2}-\d{2}$/.test(String(w.date)))continue;
  if(String(w.date)<start||String(w.date)>end)continue;
  commands.push(["SADD","zp:route:"+routeId+":history:"+w.date,w.id]);
 }
 for(let i=0;i<commands.length;i+=100)await pipeline(env,commands.slice(i,i+100));
 return {scannedIds:ids.length,loadedWaybills:waybills.length,indexed:commands.length};
}

export async function onRequestPost({request,env}){
 try{
  const actor=await currentUser(request,env);
  if(!admin(actor))return json({success:false,code:"PERMISSION_DENIED",error:"无权限"},403);
  const input=await body(request);
  const routeId=clean(input.routeId);
  const start=clean(input.start)||"2026-01-01";
  const end=clean(input.end)||"2026-12-31";
  if(!routeId)return json({success:false,code:"ROUTE_REQUIRED",error:"缺少线路"},400);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return json({success:false,code:"INVALID_RANGE",error:"日期范围无效"},400);
  const result=await repair(env,routeId,start,end);
  return json({success:true,routeId,range:{start,end},...result});
 }catch(e){
  return json({success:false,code:"HISTORY_REPAIR_FAILED",error:"历史索引恢复失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,240)},500);
 }
}
