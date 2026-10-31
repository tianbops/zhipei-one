/**
 * 智配One · 运单处理入口（POST /api/waybills/process）
 * ------------------------------------------------------------------
 * 上传运单 → OCR 识别 → 门店匹配 → 去重 → 线路规划 → 校验 → 落库。
 * 实现按职责拆至 _process-common / _process-extract / _process-plan /
 * _process-persist（P1-1g，函数体零改写）；本文件保留 base、runProcess
 * （含嵌套其内、与 runProcessCore 局部量闭包耦合的 saveWaybill）与 onRequestPost；外层
 * runProcess 负责成功后清理 R2 临时图片。
 * 纪律：客户端取消（AbortController）仅断连接，Worker 内任务在高成本阶段
 *   边界主动检查；失败统一经 failProcess 写状态机票据并返回可恢复提示。
 */
import {json} from "../_json.js";
import {clientDetail,clientMessage,logServerError} from "../_errors.js";
import {currentUser} from "../_auth.js";
import {get,command,newId} from "../_redis.js";
import {canUseRoute} from "../_permissions.js";
import {businessFingerprint,dailyWaybillKey,dailyWaybillSignatureString} from "../_waybill-identity.js";
import {recomputeDayMeta} from "./_waybill-meta.js";
import {isTempRoute} from "../dispatch.js";
import {getRoute} from "../_route.js";
import {recognizeImage} from "./ocr.js";
import {findGlobalMatches} from "../_global-learning.js";
import {clean,formatCompareKey,matchStores} from "./_store-match.js";
import {evaluateQualityGates,countLines} from "./_quality-gate.js";
import {appendWaybillEvent} from "./_waybill-events.js";
import {beginProc,failProc,finishProc,getProc,claimProcSave,cancelProc} from "./_waybill-proc.js";
import {Budget,mgetBatchMap} from "../_redis-budget.js";
import {waybillIndexKey,number,todayCN} from "./_process-common.js";
import {extract} from "./_process-extract.js";
import {baseIdentityNames,splitByRouteBase,validateResult,dedupe,plan} from "./_process-plan.js";
import {mergeStoreEdges} from "./_process-multimage.js";
import {pickSupersededCandidates,applySupersede} from "./_process-supersede.js";
import {recordWaybillLifecycle} from "./_process-persist.js";

// R2 免费额度保护：限制单次临时暂存规模；图片仍按既有 OCR 两张并发策略处理。
const WAYBILL_TEMP_MAX_FILES=20;
const WAYBILL_TEMP_MAX_BYTES=80*1024*1024;

/* 同日同线路「重传即替换」：找出同车辆、门店高度重叠的旧单并原子取代，
   返回实际被取代的列表（供响应与事件留痕）。
   读取受统一 Redis 预算保护——预算不足时跳过取代（不影响本次保存成功），
   宁可暂时多一张旧单，也不能因清理而让保存失败。 */
async function supersedeSameDay(env,order,indexKey){
  try{
    const members=await command(env,["SMEMBERS",indexKey]);
    const ids=Array.isArray(members)
      ?[...new Set(members.map(String).filter(Boolean))].filter(id=>id!==order.id)
      :[];
    if(!ids.length)return[];
    const budget=new Budget();
    // 注意：mgetBatchMap 的入参是**完整 Redis 键**（与 routes.js / _history-read.js / _waybill-meta.js
    // 等调用方一致），SMEMBERS 拿到的只是裸 id，必须补上 zp:waybill: 前缀，否则 MGET 全落空，
    // others 恒为空 → 取代永远不触发（线上旧残单未被清理的根因）。
    const read=await mgetBatchMap(env,ids.map(id=>"zp:waybill:"+id),budget,{batch:100});
    if(!read.complete)return[];
    const others=[];
    for(const id of ids){
      const raw=read.map.get("zp:waybill:"+id);
      if(!raw)continue;
      try{others.push(typeof raw==="string"?JSON.parse(raw):raw)}catch{/* 坏数据跳过 */}
    }
    const candidates=pickSupersededCandidates(order,others);
    if(!candidates.length)return[];
    const done=await applySupersede(env,order,candidates);
    for(const d of done){
      try{await appendWaybillEvent(env,d.id,{event:"WAYBILL_SUPERSEDED",stage:"SAVED",requestId:order.requestId,supersededBy:order.id,overlap:d.overlap,total:d.total});}catch{/* best-effort */}
    }
    return done;
  }catch{return[]}
}

