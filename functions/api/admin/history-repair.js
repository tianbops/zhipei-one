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

async function repair(env,routeId,start,end){
 const script='local cursor="0"; local out={}; repeat local scan=redis.call("SCAN",cursor,"MATCH","zp:waybill:*","COUNT","500"); cursor=tostring(scan[1] or "0"); for _,key in ipairs(scan[2] or {}) do local raw=redis.call("GET",key); if raw then local ok,w=pcall(cjson.decode,raw); if ok and type(w)=="table" and type(w.id)=="string" and type(w.routeId)=="string" and type(w.date)=="string" and w.routeId==ARGV[1] and w.date>=ARGV[2] and w.date<=ARGV[3] and (w.stage=="PLANNED" or w.stage=="CONFIRMED") and w.historyStatus~="SUPERSEDED" then table.insert(out,w.id) end end end end until cursor=="0"; return out';
 const raw=await command(env,["EVAL",script,"0",routeId,start,end]);
 const ids=[...new Set((Array.isArray(raw)?raw:[]).map(clean).filter(Boolean))];
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
