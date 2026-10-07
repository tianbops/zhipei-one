import {json} from "../_json.js";
import {currentUser} from "../_auth.js";
import {command,pipeline} from "../_redis.js";
import {canUseRoute,isSystemAdmin} from "../_permissions.js";
import {canReadWaybill} from "../_waybill-acl.js";
import {getProc, failProc, effectiveStage} from "./_waybill-proc.js";
import {scanConsistency,repairConsistency} from "./_consistency.js";
import {computeStats} from "./_stats.js";
import {guard} from "../_safe.js";

const clean=v=>String(v??"").trim();
const parse=v=>{try{return typeof v==="string"?JSON.parse(v):v}catch{return null}};

async function diagnosticGet({request,env}){
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
    // 访问时回收：孤儿 PROCESSING（updatedAt 超阈值）在运维查看时落库为 TIMEOUT，闭环终态（不依赖 15min TTL 被动消失）
    let eff=ticket;
    if(ticket.stage==="PROCESSING" && effectiveStage(ticket)!=="PROCESSING"){
      const reaped=await failProc(env,requestedProc,{stage:effectiveStage(ticket),recoverable:false,action:null,hint:null});
      if(reaped)eff=reaped;
    }
    return json({success:true,requestId:requestedProc,procTicket:eff,effectiveStage:effectiveStage(eff)});
  }
  // 数据一致性自检（P1.5）：只读扫描索引/去重/指纹/事件链/主记录的引用完整性，输出可解释差异报告（不改动任何数据）。
  const wantCheck=clean(url.searchParams.get("check"));
  if(wantCheck==="consistency"){
    const all=isAdmin&&clean(url.searchParams.get("all"))==="1";
    if(!isAdmin){
      if(clean(url.searchParams.get("all"))==="1")return json({success:false,error:"非管理员不可查询全量"},403);
      if(!routeId||!allowedRoutes.includes(routeId))return json({success:false,error:"无权诊断该线路"},403);
    }
    if(isAdmin&&!routeId&&!all)return json({success:false,error:"管理员诊断需指定 routeId 或 all=1"},400);
    const report=await scanConsistency(env,{routeId:all?null:routeId,all});
    return json({success:true,scope:all?"ALL":routeId,...report});
  }
  // 运营统计（1.3）：只读聚合健康度（待定率 / 低置信率 / OCR 超时失败率 / 确认率 / 质量门分布），支撑长期稳定运行。
  const wantStats=clean(url.searchParams.get("stats"));
  if(wantStats==="1"){
    const all=isAdmin&&clean(url.searchParams.get("all"))==="1";
    const days=Number(url.searchParams.get("days"))||30;
    if(!isAdmin){
      if(clean(url.searchParams.get("all"))==="1")return json({success:false,error:"非管理员不可查询全量"},403);
      if(!routeId||!allowedRoutes.includes(routeId))return json({success:false,error:"无权诊断该线路"},403);
    }
    if(isAdmin&&!routeId&&!all)return json({success:false,error:"管理员诊断需指定 routeId 或 all=1"},400);
    const stats=await computeStats(env,{routeId:all?null:routeId,all,days});
    return json({success:true,...stats});
  }
  if(isAdmin&&!routeId)return json({success:false,error:"管理员诊断需指定 routeId"},400);
  if(!routeId||!allowedRoutes.includes(routeId))return json({success:false,error:"无权诊断该线路"},403);

  // 列表查询（P1-4b 修订）：走「线路×日期」SET 索引（zp:route:<routeId>:waybills:<date>）
  // + pipeline SMEMBERS + MGET 批量读，事件链只对返回的前 20 张用 pipeline LRANGE 读取。
  // 此前实现是全键 SCAN zp:waybill:* + 逐张 GET + 逐张 LRANGE，子请求数 O(N)：
  // 生产数据量下必超 Cloudflare Workers 每请求子请求上限（免费版约 50 个）→ 线上 500（2026-10-06 实测）。
  // 索引缺失的孤儿运单不在此列出，由 ?check=consistency 一致性扫描兜底。
  try{
    const idxPrefix="zp:route:"+routeId+":waybills:";
    const dateRe=/^\d{4}-\d{2}-\d{2}$/;
    const dates=[];
    if(date){
      if(!dateRe.test(date))return json({success:false,code:"DATE_INVALID",error:"日期无效"},400);
      dates.push(date);
    }else{
      let cursor="0";
      do{
        const r=await command(env,["SCAN",cursor,"MATCH",idxPrefix+"*","COUNT","100"]);
        cursor=String(r?.[0]??"0");
        for(const key of Array.isArray(r?.[1])?r[1]:[]){
          const text=String(key);
          if(!text.startsWith(idxPrefix))continue;
          const d=text.slice(idxPrefix.length);
          if(dateRe.test(d))dates.push(d);
        }
      }while(cursor!=="0");
    }
    const ids=[];
    for(let i=0;i<dates.length;i+=50){
      const chunk=dates.slice(i,i+50);
      const results=await pipeline(env,chunk.map(d=>["SMEMBERS",idxPrefix+d]));
      for(const r of (Array.isArray(results)?results:[])){
        for(const id of (Array.isArray(r)?r:[])){const v=clean(id);if(v)ids.push(v)}
      }
    }
    const uniqueIds=[...new Set(ids)];
    const records=[];
    for(let i=0;i<uniqueIds.length;i+=100){
      const chunk=uniqueIds.slice(i,i+100);
      const rawList=await command(env,["MGET",...chunk.map(id=>"zp:waybill:"+id)]);
      for(let j=0;j<chunk.length;j++){
        const w=parse(Array.isArray(rawList)?rawList[j]:null);
        if(!w||w.routeId!==routeId)continue;
        if(!isAdmin&&!canReadWaybill(user,w,env))continue;
        if(date&&clean(w.date)!==date)continue;
        if(vehicle&&clean(w.vehicle).toUpperCase()!==vehicle)continue;
        records.push({
          id:w.id||chunk[j],
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
          pipeline:Array.isArray(w.pipeline)?w.pipeline:[],
          createdAt:w.createdAt||null,
          confirmedAt:w.confirmedAt||null,
          _key:chunk[j]
        });
      }
    }
    records.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    const total=records.length;
    const limit=20;
    const truncated=total>limit;
    const top=records.slice(0,limit);
    const eventsByKey=new Map();
    for(let i=0;i<top.length;i+=50){
      const chunk=top.slice(i,i+50);
      const results=await pipeline(env,chunk.map(w=>["LRANGE","zp:waybill:"+w._key+":events","0","-1"]));
      for(let j=0;j<chunk.length;j++){
        const raw=Array.isArray(results?.[j])?results[j]:[];
        eventsByKey.set(chunk[j]._key,raw.map(x=>{try{return typeof x==="string"?JSON.parse(x):x}catch{return null}}).filter(Boolean));
      }
    }
    const waybills=top.map(w=>{const {_key,...rest}=w;return {...rest,events:eventsByKey.get(_key)||[]}});
    return json({success:true,routeId,date:date||null,vehicle:vehicle||null,count:total,truncated,limit,waybills});
  }catch(e){
    return json({success:false,code:"DIAG_LIST_FAILED",error:"运单诊断查询失败",detail:String(e?.message||e||"UNKNOWN_ERROR").slice(0,180)},500);
  }
}

