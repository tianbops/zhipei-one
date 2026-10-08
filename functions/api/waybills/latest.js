import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,command,pipeline} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {canReadWaybill} from "../_waybill-acl.js";
import {getRoute} from "../_route.js";
import {guard} from "../_safe.js";

const clean=v=>String(v??"").trim();
const todayCN=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const validWaybill=x=>!!x&&x.schemaVersion==="2"&&typeof x.id==="string"&&typeof x.routeId==="string"&&Array.isArray(x.stores)&&!!x.summary;
const activeWaybill=x=>validWaybill(x)&&x.historyStatus!=="SUPERSEDED";
const effectiveWaybill=x=>activeWaybill(x)&&x.stage==="CONFIRMED";
const waybillIndexKey=(routeId,date)=>"zp:route:"+routeId+":waybills:"+date;

async function latestGet({request,env}){
 const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
 if(user.role==="admin"||!canUseRoute(user))return json({success:false,error:"无权查看配送业务"},403);
 const url=new URL(request.url),id=clean(url.searchParams.get("id")),confirmedOnly=url.searchParams.get("confirmed")==="1",routeId=clean(user.dispatchRouteId||user.boundRouteId);
 if(!routeId)return json({success:true,waybill:null});
 const route=await getRoute(env,routeId);const routeName=clean(route?.name)||"临时";
 async function withRouteData(w){
  if(!w)return w;
  w.routeName=clean(w.routeName)||routeName;
  if(!Array.isArray(w.stores)||!w.stores.length)return w;
  try{
   const rawBase=await get(env,"route:"+routeId+":base");
   const parsed=typeof rawBase==="string"?JSON.parse(rawBase):rawBase;
   const baseStores=Array.isArray(parsed?.stores)?parsed.stores:[];
   const byId=new Map(baseStores.map(s=>[clean(s?.storeId),s]).filter(x=>x[0]));
   const baseKey=v=>clean(v).normalize("NFKC").replace(/s+/g,"").replace(/[，。；;：:、（）()【】[]{}<>《》“”"'‘’]/g,"").toLowerCase();
   const byName=new Map();
   for(const bs of baseStores)for(const field of [bs?.name,bs?.originalName,...(Array.isArray(bs?.aliases)?bs.aliases:[])]){
    const key=baseKey(field);if(key&&!byName.has(key))byName.set(key,bs);
   }
   w.stores=w.stores.map(s=>{
    const baseStore=byId.get(clean(s?.storeId))||byName.get(baseKey(s?.name||s?.rawName))||null;
    if(!baseStore)return s;
    const navigation=clean(baseStore.navigation)||clean(s?.navigation);
    const note=clean(baseStore.note||baseStore.remark)||clean(s?.note||s?.remark);
    return navigation||note?{...s,...(navigation?{navigation}:{}),...(note?{note}:{})}:s;
   });
  }catch{}
  return w;
 }
 if(id){
  const raw=await get(env,"waybill:"+id);if(!raw)return json({success:true,waybill:null});
  try{
   const waybill=typeof raw==="string"?JSON.parse(raw):raw;
   if((confirmedOnly?!effectiveWaybill(waybill):!activeWaybill(waybill))||waybill.routeId!==routeId||!canReadWaybill(user,waybill,env))return json({success:true,waybill:null});
   return json({success:true,waybill:await withRouteData(waybill)});
  }catch{return json({success:false,code:"WAYBILL_DATA_INVALID",error:"运单数据异常"},500)}
 }
 const today=todayCN(),indexKey=waybillIndexKey(routeId,today);
 let ids=[];
 try{
  const members=await command(env,["SMEMBERS",indexKey]);
  if(Array.isArray(members))ids=members.map(clean).filter(Boolean);
 }catch(e){
  return json({success:false,code:"WAYBILL_LATEST_INDEX_READ_FAILED",error:"今日运单索引读取失败，请稍后重试",detail:String(e?.message||e||"").slice(0,180)},503);
 }
 if(!ids.length)return json({success:true,waybill:null});
 const decode=raw=>{try{return typeof raw==="string"?JSON.parse(raw):raw}catch{return null}};
 let rawList=[];
 try{
  const result=await command(env,["MGET",...ids.map(x=>"zp:waybill:"+x)]);
  if(Array.isArray(result))rawList=result;
 }catch{}
 if(rawList.length!==ids.length){
  try{
   const result=await pipeline(env,ids.map(id=>["GET","zp:waybill:"+id]));
   if(Array.isArray(result))rawList=result;
  }catch(e){
   return json({success:false,code:"WAYBILL_LATEST_DATA_READ_FAILED",error:"今日运单读取失败，请稍后重试",detail:String(e?.message||e||"").slice(0,180)},503);
  }
 }
 const list=rawList.map(decode).filter(w=>(confirmedOnly?effectiveWaybill(w):activeWaybill(w))&&w.routeId===routeId&&w.date===today&&canReadWaybill(user,w,env));
 list.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
 const waybill=list[list.length-1]||null;
 return json({success:true,waybill:await withRouteData(waybill)});
}
export const onRequestGet=guard(latestGet,"WAYBILL_LATEST_READ_FAILED");
