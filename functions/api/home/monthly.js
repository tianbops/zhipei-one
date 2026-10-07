import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {pipeline,command} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {canReadWaybill} from "../_waybill-acl.js";
const clean=v=>String(v??"").trim();
const todayCN=()=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const o=Object.fromEntries(p.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));return `${o.year}-${o.month}-${o.day}`};
const indexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
const readable=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED"&&["PLANNED","CONFIRMED"].includes(x.stage);
const parseMonth=v=>{const m=/^(\d{4})-(\d{2})$/.exec(clean(v));if(!m)return null;const y=Number(m[1]),mo=Number(m[2]);return mo>=1&&mo<=12&&y>=2000&&y<=2100?{year:y,month:mo}:null};
const datesFor=(year,month,endDay)=>{const max=new Date(Date.UTC(year,month,0)).getUTCDate(),end=Math.max(0,Math.min(max,Number(endDay)||max));return Array.from({length:end},(_,i)=>`${year}-${String(month).padStart(2,"0")}-${String(i+1).padStart(2,"0")}`)};
async function loadDates(env,user,routeId,dates){
 if(!dates.length)return {days:[],waybills:0,totalWeight:0};
 const results=await pipeline(env,dates.map(date=>["SMEMBERS",indexKey(routeId,date)]));
 const idsByDate=results.map(r=>Array.isArray(r)?r.map(clean).filter(Boolean):[]);
 const ids=[...new Set(idsByDate.flat())];
 const raw=ids.length?await command(env,["MGET",...ids.map(id=>"zp:waybill:"+id) ]):[];
 const byId=new Map((Array.isArray(raw)?raw:[]).map(v=>{try{const x=typeof v==="string"?JSON.parse(v):v;return readable(x)?[x.id,x]:null}catch{return null}}).filter(Boolean));
 let total=0,totalWeight=0;
 const days=dates.map((date,i)=>{const list=(idsByDate[i]||[]).map(id=>byId.get(id)).filter(w=>w&&w.routeId===routeId&&w.date===date&&canReadWaybill(user,w,env));const weight=list.reduce((s,w)=>s+(Number(w.totalWeight)||0),0);total+=list.length;totalWeight+=weight;return {day:i+1,waybills:list.length,totalWeight:weight}});
 return {days,waybills:total,totalWeight};
}
export async function onRequestGet({request,env}){
 try{
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
  if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
  const routeId=clean(user.dispatchRouteId||user.boundRouteId);if(!routeId)return json({success:true,month:null,days:[],waybills:0,totalWeight:0});
  const today=todayCN(),[cy,cm,cd]=today.split("-").map(Number),url=new URL(request.url),view=clean(url.searchParams.get("view")).toLowerCase();
  if(view==="year"){
   const year=Number(url.searchParams.get("year"))||cy;if(year>cy)return json({success:true,view:"year",year,months:[],waybills:0,totalWeight:0});
   const months=[];let total=0,totalWeight=0;
   for(let mo=1;mo<=12;mo++){if(year===cy&&mo>cm)break;const end=year===cy&&mo===cm?cd:undefined;const d=await loadDates(env,user,routeId,datesFor(year,mo,end));total+=d.waybills;totalWeight+=d.totalWeight;months.push({month:mo,waybills:d.waybills,totalWeight:d.totalWeight})}
   return json({success:true,view:"year",year,months,waybills:total,totalWeight});
  }
  const target=parseMonth(url.searchParams.get("month"))||{year:cy,month:cm};
  if(target.year>cy||(target.year===cy&&target.month>cm))return json({success:true,month:null,days:[],waybills:0,totalWeight:0});
  const end=target.year===cy&&target.month===cm?cd:undefined,d=await loadDates(env,user,routeId,datesFor(target.year,target.month,end));
  return json({success:true,month:`${target.year}-${String(target.month).padStart(2,"0")}`,todayDay:end||d.days.length,daysInMonth:new Date(Date.UTC(target.year,target.month,0)).getUTCDate(),...d});
 }catch{return json({success:false,code:"MONTHLY_OVERVIEW_FAILED",error:"配送数据暂时无法读取"},500)}
}
