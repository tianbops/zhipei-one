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
// 供统一业务导航判断：处理中的运单离开当前工作流前必须经过确认。
window.zpIsProcessing=()=>!!processingFile||!!processingController;
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
async function processWaybill({files=[],rawText="",resumeRequestId=null}={}){
  if(!Array.isArray(files))files=files?[files]:[];
  files=files.filter(Boolean);
  if((!files.length&&!rawText&&!resumeRequestId)||processingFile)return;
  processingFile=true;
  lastProcessingFile=null;
  const controller=new AbortController();
  processingController=controller;
  if(processingCancelBtn){processingCancelBtn.hidden=true;processingCancelBtn.disabled=false}
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
    files.forEach(file=>fd.append("file",file));
    if(rawText)fd.append("rawText",rawText);
    fd.append("fileCount",String(files.length));
    fd.append("routeId",processingRouteIdLocal);
    fd.append("processingRouteId",processingRouteIdLocal);
    if(resumeRequestId)fd.append("resumeRequestId",resumeRequestId);
    renderProcessingProgress(3);
    let r;
    try{
      r=await fetch("/api/waybills/process?stream=1",{method:"POST",body:fd,credentials:"same-origin",signal:controller.signal});
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
        location.replace("/pages/order_detail?id="+detailId+"&source=process&from=process");
      }
    }catch(e){
      if(e?.name==="AbortError"){
        // 用户主动取消不算错误：静默收尾，由 finally 关闭面板并提示
        if(processingCancelled)return;
        throw Object.assign(new Error("运单处理超时，请检查OCR服务后重试"),{code:"PROCESS_CLIENT_TIMEOUT"});
      }
      throw e;
    }
  }catch(e){
    // 优先展示服务端友好 message（与 code 不同时）；纯 code 场景走映射表
    showProcessingError(e?.message&&e.message!==e.code?e.message:(e?.code||"PROCESS_FAILED"), e?.hint, e?.action, e?.recoverable, e?.requestId);
  }finally{
    stopProcessingClock();
    document.querySelectorAll(".source-option").forEach(b=>b.disabled=false);
    processingFile=false;
    const wasCancelled=processingCancelled;
    processingController=null;
    // 释放前端对原图 File 对象的引用；历史记录只保留业务结果，不保留图片/文本。
    files.length=0;
    rawText="";
    lastProcessingFile=null;
    ["cameraInput","photoInput","documentInput"].forEach(id=>{const input=$(id);if(input)input.value="";});
    if(wasCancelled){
      closeUpload();
      try{window.zpToast?.("已取消处理","success")}catch{}
    }
  }
}
["cameraInput","photoInput","documentInput"].forEach(id=>$(id)?.addEventListener("change",e=>{
  const input=e.target;
  const files=Array.from(input.files||[]);
  // 立刻清空文件控件的持有状态；当前处理只使用内存中的临时引用。
  input.value="";
  processSelectedFiles(files);
}));