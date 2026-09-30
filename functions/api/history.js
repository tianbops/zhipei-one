import {json} from "./_json.js";
import {currentUser} from "./_auth.js";
import {get,command} from "./_redis.js";
import {canUseRoute} from "./_permissions.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const addMonths=(date,months)=>{
 const [y,m,d]=date.split("-").map(Number);
 const x=new Date(Date.UTC(y,m-1,1));
 x.setUTCMonth(x.getUTCMonth()+months);
 const last=new Date(Date.UTC(x.getUTCFullYear(),x.getUTCMonth()+1,0)).getUTCDate();
 x.setUTCDate(Math.min(d,last));
 return x.toISOString().slice(0,10);
};
const startOfYear=date=>date.slice(0,4)+"-01-01";
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary&&x.stage==="CONFIRMED";
const historyKey=(routeId,date)=>"zp:route:"+routeId+":history:"+date;

async function readWaybill(env,id){
 const raw=await get(env,"waybill:"+id);
 if(!raw)return null;
 try{const x=typeof raw==="string"?JSON.parse(raw):raw;return validWaybill(x)?x:null}catch{return null}
}

async function readHistoryIds(env,routeId){
 const ids=[];
 let cursor="0";
 do{
  const r=await command(env,["SCAN",cursor,"MATCH","zp:route:"+routeId+":history:*","COUNT","100"]);
  cursor=String(r?.[0]??"0");
  const prefix="zp:route:"+routeId+":history:";
  for(const key of (r?.[1]||[])){
   const text=String(key);if(!text.startsWith(prefix))continue;
   const date=text.slice(prefix.length);if(/^\d{4}-\d{2}-\d{2}$/.test(date))ids.push({date,key:text});
  }
 }while(cursor!=="0");
 return ids;
}

export async function onRequestGet({request,env}){
 const user=await currentUser(request,env);
 if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const url=new URL(request.url);
 const routeId=clean(url.searchParams.get("routeId")||user.dispatchRouteId||user.boundRouteId);
 const date=clean(url.searchParams.get("date"));
 if(!routeId)return json({success:true,routeId:null,months:[],history:[]});
 if(routeId!==(clean(user.dispatchRouteId)||clean(user.boundRouteId)))return json({success:false,error:"无权查看该线路历史"},403);

 if(date){
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(date))return json({success:false,code:"DATE_INVALID",error:"日期格式错误"},400);
  const id=await get(env,historyKey(routeId,date));
  if(!id)return json({success:true,routeId,date,waybill:null});
  const waybill=await readWaybill(env,clean(id));
  if(!waybill||waybill.routeId!==routeId||waybill.date!==date){
   await command(env,["DEL",historyKey(routeId,date)]).catch(()=>{});
   return json({success:true,routeId,date,waybill:null,indexSync:"INVALID_REMOVED"});
  }
  return json({success:true,routeId,date,waybill});
 }

 const today=todayCN();
 const start=startOfYear(today);
 const end=addMonths(today,1);
 const entries=await readHistoryIds(env,routeId);
 const dates=[];
 for(const entry of entries){
  if(entry.date<start||entry.date>end)continue;
  const id=await get(env,entry.key);
  if(!id)continue;
  const waybill=await readWaybill(env,clean(id));
  if(!waybill||waybill.routeId!==routeId||waybill.date!==entry.date){
   await command(env,["DEL",entry.key]).catch(()=>{});
   continue;
  }
  dates.push({
   date:entry.date,
   waybillId:waybill.id,
   storeCount:Number(waybill.summary?.total)||waybill.stores.length,
   totalWeight:Number(waybill.totalWeight)||0
  });
 }
 dates.sort((a,b)=>b.date.localeCompare(a.date));
 const monthMap=new Map();
 for(const item of dates){
  const month=item.date.slice(0,7);
  const current=monthMap.get(month)||{month,days:0,totalStores:0,totalWeight:0};
  current.days++;
  current.totalStores+=item.storeCount;
  current.totalWeight+=item.totalWeight;
  monthMap.set(month,current);
 }
 return json({
  success:true,
  routeId,
  range:{start,end},
  months:[...monthMap.values()],
  history:dates
 });
}
