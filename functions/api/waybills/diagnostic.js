import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {get,command} from "../_redis.js";
import {canUseRoute,isSystemAdmin} from "../_permissions.js";
import {canReadWaybill} from "../_waybill-acl.js";
import {listWaybillEvents} from "./_waybill-events.js";
import {getProc} from "./_waybill-proc.js";

const clean=v=>String(v??"").trim();
const parse=v=>{try{return typeof v==="string"?JSON.parse(v):v}catch{return null}};
const isPrimaryWaybillKey=key=>/^zp:waybill:[^:]+$/.test(String(key));

export async function onRequestGet({request,env}){
  const user=await currentUser(request,env);
  if(!user)return json({success:false,error:"未登录"},401);
  const isAdmin=isSystemAdmin(user);
  const url=new URL(request.url);
  const date=clean(url.searchParams.get("date"));
  const vehicle=clean(url.searchParams.get("vehicle")).toUpperCase();
  const requestedRoute=clean(url.searchParams.get("routeId"));
  let routeId, allowedRoutes;
  if(isAdmin){
    // 运维可观测性（1.1）：管理员指定 routeId 即可只读诊断任意线路，不依赖个人派单上下文。
    routeId=requestedRoute;
    allowedRoutes=requestedRoute?[requestedRoute]:[];
  }else{
    if(!canUseRoute(user))return json({success:false,error:"无权查看运单诊断"},403);
    allowedRoutes=[clean(user.dispatchRouteId),clean(user.boundRouteId)].filter(Boolean);
    routeId=requestedRoute||clean(user.dispatchRouteId||user.boundRouteId);
  }
  // 统一 requestId 诊断（P1.5）：处理票据按 requestId 直接回看，放在 routeId 校验之前，
  // 使“仅持 requestId（如 OCR 超时失败）”即可追溯，无需先知道线路。
  const requestedProc=clean(url.searchParams.get("requestId"));
  if(requestedProc){
    const ticket=await getProc(env,requestedProc);
    if(!ticket)return json({success:false,error:"处理票据不存在或已过期"},404);
    const authorizedProc=isAdmin||ticket.userId===user.id||(ticket.routeId&&allowedRoutes.includes(ticket.routeId));
    if(!authorizedProc)return json({success:false,error:"无权查看该处理票据"},403);
    return json({success:true,requestId:requestedProc,procTicket:ticket});
  }
  if(isAdmin&&!routeId)return json({success:false,error:"管理员诊断需指定 routeId"},400);
  if(!routeId||!allowedRoutes.includes(routeId))return json({success:false,error:"无权诊断该线路"},403);

  let cursor="0";
  const found=[];
  do{
    const result=await command(env,["SCAN",cursor,"MATCH","zp:waybill:*","COUNT","100"]);
    cursor=String(result?.[0]??"0");
    for(const key of Array.isArray(result?.[1])?result[1]:[]){
      if(!isPrimaryWaybillKey(key))continue;
      const id=String(key).replace(/^zp:/,"").replace(/^waybill:/,"");
      const raw=await get(env,"waybill:"+id);
      const w=parse(raw);
      if(!w||w.routeId!==routeId)continue;
      if(!isAdmin&&!canReadWaybill(user,w,env))continue;
      if(date&&clean(w.date)!==date)continue;
      if(vehicle&&clean(w.vehicle).toUpperCase()!==vehicle)continue;
      found.push({
        id:w.id||id,
        routeId:w.routeId,
        date:w.date||null,
        vehicle:w.vehicle||null,
        totalWeight:w.totalWeight??null,
        stage:w.stage||null,
        summary:w.summary||null,
        validation:w.validation||null,
        diagnostics:w.diagnostics||null,
        ocr:w.ocr||null,
        quality:w.quality||null,
        requestId:w.requestId||null,
        events:await listWaybillEvents(env,id),
        pipeline:Array.isArray(w.pipeline)?w.pipeline:[],
        createdAt:w.createdAt||null,
        confirmedAt:w.confirmedAt||null
      });
      if(found.length>=20)break;
    }
    if(found.length>=20)break;
  }while(cursor!=="0");

  found.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  return json({success:true,routeId,date:date||null,vehicle:vehicle||null,count:found.length,waybills:found});
}