async function base(env,id){const raw=await get(env,"route:"+id+":base");if(!raw)throw Object.assign(new Error("线路数据资料尚未建立"),{code:"BASE_NOT_FOUND"});let x;try{x=typeof raw==="string"?JSON.parse(raw):raw}catch{throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"})}if(!x||!Array.isArray(x.stores))throw Object.assign(new Error("线路数据资料格式异常"),{code:"BASE_DATA_INVALID"});return x.stores}

async function runProcessCore({request,env,emit=()=>{},form:providedForm=null,user:providedUser=null,tempKeys=[]}){
  emit(3,"运单已接收");
  const requestId=newId();
  // 上传先后必须记录在请求入口，而不是用 OCR/规划完成后的 createdAt 代替。
  // 多张运单并行处理时，后上传的运单可能更快完成；createdAt 会因此反映“处理完成先后”，而不是“上传先后”。
  const uploadedAt=new Date().toISOString();
  // 处理失败统一收口：写状态机票据（PROCESSING→FAILED/TIMEOUT/CANCELLED）+ 返回可恢复提示（P1 #18）。
  const failProcess=async(code,message,status,opts={})=>{
    const {stage="FAILED",recoverable=false,action=null,hint=null,detail=null,jobId=null,validation=null,timing=null}=opts;
    await failProc(env,requestId,{stage,recoverable,action,hint,detail:detail||(jobId?String(jobId):null),timing,order:opts.order||null});
    return json({success:false,code,error:message,message,requestId,recoverable,action,hint,detail,jobId,validation,...(timing?{timing}: {})},status);
  };
  // AbortController 只中断客户端连接；Worker 内部任务仍可能继续执行，因此在高成本阶段边界主动检查。
  const stopIfClientCancelled=async(stage)=>{
    if(!request?.signal?.aborted)return false;
    emit(0,"已取消处理");
    // 取消与正式保存声明在 Redis 内原子竞争：如果保存声明已经建立，
    // 说明业务已进入不可撤销的原子保存窗口，此时让保存完成并由 DONE 胜出。
    const cancelled=await cancelProc(env,requestId,{action:"REPROCESS",hint:"本次处理已取消，可重新上传运单",detail:stage||null});
    if(cancelled)return true;
    if(stage!=="SAVE"&&stage!=="POST_SAVE")return true;
    // SAVE 阶段取消 CAS 失败时必须 fail-closed：只有确认已经取得保存声明，
    // 才允许继续进入正式保存 EVAL；否则宁可要求重试，也不能把“已取消”运单继续落库。
    const proc=await getProc(env,requestId);
    if(proc?.saveClaimedAt)return false;
    return true;
  };
  const user=providedUser||await currentUser(request,env);if(!user){emit(4,"身份验证失败");return json({success:false,code:"AUTH_REQUIRED",error:"未登录"},401)};if(user.role==="admin"||!canUseRoute(user)){emit(4,"无权处理运单");return json({success:false,code:"WAYBILL_PROCESS_FORBIDDEN",error:"无权处理运单"},403)};
  emit(5,"正在读取运单");
  let form=providedForm;try{if(!form)form=await request.formData()}catch{emit(5,"运单提交格式错误");return json({success:false,code:"WAYBILL_FORM_INVALID",error:"运单提交格式错误"},400)}
  // 线路上下文保护（P1 #17）：处理开始时客户端捕获 processingRouteId，保存时再次校验当前会话线路，
  // 不一致说明用户中途切了线路 —— 拒绝并以可恢复方式提示"请重新处理运单"，避免误写其它线路或误判 403。
  if(await stopIfClientCancelled("ROUTE_CHECK"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const requestedRouteId=clean(form.get("routeId"));
  const processingRouteId=clean(form.get("processingRouteId"))||requestedRouteId;
  const sessionRouteId=clean(user.dispatchRouteId||user.boundRouteId);
  const routeId=processingRouteId||sessionRouteId;
  // 处理票据：每次 process 请求一张 PROCESSING 票据落库（TTL 15min），失败时转 FAILED/TIMEOUT/CANCELLED 并携可恢复提示，成功转 DONE；运单仅成功保存后落库，避免脏运单污染索引/去重（P1 #18）。
  await beginProc(env,{requestId,routeId,userId:user.id,fileName:null});
  if(!routeId){emit(0,"等待配送线路");return failProcess("DISPATCH_ROUTE_MISSING","请先选择调度线路",400,{recoverable:true,action:"REPROCESS",hint:"请先在首页选择调度线路后重新处理运单"});}
  if(processingRouteId&&sessionRouteId&&processingRouteId!==sessionRouteId){emit(0,"线路已切换");return failProcess("DISPATCH_ROUTE_CHANGED","当前线路已发生变化，请重新处理运单",409,{recoverable:true,action:"REPROCESS",hint:"当前线路已发生变化，请重新处理运单"});}
  if(requestedRouteId&&requestedRouteId!==routeId){emit(0,"线路校验失败");return failProcess("DISPATCH_ROUTE_MISMATCH","提交线路与处理线路不一致，请刷新后重试",403,{recoverable:true,action:"REPROCESS",hint:"提交线路与处理线路不一致，请刷新后重试"});}
  let route=null;if(!isTempRoute(routeId)){emit(6,"正在校验配送线路");route=await getRoute(env,routeId);if(!route||route.status!=="active"){emit(6,"当前配送线路不可用");return failProcess("DISPATCH_ROUTE_INACTIVE","当前调度线路不存在或已停用，请重新选择线路",409,{recoverable:true,action:"REPROCESS",hint:"当前调度线路不存在或已停用，请重新选择线路"});}}
  if(await stopIfClientCancelled("INPUT"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const rawText=clean(form.get("rawText"));
  let files=typeof form.getAll==="function"?form.getAll("file").filter(x=>x instanceof File):[];
  const file=files[0]||null;
  if(!rawText&&!files.length&&!clean(form.get("resumeRequestId"))){emit(6,"未找到运单");return failProcess("WAYBILL_FILE_MISSING","请选择运单",400,{recoverable:true,action:"RESUBMIT",hint:"请选择运单文件后重试"});}
  emit(6,files.length>1?`已读取运单，共 ${files.length} 张截图`:"已读取运单");
  // 仅重保存（RETRY_SAVE）：复用已落 proc 票据的 order，跳过 OCR/提取/匹配/去重/规划/校验，直接重跑保存脚本（不重 OCR）。
  const resumeRequestId=clean(form.get("resumeRequestId"));
  if(resumeRequestId){
    const t=await getProc(env,resumeRequestId);
    if(!t||t.userId!==user.id||t.stage!=="FAILED"||t.action!=="RETRY_SAVE"||!t.order)return failProcess("RESUME_INVALID","保存任务已失效，请重新上传运单",422,{recoverable:true,action:"RESUBMIT",hint:"保存任务已失效，请重新上传运单"});
    return await saveWaybill(t.order, requestId, true);
  }
  if(await stopIfClientCancelled("OCR"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const started=Date.now();let ocr=null,recognizedText=rawText,ocrMs=0;
  if(!recognizedText){
  if(!recognizedText&&files.length){
    const totalBytes=files.reduce((sum,item)=>sum+(Number(item?.size)||0),0);
    if(files.length>WAYBILL_TEMP_MAX_FILES||totalBytes>WAYBILL_TEMP_MAX_BYTES){
      return failProcess("WAYBILL_TEMP_LIMIT_EXCEEDED","本次运单图片数量或总大小超出限制，请分批上传",413,{recoverable:true,action:"REPROCESS",hint:"请减少图片数量或分批上传后重试"});
    }
    const bucket=env?.WAYBILL_FILES;
    if(!bucket||typeof bucket.put!=="function"||typeof bucket.get!=="function"||typeof bucket.delete!=="function"){
      return failProcess("WAYBILL_TEMP_STORAGE_UNAVAILABLE","运单临时存储暂不可用，请稍后重试",503,{recoverable:true,action:"REPROCESS",hint:"运单图片临时存储暂不可用，请稍后重试"});
    }
    const stagedFiles=[];
    try{
      for(let i=0;i<files.length;i++){
        const source=files[i];
        const key=`waybill-tmp/${requestId}/${i+1}-${crypto.randomUUID()}`;
        await bucket.put(key,source,{storageClass:"Standard",httpMetadata:{contentType:source.type||"application/octet-stream"}});
        tempKeys.push(key);
        const stored=await bucket.get(key);
        if(!stored)throw new Error("临时图片写入后无法读取");
        const bytes=await stored.arrayBuffer();
        stagedFiles.push(new File([bytes],source.name||`waybill-${i+1}`,{
          type:source.type||"application/octet-stream",
          lastModified:Number(source.lastModified)||Date.now()
        }));
      }
      files=stagedFiles;
    }catch(error){
      logServerError("waybills.r2-temp-stage",error);
      return failProcess("WAYBILL_TEMP_STORAGE_FAILED","运单图片临时存储失败，请重新上传",503,{recoverable:true,action:"REPROCESS",hint:"运单图片暂存失败，请重新上传后重试"});
    }
  }

    const ocrStarted=Date.now();const results=[];const totalFiles=Math.max(1,files.length);
    try{
      /* 多图并发识别：原实现逐张串行 await，N 张截图≈N×单张耗时（实测单张约 7s）；
         改为每批 2 张并发（OCR 服务有 QPS 限制，不一次全发），多图总耗时≈单张×批数。
         单图时批大小=1，行为与原来完全一致。 */
      const CONCURRENCY=files.length>1?2:1;
      for(let start=0;start<files.length;start+=CONCURRENCY){
        const batch=[];
        for(let k=0;k<CONCURRENCY&&start+k<files.length;k++)batch.push(start+k);
        const settled=await Promise.allSettled(batch.map(async i=>{
          const fileIndex=i+1;
          if(await stopIfClientCancelled("OCR")){const ce=new Error("cancelled");ce.code="PROCESS_CANCELLED";throw ce}
          emit(8+Math.round((i/totalFiles)*44),totalFiles>1?`正在识别第 ${fileIndex}/${totalFiles} 张截图…`:"运单已上传，正在排队识别…");
          return await recognizeImage(env,files[i],p=>{
            const v=Math.max(0,Math.min(100,Number(p)||0));
            const base=8+(i/totalFiles)*44;
            emit(Math.round(base+(v/100)*(44/totalFiles)),totalFiles>1?`正在识别第 ${fileIndex}/${totalFiles} 张截图…`:(v<=10?"运单已上传，正在排队识别…":"正在识别运单…"));
          },request?.signal);
        }));
        const failed=settled.find(x=>x.status==="rejected");
        if(failed){
          const e=failed.reason||{};
          if(e.code==="PROCESS_CANCELLED")return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，请重新处理运单"},499);
          const ocrCode=e.code||"OCR_FAILED";
          const ocrHint={OCR_TIMEOUT:"OCR识别超时，可重新上传运单重试",OCR_CANCELLED:"已取消识别，可重新上传运单",OCR_JOB_FAILED:"OCR识别失败，请上传更清晰的运单照片",OCR_EMPTY:"OCR未识别到文字，请上传更清晰的运单照片",OCR_RESULT_MISSING:"OCR结果缺失，请重新上传运单",OCR_RESULT_FETCH:"OCR结果读取失败，请重新上传运单",OCR_RESULT_TIMEOUT:"OCR结果读取超时，请重新上传运单",OCR_NETWORK_TIMEOUT:"OCR服务响应超时，请稍后重试",OCR_SUBMIT_FAILED:"OCR任务提交失败，请稍后重试",OCR_API:"OCR服务暂时不可用，请稍后重试",OCR_BAD_RESPONSE:"OCR服务返回异常，请稍后重试",OCR_AUTH:"OCR服务鉴权失败，请联系管理员",OCR_ENDPOINT:"OCR服务地址异常，请联系管理员"};
          const ocrStage=ocrCode==="OCR_TIMEOUT"?"TIMEOUT":(ocrCode==="OCR_CANCELLED"?"CANCELLED":"FAILED");
          const ocrRecoverable=ocrCode!=="OCR_NOT_CONFIGURED";
          return failProcess(ocrCode,e.message||"OCR识别失败",e.code==="OCR_NOT_CONFIGURED"?503:422,{stage:ocrStage,recoverable:ocrRecoverable,action:ocrRecoverable?"RETRY_OCR":null,hint:ocrHint[ocrCode]||"OCR识别失败，请稍后重试",jobId:e.jobId||null,detail:e.message||null,timing:{ocrSubmitMs:e.ocrSubmitMs,ocrStatusPollCount:e.ocrStatusPollCount,ocrStatusWaitMs:e.ocrStatusWaitMs,ocrStatusRequestMs:e.ocrStatusRequestMs,ocrResultFetchMs:e.ocrResultFetchMs,ocrResultFetchWaitMs:e.ocrResultFetchWaitMs,ocrResultFetchAttempts:e.ocrResultFetchAttempts}});
        }
        for(const s of settled)results.push(s.value);
      }
      const imageTexts=results.map(x=>String(x.rawText||""));
      // 相邻截图可能包含上一张末尾的重复内容。按“前图尾部/后图头部”做保守重叠裁剪，
      // 只删除确认连续重复的文字；没有足够重叠时保持原文，绝不凭猜测删除业务内容。
      const mergeOcrImages=(texts)=>{
        const out=[];
        const norm=s=>String(s||"").replace(/[\s\u200b\uFEFF]+/g,"");
        for(const text of texts){
          if(!out.length){out.push(text);continue}
          const prev=out[out.length-1];
          const a=norm(prev),b=norm(text);
          let overlap=0;
          const max=Math.min(a.length,b.length,1600);
          for(let len=max;len>=12;len--){
            if(a.slice(-len)===b.slice(0,len)){overlap=len;break;}
          }
          if(overlap){
            let removeChars=0,seen=0;
            for(const ch of String(text)){
              if(/\s|\u200b|\uFEFF/.test(ch)) continue;
              seen++;
              removeChars++;
              if(seen>=overlap)break;
            }
            out[out.length-1]=prev+String(text).slice(removeChars);
          }else{
            out.push(text);
          }
        }
        return out.join("\\n");
      };
      recognizedText=mergeOcrImages(imageTexts);
      ocr={provider:"aistudio",model:"PP-OCRv6",jobId:results.map(x=>x.jobId).filter(Boolean),lineCount:results.reduce((n,x)=>n+(Number(x.lineCount)||0),0),lowConfidence:results.some(x=>x.lowConfidence),imageCount:results.length,imageTexts,ocrSubmitMs:results.reduce((n,x)=>n+(Number(x.ocrSubmitMs)||0),0),ocrStatusPollCount:results.reduce((n,x)=>n+(Number(x.ocrStatusPollCount)||0),0),ocrStatusWaitMs:results.reduce((n,x)=>n+(Number(x.ocrStatusWaitMs)||0),0),ocrStatusRequestMs:results.reduce((n,x)=>n+(Number(x.ocrStatusRequestMs)||0),0),ocrResultFetchMs:results.reduce((n,x)=>n+(Number(x.ocrResultFetchMs)||0),0),ocrResultFetchWaitMs:results.reduce((n,x)=>n+(Number(x.ocrResultFetchWaitMs)||0),0),ocrResultFetchAttempts:results.reduce((n,x)=>n+(Number(x.ocrResultFetchAttempts)||0),0)};
      ocrMs=Date.now()-ocrStarted;
      emit(54,totalFiles>1?`已完成 ${totalFiles} 张截图识别`:"已完成运单识别");
    }catch(e){throw e}
  }
  if(await stopIfClientCancelled("POST_OCR"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const recognizedMs=Date.now()-started;const baseStarted=Date.now();let baseStores=[];let baseAvailable=false;if(!isTempRoute(routeId)){try{baseStores=await base(env,routeId);baseAvailable=Array.isArray(baseStores)&&baseStores.length>0}catch(e){if(e?.code!=="BASE_NOT_FOUND")return failProcess(e.code||"BASE_DATA_INVALID",e.message||"线路数据资料读取失败",409,{recoverable:false,hint:"线路数据资料读取失败，请联系管理员",detail:e.message||null});}}const baseMs=Date.now()-baseStarted;emit(56,baseAvailable?"已读取线路基准":"未建立线路基准，转入全局学习");
  if(await stopIfClientCancelled("EXTRACT"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const extractedStarted=Date.now();const extracted=extract(recognizedText);
  /* 多张截图（同一运单分段拍摄）：逐图提取门店条目后再合并。
     衔接处必定有重叠门店（屏幕上/下边缘各截去一部分，重叠区在两张里都有完整版本），
     因此只需剔除每张图边界上的不完整条目，不会造成门店丢失：
       - 非首图：丢弃第一条（屏幕顶部截断的残条，可能只缺前缀、看起来像完整店名）；
       - 非末图：丢弃最后一条（屏幕底部截断的残条）；
       - 末图末尾完整，保留。
     单图或纯文本直录场景完全走原逻辑，行为不变。 */
  const imgTexts=(ocr&&Array.isArray(ocr.imageTexts))?ocr.imageTexts:[];
  /* 底部残条按证据判定需要「是否基准库完整门店」：基准库里存在真实的前缀关系
     门店（特渠部重庆市卫生健康委员会 / 特渠部重庆市卫生健康委员会（临时）），
     没有这层证据会把前者误当残条删掉 → 丢门店漏送。 */
  const baseKeys=new Set();
  for(const bs of baseStores)for(const nm of baseIdentityNames(bs))baseKeys.add(formatCompareKey(nm));
  const edge=mergeStoreEdges(imgTexts,extract,{isKnownStore:name=>baseKeys.has(formatCompareKey(name))});
  let edgeTrimmed=edge.edgeTrimmed;
  if(edge.stores)extracted.stores=edge.stores;
  const rawExtractCount=extracted.stores.length;extracted.stores=splitByRouteBase(extracted.stores,baseStores);const splitExtractCount=extracted.stores.length;const recoveredCount=Math.max(0,splitExtractCount-rawExtractCount);const extractMs=Date.now()-extractedStarted;emit(66,`已提取 ${extracted.stores.length} 家门店`);if(!extracted.stores.length)return failProcess("EXTRACT_EMPTY","未提取到门店，请检查运单内容",422,{recoverable:true,action:"RESUBMIT",hint:"未从运单中提取到门店，请检查运单图片清晰度后重新上传"});
  if(await stopIfClientCancelled("MATCH"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const rawExtractItems=extracted.stores.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null,sourceLine:s.sourceLine||null}));const matchStarted=Date.now();const locallyMatched=matchStores(extracted.stores,baseStores);const hasRouteBase=baseAvailable;const globalCandidates=hasRouteBase?[]:await findGlobalMatches(env,locallyMatched.filter(x=>x.pending));const globalMap=new Map(globalCandidates.map(x=>[x.rawName+"|"+(x.sourceLine||""),x]));const matched=locallyMatched.map(x=>{if(!x.pending)return x;const g=globalMap.get(x.rawName+"|"+(x.sourceLine||""));if(!g||g.globalMatchStatus!=="matched")return x;const standard=clean(g.name)||x.rawName;return {...x,...g,name:standard,correction:formatCompareKey(x.rawName)!==formatCompareKey(standard),pending:false,matchStatus:"matched",matchMethod:g.globalMatchMethod,routeOrder:100000};});const matchMs=Date.now()-matchStarted;emit(78,hasRouteBase?"已完成线路基准匹配":"已完成全局学习匹配");const dedupeStarted=Date.now();const d=dedupe(matched);const dedupeMs=Date.now()-dedupeStarted;emit(86,`已完成去重${d.merged?`，合并 ${d.merged} 家`:""}`);const planStarted=Date.now();const useRouteOrder=baseAvailable;const planned=plan(d.items,useRouteOrder);const planMs=Date.now()-planStarted;const pending=planned.filter(x=>x.pending);emit(92,`已完成线路规划，共 ${planned.length} 家`);
  if(await stopIfClientCancelled("PLAN"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  const quality=evaluateQualityGates({recognizedTextLen:recognizedText.length,lineCount:countLines(recognizedText),rawExtractCount,extractCount:extracted.stores.length,plannedCount:planned.length,pendingCount:pending.length,autoMatchedCount:matched.filter(x=>!x.pending).length,dedupeBefore:matched.length,dedupeAfter:d.items.length,merged:d.merged});
  const formWeight=number(form.get("totalWeight"));const effectiveWeight=formWeight!=null&&formWeight>0?formWeight:extracted.totalWeight;const order={schemaVersion:"2",id:newId(),uploadedAt,routeId,routeName:clean(route?.name)||"临时用户",date:clean(form.get("date"))||extracted.date||todayCN(),dateInferred:!(clean(form.get("date"))||extracted.date),vehicle:clean(form.get("vehicle"))||extracted.vehicle||null,driver:clean(form.get("driver"))||extracted.driver||null,deliveryPerson:clean(form.get("deliveryPerson"))||extracted.deliveryPerson||null,totalWeight:effectiveWeight,stores:planned,rawText:recognizedText,stage:pending.length?"PLANNED":"CONFIRMED",pipeline:["RECOGNIZED","EXTRACTED","MATCHED","DEDUPED","PLANNED","VALIDATED",...(pending.length?[]:["CONFIRMED"])],summary:{original:rawExtractCount,extractCount:splitExtractCount,recoveredCount,finalCount:planned.length,total:planned.length,matched:planned.length-pending.length,pending:pending.length,correction:planned.filter(x=>x.correction).length,merged:d.merged,newStores:0},timing:{recognizedMs,ocrMs,baseMs,extractMs,matchMs,dedupeMs,planMs,totalMs:Date.now()-started,...(ocr?{ocrSubmitMs:ocr.ocrSubmitMs,ocrStatusPollCount:ocr.ocrStatusPollCount,ocrStatusWaitMs:ocr.ocrStatusWaitMs,ocrStatusRequestMs:ocr.ocrStatusRequestMs,ocrResultFetchMs:ocr.ocrResultFetchMs,ocrResultFetchWaitMs:ocr.ocrResultFetchWaitMs,ocrResultFetchAttempts:ocr.ocrResultFetchAttempts}: {})},ocr:ocr?{provider:ocr.provider||"PaddleOCR",model:ocr.model,jobId:ocr.jobId,lineCount:ocr.lineCount,lowConfidence:ocr.lowConfidence||null,fallback:ocr.fallback||null,imageCount:ocr.imageCount||1}:null,createdBy:user.id,createdAt:new Date().toISOString(),requestId,quality,processingRouteId,routeIdAtProcessing:routeId};
  if(!pending.length){order.confirmedAt=order.createdAt;order.confirmedBy=user.id;}
  const validation=validateResult(order);order.validation=validation;if(!validation.valid){const first=validation.errors?.[0]||"校验失败";const codeMap={"缺少运单日期":"WAYBILL_VALIDATION_DATE_MISSING","缺少车辆信息":"WAYBILL_VALIDATION_VEHICLE_MISSING","没有规划门店":"WAYBILL_VALIDATION_STORES_EMPTY","规划结果存在重复门店":"WAYBILL_VALIDATION_DUPLICATE_STORE","规划结果存在无效线路顺序":"WAYBILL_VALIDATION_ROUTE_ORDER_INVALID","规划结果存在重复线路顺序":"WAYBILL_VALIDATION_ROUTE_ORDER_DUPLICATE","线路顺序不连续":"WAYBILL_VALIDATION_ROUTE_ORDER_GAP"};return failProcess(codeMap[first]||"WAYBILL_VALIDATION_FAILED","运单规划结果校验失败："+first,422,{recoverable:true,action:"RESUBMIT",hint:"运单规划结果校验失败："+first,validation})}order.diagnostics={matchMode:hasRouteBase?"ROUTE_BASE":"GLOBAL_LEARNING",baseStoreCount:baseStores.length,rawExtractCount,extractCount:splitExtractCount,recoveredCount,rawExtractItems,extractItems:extracted.stores.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null})),localMatchedCount:locallyMatched.filter(x=>!x.pending).length,localPendingCount:locallyMatched.filter(x=>x.pending).length,localPendingItems:locallyMatched.filter(x=>x.pending).map(x=>({rawName:x.rawName,candidates:x.candidates||[]})),globalMatchedCount:matched.filter(x=>!x.pending&&(x.matchMethod==="global-alias"||x.matchMethod==="global-identity")).length,globalPendingCount:hasRouteBase?0:matched.filter(x=>x.pending).length,finalPendingCount:pending.length,dedupeBefore:matched.length,dedupeAfter:d.items.length,merged:d.merged,dedupeConflicts:d.conflicts,dedupeRemoved:d.removed,correctionItems:planned.filter(x=>x.correction).map((s,i)=>({rawName:s.rawName,name:s.name,storeId:s.storeId||null,matchMethod:s.matchMethod||null})),plannedCount:planned.length,finalCount:order.stores.length,finalItems:planned.map((s,i)=>({index:i+1,rawName:s.rawName,name:s.name,storeId:s.storeId||null,pending:!!s.pending,matchMethod:s.matchMethod||null,routeOrder:s.routeOrder,matchConfidence:s.matchConfidence||null})),requestId,quality,edgeTrimmed};
  return await saveWaybill(order, requestId, false);
async function saveWaybill(order, requestId, resumed){
  if(await stopIfClientCancelled("SAVE"))return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
  // 最终 Redis 保存 EVAL 前再做一次原子“保存声明”。
  // cancel 先赢则这里失败；claim 先赢则后续取消不再覆盖，保存完成后 DONE 胜出。
  if(!await claimProcSave(env,requestId)){
    const proc=await getProc(env,requestId);
    if(proc?.stage==="CANCELLED")return json({success:false,code:"PROCESS_CANCELLED",error:"已取消处理",message:"已取消处理",requestId,recoverable:true,action:"REPROCESS",hint:"本次处理已取消，可重新上传运单"},499);
    if(proc?.stage==="DONE"&&proc?.waybillId){
      const existingRaw=await command(env,["GET","zp:waybill:"+proc.waybillId]);
      const existing=existingRaw?(typeof existingRaw==="string"?JSON.parse(existingRaw):existingRaw):null;
      if(existing)return json({success:true,waybill:existing,idempotent:true,processingTiming:order.timing,requestId});
    }
    return failProcess("WAYBILL_SAVE_CLAIM_FAILED","保存任务状态发生变化，请重试",409,{recoverable:true,action:"RETRY_SAVE",hint:"保存任务状态发生变化，请重试保存",order});
  }
  const routeId=order.routeId;
  // 方案C rollup：保存成功后重算当日汇总键（best-effort；读路径缺失 meta 会自动自愈）
  const touchMeta=async()=>{try{await recomputeDayMeta(env,routeId,clean(order.date))}catch{}};
  const quality=order.quality;
  emit(96,"正在保存运单");
  order.businessFingerprint=await businessFingerprint(order);
  const fingerprintKey="zp:waybill:fingerprint:"+order.businessFingerprint;
  const indexKey=waybillIndexKey(routeId,clean(order.date));
  // 当日业务去重键：线路 + 日期 + 车辆 + 重量 + 门店名称(归一化排序) + 门店数量。
  // 同一车辆当天多趟（门店/重量不同）→ 签名不同 → 视为不同运单，不会被误合并。
  const dailySig=await dailyWaybillKey(order);
  const sigString=dailyWaybillSignatureString(order);
  // 将当日业务签名显式固化到主记录，供保存 EVAL 校验反向去重键，防止“键指向错误运单”时被误判为幂等。
  order.dailyDedupeKey=dailySig;
  const dedupeKey="zp:waybill:dedupe:"+dailySig;
  // 历史运单未写入 dedupeKey，这里兜底扫描当日索引里「业务签名一致」的运单，命中即复用旧单（不新增）。
  let dailyDupId=null;
  const hasDedupe=await command(env,["GET",dedupeKey]);
  if(!hasDedupe){
    const members=await command(env,["SMEMBERS",indexKey]);
    const ids=Array.isArray(members)?[...new Set(members.map(String).filter(Boolean))]:[];
    // 历史旧运单可能没有 dedupeKey。兜底仍需检查业务签名，但禁止逐单 GET：
    // 一次 MGET 批量读取，并受统一 Redis 预算保护；预算不足时宁可让保存可重试，也不能冒险继续并可能产生重复单。
    const budget=new Budget();
    const read=await mgetBatchMap(env,ids.map(id=>"zp:waybill:"+id),budget,{batch:100});
    if(!read.complete){
      return failProcess("WAYBILL_DEDUPE_SCAN_BUDGET","历史去重校验达到资源预算，请稍后重试保存",503,{recoverable:true,action:"RETRY_SAVE",hint:"历史去重校验资源不足，请重试保存",budgetUsed:budget.used,budgetMax:budget.max});
    }
    for(const id of ids){
      const raw=read.map.get("zp:waybill:"+id);
      if(!raw)continue;
      let w;try{w=typeof raw==="string"?JSON.parse(raw):raw}catch{continue}
      if(dailyWaybillSignatureString(w)===sigString){dailyDupId=id;break}
    }
  }
  if(dailyDupId&&dailyDupId!==order.id){
    const raw=await command(env,["GET","zp:waybill:"+dailyDupId]);
    if(raw){
      let w;try{w=typeof raw==="string"?JSON.parse(raw):raw}catch{w=null}
      if(w){
        // 历史去重命中后的索引/指纹补齐也必须原子化，避免与并发保存互相覆盖 dedupeKey。
        const repairScript='local current=redis.call("GET",KEYS[1]); if current and current~="" then local raw=redis.call("GET","zp:waybill:"..current); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.dailyDedupeKey==ARGV[2] then redis.call("SADD",KEYS[2],current); return current end; redis.call("DEL",KEYS[1]) else redis.call("DEL",KEYS[1]) end; end; redis.call("SADD",KEYS[2],ARGV[1]); redis.call("SET",KEYS[1],ARGV[1]); return ARGV[1]';
        const repairedId=await command(env,["EVAL",repairScript,"2",dedupeKey,indexKey,dailyDupId,dailySig]);
        const finalId=String(repairedId||dailyDupId);
        if(finalId!==dailyDupId){
          const finalRaw=await command(env,["GET","zp:waybill:"+finalId]);
          if(finalRaw){
            w=typeof finalRaw==="string"?JSON.parse(finalRaw):finalRaw;
          }
        }
        try { await appendWaybillEvent(env, finalId, {event:"WAYBILL_IDEMPOTENT",stage:"SAVED",requestId,reuse:finalId,dedupe:"DAILY_MATCH"}); } catch { /* best-effort */ }
        await touchMeta(); await finishProc(env, requestId, finalId); return json({success:true,waybill:w,idempotent:true,dedupe:"DAILY_MATCH",indexSync:"OK",quality,processingTiming:order.timing,requestId});
      }
    }
  }
  // 保存脚本：原子地按「业务签名 > 内容指纹」顺序去重。
  // 命中旧单返回 {"DAILY"|"FINGERPRINT", id}，新单返回 {"NEW", id}。业务签名已含车辆+门店+重量，故同车多趟天然区分。
  const saveScript='local fpKey=KEYS[1]; local wbKey=KEYS[2]; local idxKey=KEYS[3]; local dedupeKey=KEYS[4]; local sigId=redis.call("GET",dedupeKey); if sigId and sigId~="" then local raw=redis.call("GET","zp:waybill:"..sigId); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.dailyDedupeKey==ARGV[3] then redis.call("SADD",idxKey,sigId); return {"DAILY",sigId} end; if not ok or type(existing)~="table" or not existing.dailyDedupeKey then return {"VERIFY_DAILY",sigId} end; redis.call("DEL",dedupeKey) end; redis.call("DEL",dedupeKey) end; local fpId=redis.call("GET",fpKey); if fpId and fpId~=ARGV[1] then local raw=redis.call("GET","zp:waybill:"..fpId); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.businessFingerprint==ARGV[4] then redis.call("SADD",idxKey,fpId); return {"FINGERPRINT",fpId} end; if not ok or type(existing)~="table" or not existing.businessFingerprint then return {"VERIFY_FINGERPRINT",fpId} end; redis.call("DEL",fpKey) end; redis.call("DEL",fpKey) end; redis.call("SET",fpKey,ARGV[1]); redis.call("SET",wbKey,ARGV[2]); redis.call("SADD",idxKey,ARGV[1]); redis.call("SET",dedupeKey,ARGV[1]); return {"NEW",ARGV[1]}';
  let saveResult;
  try{
    saveResult=await command(env,["EVAL",saveScript,"4",fingerprintKey,"zp:waybill:"+order.id,indexKey,dedupeKey,order.id,JSON.stringify(order),dailySig,order.businessFingerprint]);
  }catch(e){
    return failProcess("WAYBILL_SAVE_FAILED","运单保存失败",500,{recoverable:true,action:"RETRY_SAVE",hint:"运单保存失败，可重试保存",detail:e?.message||String(e)});
  }
  let reason="NEW",savedId=order.id;
  if(Array.isArray(saveResult)&&saveResult.length>=2){reason=String(saveResult[0]);savedId=String(saveResult[1])}
  else if(typeof saveResult==="string"&&saveResult!==order.id){reason="FINGERPRINT";savedId=saveResult}
  if(reason==="VERIFY_DAILY"||reason==="VERIFY_FINGERPRINT"){
    const verifyId=String(savedId||"");
    const verifyRaw=verifyId?await command(env,["GET","zp:waybill:"+verifyId]):null;
    let verifyOrder=null;try{verifyOrder=verifyRaw?JSON.parse(verifyRaw):null}catch{}
    const valid=reason==="VERIFY_DAILY"
      ? !!verifyOrder && dailyWaybillSignatureString(verifyOrder)===sigString
      : !!verifyOrder && String(verifyOrder.businessFingerprint||"")===String(order.businessFingerprint||"");
    if(valid){
      const repairKey=reason==="VERIFY_DAILY"?dedupeKey:fingerprintKey;
      const repair=await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SADD",KEYS[2],ARGV[1]); return 1 end; return 0',"2",repairKey,indexKey,verifyId]);
      if(Number(repair)===1){
        await touchMeta(); await finishProc(env, requestId, verifyId);
        try{await appendWaybillEvent(env,verifyId,{event:"WAYBILL_IDEMPOTENT",stage:"SAVED",requestId,reuse:verifyId,dedupe:reason==="VERIFY_DAILY"?"DAILY_MATCH_LEGACY":"FINGERPRINT_LEGACY"});}catch{}
        return json({success:true,waybill:verifyOrder,idempotent:true,dedupe:reason==="VERIFY_DAILY"?"DAILY_MATCH_LEGACY":"FINGERPRINT_LEGACY",indexSync:"OK",quality,processingTiming:order.timing,requestId});
      }
      return failProcess("WAYBILL_DEDUPE_RETRY","去重键正在变化，请重试保存",409,{recoverable:true,action:"RETRY_SAVE",hint:"去重键正在变化，请重试保存",order});
    }
    // 已存在的反向键与主记录身份不一致：仅 CAS 删除错误引用，不删除主运单。
    const keyToClean=reason==="VERIFY_DAILY"?dedupeKey:fingerprintKey;
    await command(env,["EVAL",'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end',"1",keyToClean,verifyId]).catch(()=>{});
    saveResult=await command(env,["EVAL",saveScript,"4",fingerprintKey,"zp:waybill:"+order.id,indexKey,dedupeKey,order.id,JSON.stringify(order),dailySig,order.businessFingerprint]);
    reason=Array.isArray(saveResult)?String(saveResult[0]||"NEW"):"NEW";
    savedId=Array.isArray(saveResult)?String(saveResult[1]||order.id):order.id;
    if(reason==="VERIFY_DAILY"||reason==="VERIFY_FINGERPRINT") return failProcess("WAYBILL_DEDUPE_CORRUPT","去重索引与运单身份不一致，请稍后重试",409,{recoverable:true,action:"RETRY_SAVE",hint:"发现旧去重索引异常，已安全隔离，请重试保存",order});
  }
  if(reason==="NEW"){
    /* 同日同线路、同车辆、门店高度重叠的旧单 → 自动取代（重传即替换）。
       避免"补拍/纠正"重复上传导致当日家数与重量被累加（实测出现过同一天 3 张
       完全重复运单：67 家 vs 实际 22 家）。判定与动作见 _process-supersede.js：
       只用「交集/较大集合」而非内嵌度，故"只补拍了一小段"不会覆盖全单，
       同车第二趟（不同门店）也不会被误删。
       取代后再重算当日汇总，统计立即回到单张口径。 */
    const superseded=await supersedeSameDay(env,order,indexKey);
    if(superseded.length)emit(99,`已替换当日同车辆旧运单 ${superseded.length} 张`);
    emit(100,"处理完成");
    if(resumed){ try { await appendWaybillEvent(env, order.id, {event:"WAYBILL_RESUMED_SAVE",stage:"SAVED",requestId,id:order.id,qualityLevel:order.quality?.level,qualityFlags:order.quality?.flags||[]}); } catch { /* best-effort */ } }
    else { await recordWaybillLifecycle(env, order, {requestId, rawExtractCount, extractCount:order.summary?.extractCount, recoveredCount:order.summary?.recoveredCount, matched, pending, d}); }
    await touchMeta(); await finishProc(env, requestId, order.id); return json({success:true,waybill:order,pipeline:order.pipeline,summary:order.summary,indexSync:"OK",quality,superseded,requestId});
  }
  const existingRaw=await command(env,["GET","zp:waybill:"+savedId]);
  if(existingRaw){
    const existingOrder=typeof existingRaw==="string"?JSON.parse(existingRaw):existingRaw;
    await command(env,["SADD",indexKey,existingOrder.id]);
    try { await appendWaybillEvent(env, existingOrder.id, {event:"WAYBILL_IDEMPOTENT",stage:"SAVED",requestId,reuse:existingOrder.id,dedupe:reason}); } catch { /* best-effort */ }
    await touchMeta(); await finishProc(env, requestId, existingOrder.id); return json({success:true,waybill:existingOrder,idempotent:true,dedupe:reason,indexSync:"OK",quality,processingTiming:order.timing,requestId});
  }
  return failProcess("WAYBILL_DEDUPE_LOOKUP_FAILED","已存在的运单记录丢失，请重试",409,{recoverable:true,action:"RETRY_SAVE",hint:"已存在的运单记录丢失，请重试保存",order});
}
}


async function deleteTempWaybillObjects(env,keys){
  const bucket=env?.WAYBILL_FILES;
  if(!bucket||typeof bucket.delete!=="function")return;
  for(const key of keys){
    // 只允许清理本次请求生成的 waybill-tmp/ 对象。
    if(typeof key!=="string"||!key.startsWith("waybill-tmp/"))continue;
    let deleted=false;
    for(let attempt=0;attempt<2&&!deleted;attempt++){
      try{await bucket.delete(key);deleted=true}catch(error){
        if(attempt===1)logServerError("waybills.r2-temp-delete",error);
      }
    }
  }
}

async function runProcess(args){
  const tempKeys=[];
  let response=null;
  try{
    response=await runProcessCore({...args,tempKeys});
    return response;
  }finally{
    if(response&&tempKeys.length){
      let succeeded=false;
      try{succeeded=(await response.clone().json())?.success===true}catch{}
      if(succeeded)await deleteTempWaybillObjects(args.env,tempKeys);
    }
  }
}

export async function onRequestPost({request,env}){
  const user=await currentUser(request,env);if(!user)return json({success:false,error:"未登录"},401);
  if(new URL(request.url).searchParams.get("stream")!=="1")return runProcess({request,env});
  const encoder=new TextEncoder();
  let closed=false;
  let heartbeat=null;
  const streamBody=new ReadableStream({start(controller){
    const push=value=>{
      if(closed)return false;
      try{controller.enqueue(encoder.encode(value));return true}catch{closed=true;return false}
    };
    const emit=(progress,message)=>push(JSON.stringify({type:"progress",progress,message})+"\n");
    heartbeat=setInterval(()=>push(JSON.stringify({type:"heartbeat",ts:Date.now()})+"\n"),1000);
    // 先建立响应流并立即发送首个进度事件，再在流内部读取 multipart/form-data。
    // 避免 request.formData() 阻塞响应头和首个进度事件，导致客户端长时间停在 3%。
    emit(3,"运单已接收");
    runProcess({request,env,emit,user}).then(async response=>{
      let payload={};try{payload=await response.clone().json()}catch(error){payload={success:false,error:"处理结果读取失败",httpStatus:response.status}}
      push(JSON.stringify({type:"result",...payload,httpStatus:response.status})+"\n");
      if(heartbeat)clearInterval(heartbeat);
      if(!closed){closed=true;try{controller.close()}catch{}}
    }).catch(error=>{
      // P0-5：此前这里把 error.stack 直接塞进 detail 发给浏览器。
      // 现在未预期异常只回通用文案，完整 message + stack 仅进服务端日志。
      logServerError("waybills.process.stream", error);
      const message=clientMessage(error,"处理流程发生未捕获异常");
      push(JSON.stringify({type:"result",success:false,code:error?.code||"PROCESS_UNHANDLED_ERROR",message,error:message,detail:clientDetail(error),httpStatus:500})+"\n");
      if(heartbeat)clearInterval(heartbeat);
      if(!closed){closed=true;try{controller.close()}catch{}}
    });
  },cancel(){
    closed=true;
    if(heartbeat)clearInterval(heartbeat);
  }});
  return new Response(streamBody,{status:200,headers:{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-store, no-transform","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"}});
}