/**
 * 错误兜底（1.1 可靠性）：一致性巡检 / 运营统计 / 列表三族路径都可能触碰
 * Cloudflare Workers 的子请求上限。被平台掐断时若不加包装，异常会直接冒出 Cloudflare
 * 的 HTML 错误页（Error 1101），前端 JSON.parse 失败、运维只拿到一个 Ray ID 无从下手。
 * guard() 把任何漏网异常转成结构化 `{code,error,detail}`，并区分数据服务类失败（503）。
 */
export const onRequestGet=guard(diagnosticGet,"WAYBILL_DIAGNOSTIC_FAILED");
export const onRequestPost=guard(async ({request,env})=>{
  const user=await currentUser(request,env);
  if(!user)return json({success:false,error:"未登录"},401);
  if(!isSystemAdmin(user))return json({success:false,error:"仅管理员可执行一致性修复"},403);
  const url=new URL(request.url);
  const action=clean(url.searchParams.get("action"));
  if(action!=="repair-consistency")return json({success:false,error:"未知操作"},400);
  const routeId=clean(url.searchParams.get("routeId"));
  const all=routeId?false:true;
  const report=await scanConsistency(env,{routeId:all?null:routeId,all});
  // 破坏性修复安全闸门：扫描被 Budget 截断时，不能把“未读到主记录”当成“主记录不存在”。
  if(report.degraded){
    return json({
      success:false,
      code:"CONSISTENCY_SCAN_INCOMPLETE",
      error:"一致性巡检未完整覆盖，已阻止修复；请缩小线路范围后重试",
      scope:all?"ALL":routeId,
      scanned:report.scanned,
      degraded:true,
      budget:report.budget,
      summary:report.summary
    },503);
  }
  const result=await repairConsistency(env,report.issues);
  return json({
    success:true,
    scope:all?"ALL":routeId,
    scanned:report.scanned,
    repairedCount:result.repairedCount,
    skippedCount:result.skippedCount,
    repaired:result.repaired,
    skipped:result.skipped,
    remainingManual:report.issues.filter(i=>!i.fix).map(i=>({type:i.type,waybillId:i.waybillId||null,key:i.key||null}))
  });
},"WAYBILL_REPAIR_FAILED");
