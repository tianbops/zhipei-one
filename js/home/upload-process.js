/* home/upload-process.js —— 线路就绪、选文件、SSE 流式处理主流程
   依赖 core、upload-progress、upload-error、upload-sheet。 */

async function ensureDispatchRoute(){
  if(dispatchRouteId)return true;
  try{
    const r=await zpFetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.success&&d.dispatchRoute?.id){
      dispatchRouteId=d.dispatchRoute.id;
      return true;
    }
  }catch{}
  return false;
}

function chooseFile(source){
  // text 来源没有文件控件：弹层切换到文本面板由 upload-sheet.js 的面板逻辑处理
  if(source==="text")return;
  const input=source==="camera"?$("cameraInput"):source==="photo"?$("photoInput"):$("documentInput");
  if(!input)return;
  input.value="";
  input.click();
}
document.querySelectorAll(".source-option").forEach(btn=>btn.addEventListener("click",()=>chooseFile(btn.dataset.source)));

let processingFile=false;
let processingRequestId=null;
let processingRequestStarted=false;
// 供统一业务导航判断：处理中的运单离开当前工作流前必须经过确认。
window.zpIsProcessing=()=>!!processingFile||!!processingController;
window.zpLeaveProcessing=async function(href){
  if(!window.zpIsProcessing())return false;
  const ok=await window.zpConfirm("退出本次处理？","本次识别与规划将中止，尚未保存的结果不会保留。","退出本次处理");
  if(!ok)return false;
  // 请求已经发出但服务端任务编号尚未到达时，不能跳过服务端取消确认。
  // 留在当前页等待首个带 requestId 的进度事件，再由用户重新发起退出。
  if(processingRequestStarted&&!processingRequestId){
    try{window.zpToast?.("处理状态正在建立，请稍候再退出","info")}catch{}
    return false;
  }
  if(processingRequestId){
    let response=null;
    try{
      response=await fetch("/api/waybills/cancel",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",body:JSON.stringify({requestId:processingRequestId})});
    }catch{
      try{window.zpToast?.("暂时无法确认取消状态，请保持当前页面","error")}catch{}
      return false;
    }
    const state=await response.json().catch(()=>({}));
    if(!response.ok||state.state!=="cancelled"){
      try{window.zpToast?.(state.message||(state.state==="saving"?"运单正在保存，请等待结果":"当前处理暂不能退出，请等待结果"),"info")}catch{}
      return false;
    }
  }
  if(processingController&&!processingController.signal.aborted)processingController.abort({code:"USER_CANCELLED"});
  processingRequestId=null;
  location.replace(href||"/home");
  return true;
};
let lastProcessingFile=null;   // 兼容旧状态；处理结束后立即清空，不用于图片重试
let lastFailureAction=null;    // 最近一次失败的处理动作（action）；null 表示不可重试，按钮作关闭用
let lastFailureRequestId=null; // 最近一次失败的处理票据 requestId（RETRY_SAVE 仅重保存时回传后端 resume）
// 文本直录入口：后端 /api/waybills/process 原生支持 rawText 字段——
// 有文字即整段跳过 OCR，直接进「提取 → 匹配 → 去重 → 规划 → 校验 → 落库」，与 OCR 文本同一条管线。
async function processPastedText(text){
  const raw=String(text??"").trim();
  if(processingFile)return;
  if(!raw){try{window.zpToast?.("请先粘贴运单文本","info")}catch{}return}
  if(raw.length>50000){try{window.zpToast?.("文本过长，请分次录入","info")}catch{}return}
  lastFailureSource="text";
  return processWaybill({rawText:raw});
}
let lastFailureSource="file";   // 最近一次失败的录入方式：file（选文件）或 text（粘贴文本），驱动重试回位
async function processSelectedFiles(files, resumeRequestId){
  lastFailureSource="file";
  return processWaybill({files,resumeRequestId});
}
/* 上传前压缩：手机截图常见 2-5MB，跨境上传 + OCR 任务提交耗时占大头（实测单张
   OCR 提交 3.8s）。长边压到 1600、JPEG 0.82 后体积通常降到 300-600KB，运单文字
   仍然清晰；压完不比原图小、或不支持解码（HEIC 等）时一律回退原图，绝不阻断上传。 */
async function compressImageForUpload(file,{maxSide=1600,quality=0.82}={}){
  try{
    if(!file||!/^image\//i.test(file.type||""))return file;
    if(file.size<=420*1024)return file;
    if(typeof createImageBitmap!=="function")return file;
    const bmp=await createImageBitmap(file);
    const scale=Math.min(1,maxSide/Math.max(bmp.width,bmp.height));
    const w=Math.max(1,Math.round(bmp.width*scale)),h=Math.max(1,Math.round(bmp.height*scale));
    if(scale>=1&&file.size<=900*1024){bmp.close&&bmp.close();return file}
    const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext("2d");
    if(!ctx){bmp.close&&bmp.close();return file}
    ctx.drawImage(bmp,0,0,w,h);bmp.close&&bmp.close();
    const blob=await new Promise(res=>{try{canvas.toBlob(res,"image/jpeg",quality)}catch{res(null)}});
    if(!blob||blob.size>=file.size)return file;
    const name=(file.name||"image").replace(/\.[^.]+$/,"")+".jpg";
    return new File([blob],name,{type:"image/jpeg",lastModified:Date.now()});
  }catch{return file}
}

async function processWaybill({files=[],rawText="",resumeRequestId=null}={}){
  if(!Array.isArray(files))files=files?[files]:[];
  files=files.filter(Boolean);
  if((!files.length&&!rawText&&!resumeRequestId)||processingFile)return;
  processingFile=true;
  processingRequestId=null;
  processingRequestStarted=false;
  const perfProcessStartedAt=performance.now();
  let perfCompressMs=0,perfRequestStartedAt=0,perfResponseAt=0,perfResponseStatus=null,perfStreamComplete=false,perfResult=null,perfRecorded=false,perfFailureStatus=null;
  lastProcessingFile=null;
  const controller=new AbortController();
  processingController=controller;
  try{
    if(!(await ensureDispatchRoute())){
      showProcessingError("DISPATCH_ROUTE_MISSING");
      return;
    }
    // 处理开始时捕获线路：即使后续在流式 OCR 期间切线路，本次提交也固定用此线路，
    // 由后端 processingRouteId 二次校验兜底，避免误写其它线路（P1 #17）。
    const processingRouteIdLocal=dispatchRouteId;
    showProcessingUI();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=true);
    const fd=new FormData();
    const perfCompressStartedAt=performance.now();
    // 逐张压缩后再上传（串行处理，避免多张大图同时解码占满内存）
    if(files.length){
      setProcessingStage(files.length>1?`正在准备 ${files.length} 张截图…`:"正在准备运单图片…");
      const prepared=[];
      for(const f of files){if(controller.signal.aborted)throw Object.assign(new Error("本次处理已中止"),{code:"USER_CANCELLED"});prepared.push(await compressImageForUpload(f));}
      prepared.forEach(file=>fd.append("file",file));
    }
    perfCompressMs=performance.now()-perfCompressStartedAt;
    if(rawText)fd.append("rawText",rawText);
    fd.append("fileCount",String(files.length));
    fd.append("routeId",processingRouteIdLocal);
    fd.append("processingRouteId",processingRouteIdLocal);
    if(resumeRequestId)fd.append("resumeRequestId",resumeRequestId);
    renderProcessingProgress(3);
    if(controller.signal.aborted)throw Object.assign(new Error("本次处理已中止"),{code:"USER_CANCELLED"});
    let r;
    try{
      processingRequestStarted=true;
      perfRequestStartedAt=performance.now();
      r=await fetch("/api/waybills/process?stream=1",{method:"POST",body:fd,credentials:"same-origin",signal:controller.signal});
      perfResponseStatus=r.status;
      perfResponseAt=performance.now();
      if(!r.ok){
        // HTTP 错误也可能携带后端的可恢复动作（例如 RETRY_SAVE / RESUBMIT）。
        // 不能只看状态码，否则 503 后端已明确允许重试时，前端会把动作信息丢掉。
        let errorBody=null;
        try{errorBody=await r.clone().json()}catch{}
        const httpError=new Error(errorBody?.message||errorBody?.error||"运单处理服务暂时不可用，请重试");
        httpError.code=errorBody?.code||("PROCESS_HTTP_"+r.status);
        httpError.hint=errorBody?.hint||null;
        httpError.action=errorBody?.action||null;
        httpError.recoverable=!!errorBody?.recoverable;
        httpError.requestId=errorBody?.requestId||null;
        throw httpError;
      }
      const reader=r.body?.getReader();
      if(!reader)throw Object.assign(new Error("当前浏览器不支持实时处理进度"),{code:"PROCESS_STREAM_UNSUPPORTED"});
      const decoder=new TextDecoder();
      let buffer="",result=null;
      while(true){
        const chunk=await reader.read();
        if(chunk.done)break;
        buffer+=decoder.decode(chunk.value,{stream:true});
        const lines=buffer.split("\n");
        buffer=lines.pop()||"";
        for(const line of lines){
          if(!line.trim())continue;
          let event;
          try{event=JSON.parse(line)}catch{continue}
          if(event.type==="progress"){
            if(event.requestId)processingRequestId=String(event.requestId);
            renderProcessingProgress(event.progress);
            // 后端每个阶段都带了中文说明，此前被前端丢弃，导致全程只有一句固定文案
            if(event.message)setProcessingStage(event.message);
          }
          else if(event.type==="heartbeat"){
            // 心跳只证明"还活着"，不推进进度；停滞微光靠它判断连接是否正常
            processingLastSignalAt=performance.now();
          }
          else if(event.type==="result")result=event;
        }
      }
      buffer+=decoder.decode();
      if(buffer.trim()){
        try{const event=JSON.parse(buffer);if(event.type==="result")result=event}catch{}
      }
      if(!result)throw Object.assign(new Error("处理连接中断，请重试"),{code:"PROCESS_STREAM_INTERRUPTED"});
      perfResult=result;
      perfStreamComplete=true;
      if(!result.success){
        const code=result.code||result.errorCode||"PROCESS_FAILED";
        // 透传 action/recoverable：前者驱动「一键重试」按钮行为，后者决定按钮是否出现
        throw Object.assign(new Error(result.message||result.error||"处理失败"),{code, hint:result.hint||null, action:result.action||null, recoverable:!!result.recoverable, requestId:result.requestId||null});
      }
      renderProcessingProgress(100);
      const detailId=encodeURIComponent(result.waybill.id);
      if(result.idempotent){
        // 当日同车辆+同门店+同重量运单已存在：复用已有运单，不再生成重复记录。
        try{window.zpToast?.("当日该车辆、门店及重量一致的运单已存在，已为你打开已有运单","info")}catch{}
        location.replace("/pages/order_detail?id="+detailId+"&source=process&dedupe=1");
      }else{
        // 同日同车辆、门店高度重叠的旧单已在后端被取代（重传即替换），
        // 把数量带到详情页提示一次，让用户知道统计已回到单张口径。
        const supN=Array.isArray(result.superseded)?result.superseded.length:0;
        location.replace("/pages/order_detail?id="+detailId+"&source=process&from=process"+(supN?"&superseded="+supN:""));
      }
    }catch(e){
      if(e?.name==="AbortError"){
        const reason=controller.signal?.reason;
        if(reason?.code==="USER_CANCELLED"){perfFailureStatus="cancelled";throw Object.assign(new Error("本次处理已中止"),{code:"USER_CANCELLED"})}
        perfFailureStatus=reason?.name==="TimeoutError"?"timeout":"abort";
        // 没有「取消处理」按钮之后，Abort 只可能来自网络中断/页面卸载，
        // 一律按超时提示，让用户有明确的重试动作；遥测仍保留真实 Abort 分类。
        throw Object.assign(new Error("运单处理超时，请检查OCR服务后重试"),{code:"PROCESS_CLIENT_TIMEOUT"});
      }
      if(e?.name==="TimeoutError")perfFailureStatus="timeout";
      throw e;
    }
  }catch(e){
    if(e?.code==="USER_CANCELLED")return;
    // 优先展示服务端友好 message（与 code 不同时）；纯 code 场景走映射表
    showProcessingError(e?.message&&e.message!==e.code?e.message:(e?.code||"PROCESS_FAILED"), e?.hint, e?.action, e?.recoverable, e?.requestId);
  }finally{
    if(perfRequestStartedAt&&!perfRecorded){
      const perfEndedAt=performance.now(),perfDuration=perfEndedAt-perfProcessStartedAt;
      const timing=perfResult?.processingTiming&&typeof perfResult.processingTiming==="object"?perfResult.processingTiming:(perfResult?.timing&&typeof perfResult.timing==="object"?perfResult.timing:((!perfResult?.idempotent&&perfResult?.waybill?.timing&&typeof perfResult.waybill.timing==="object")?perfResult.waybill.timing:{}));
      const phases={
        "waybill-client-compress":perfCompressMs,
        "waybill-client-first-response":Math.max(0,perfResponseAt-perfRequestStartedAt),
        "waybill-client-stream":perfResponseAt?Math.max(0,perfEndedAt-perfResponseAt):0,
        "waybill-client-total":perfDuration
      };
      const timingFields={
        "waybill-server-recognized":"recognizedMs",
        "waybill-server-ocr":"ocrMs",
        "waybill-server-ocr-submit":"ocrSubmitMs",
        "waybill-server-ocr-status-wait":"ocrStatusWaitMs",
        "waybill-server-ocr-status-request":"ocrStatusRequestMs",
        "waybill-server-ocr-result-fetch":"ocrResultFetchMs",
        "waybill-server-base":"baseMs",
        "waybill-server-extract":"extractMs",
        "waybill-server-match":"matchMs",
        "waybill-server-dedupe":"dedupeMs",
        "waybill-server-plan":"planMs",
        "waybill-server-total":"totalMs"
      };
      for(const [name,key] of Object.entries(timingFields)){const value=Number(timing[key]);if(Number.isFinite(value)&&value>=0)phases[name]=value;}
      const saveStageFields={
        "waybill-server-save-claim":"saveClaimMs",
        "waybill-server-save-fingerprint":"saveFingerprintMs",
        "waybill-server-save-daily-signature":"saveDailySignatureMs",
        "waybill-server-save-dedupe-scan":"saveDedupeScanMs",
        "waybill-server-save-atomic":"saveAtomicMs",
        "waybill-server-save-supersede":"saveSupersedeMs",
        "waybill-server-save-lifecycle-events":"saveLifecycleEventsMs",
        "waybill-server-save-day-meta":"saveDayMetaMs",
        "waybill-server-save-finish-proc":"saveFinishProcMs",
        "waybill-server-save-total":"totalMs"
      };
      const saveStages=timing.saveStages&&typeof timing.saveStages==="object"?timing.saveStages:{};
      for(const [name,key] of Object.entries(saveStageFields)){const value=Number(saveStages[key]);if(Number.isFinite(value)&&value>=0)phases[name]=value;}
      const serverTiming=String(perfResult?.serverTiming||"");
      const serverTimingValue=name=>{const match=serverTiming.match(new RegExp(name+";dur=([0-9]+(?:\\.[0-9]+)?)"));return match?Number(match[1]):null;};
      const r2CleanupMs=serverTimingValue("waybill-r2-cleanup");
      const endToEndMs=serverTimingValue("waybill-server-end-to-end");
      if(r2CleanupMs!==null)phases["waybill-server-r2-cleanup"]=r2CleanupMs;
      if(endToEndMs!==null)phases["waybill-server-end-to-end"]=endToEndMs;
      const server=Number.isFinite(endToEndMs)?endToEndMs:(Number.isFinite(Number(timing.totalMs))?Number(timing.totalMs):null);
      const status=perfFailureStatus||(perfResponseStatus===null?"network":(!perfStreamComplete&&perfResponseStatus<400?"network":(perfResult?.success===false&&Number.isInteger(perfResult?.httpStatus)?perfResult.httpStatus:perfResponseStatus)));
      try{window.zpPerfRecord?.("api-waybill-process",status,perfDuration,server,phases)}catch{}
      perfRecorded=true;
    }
    stopProcessingClock();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=false);
    processingFile=false;
    processingRequestStarted=false;
    processingController=null;
    processingRequestId=null;
    // 释放前端对原图 File 对象的引用；历史记录只保留业务结果，不保留图片/文本。
    files.length=0;
    rawText="";
    lastProcessingFile=null;
    ["cameraInput","photoInput","documentInput"].forEach(id=>{const input=$(id);if(input)input.value="";});
  }
}
["cameraInput","photoInput","documentInput"].forEach(id=>$(id)?.addEventListener("change",e=>{
  const input=e.target;
  const files=Array.from(input.files||[]);
  // 立刻清空文件控件的持有状态；当前处理只使用内存中的临时引用。
  input.value="";
  processSelectedFiles(files);
}));