import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {pipeline,command} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";
import {canReadWaybill} from "./_waybill-acl.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>{
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const values=Object.fromEntries(parts.filter(p=>p.type!=="literal").map(p=>[p.type,p.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const indexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;
const readable=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.historyStatus!=="SUPERSEDED"&&["PLANNED","CONFIRMED"].includes(x.stage);

export async function onRequestGet({request,env}){
  try{
    const user=await currentUser(request,env);
    if(!user)return json({success:false,error:"未登录"},401);
    if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
    const routeId=clean(user.dispatchRouteId||user.boundRouteId);
    if(!routeId)return json({success:true,month:null,days:[],waybills:0,totalWeight:0});

    const today=todayCN(),[year,month]=today.split("-").map(Number),daysInMonth=new Date(Date.UTC(year,month,0)).getUTCDate(),todayDay=Number(today.slice(8,10));
    const dates=Array.from({length:todayDay},(_,i)=>`${year}-${String(month).padStart(2,"0")}-${String(i+1).padStart(2,"0")}`);
    const results=await pipeline(env,dates.map(date=>["SMEMBERS",indexKey(routeId,date)]));
    const idsByDate=results.map(r=>Array.isArray(r)?r.map(clean).filter(Boolean):[]);
    const allIds=[...new Set(idsByDate.flat())];
    let rawList=[];
    if(allIds.length)rawList=await command(env,["MGET",...allIds.map(id=>"zp:waybill:"+id)]);
    const byId=new Map((Array.isArray(rawList)?rawList:[]).map(raw=>{
      try{const x=typeof raw==="string"?JSON.parse(raw):raw;return readable(x)?[x.id,x]:null}catch{return null}
    }).filter(Boolean));
    let total=0,totalWeight=0;
    const days=dates.map((date,i)=>{
      const list=(idsByDate[i]||[]).map(id=>byId.get(id)).filter(w=>w&&w.routeId===routeId&&w.date===date&&canReadWaybill(user,w,env));
      const weight=list.reduce((sum,w)=>sum+(Number(w.totalWeight)||0),0);
      total+=list.length;totalWeight+=weight;
      return {day:i+1,waybills:list.length,totalWeight:weight};
    });
    return json({success:true,month:`${year}-${String(month).padStart(2,"0")}`,todayDay,daysInMonth,days,waybills:total,totalWeight});
  }catch(e){
    return json({success:false,code:"MONTHLY_OVERVIEW_FAILED",error:"本月配送数据暂时无法读取"},500);
  }
}
