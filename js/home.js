const $=id=>document.getElementById(id);
const overlay=$("uploadArea"),cancel=$("sourceCancel");
const todayCount=$("todayCount"),todayWeight=$("todayWeight"),todayStoreList=$("todayStoreList"),todayMetrics=$("todayMetrics"),dot=$("statusDot");
let dispatchRouteId="";
let boundRouteId="";
const TEMP_ROUTE_PREFIX="__temp__:";
const subBadge=$("substituteBadge");
/* 代班态提示：用户当前调度线路是「真实线路」且与本人绑定线路不一致时，视为「代班中」。
   仅作展示（今日配送卡片里一个「代班」状态文字），不碰任何权限逻辑；
   线路名已由卡片 statusDot / 当前线路菜单项展示，这里只补一行状态文案。
   判定要点：
     - 新注册用户 boundRouteId 默认为 null（仅管理员绑定后才有值），且 dispatch GET 会给
       无绑定用户分配每人独立的临时线路 __temp__:<id> 作为「家」；故不能用「boundRouteId 非空」
       作为门槛（那会把所有未绑定账号挡掉，代班提示永远不出现）。
     - 临时线路（__temp__: 开头）算用户的「家」，不算代班；真实线路且非本人绑定线路才算代班。
     - 未绑定账号切到任意真实线路 -> 代班中（他本就没有「自己的线路」，此刻正在替班）。 */
const renderSubstituteBadge=()=>{
  if(!subBadge)return;
  const isSubstitute=!!dispatchRouteId&&!dispatchRouteId.startsWith(TEMP_ROUTE_PREFIX)&&dispatchRouteId!==boundRouteId;
  subBadge.hidden=!isSubstitute;
};
const setEmptyToday=()=>{todayCount.textContent="暂无运单";todayWeight.textContent="";if(todayStoreList)todayStoreList.innerHTML='<div class="today-store-empty">今日暂无配送门店</div>';if(todayMetrics)todayMetrics.innerHTML=""};
const setRouteBadge=(route)=>{if(!dot)return;const type=route?.type||"";const name=String(route?.name||"").trim();
  /* 全局标准：圆点内只显示线路数字（临时线路显示「临」），「X号线」全名用于文字位置 */
  const badge=(type==="temporary"||/临时/.test(name))?"临":(window.zpRouteShort?window.zpRouteShort(name):(name.match(/\d+/)?.[0]||name.replace(/\s+/g,"").slice(0,2)||"—"));
  dot.textContent=badge;dot.hidden=false};

const processingPanel=$("uploadProcessing"),processingError=$("uploadProcessingError"),processingErrorMessage=$("processingErrorMessage"),processingRetry=$("processingRetry"),sourceMenu=$("uploadSourceMenu"),processingPercent=$("processingPercent"),processingProgress=$("processingProgressDot");
const processingStageEl=$("processingStage"),processingElapsedEl=$("processingElapsed"),processingCancelBtn=$("processingCancel");
let processingProgressValue=0;
let processingProgressTarget=0;
let processingProgressFrame=0;
let processingProgressStart=0;
let processingProgressFrom=0;
let processingProgressDuration=0;

/* ===== 等待期体验：让"19 秒干等"变成"看得见的等待" =====
   后端已通过 SSE 推送 progress（含阶段文案 message）与 heartbeat（每秒存活心跳），
   此前前端只取 progress 数字、丢弃 message，且两次 progress 间隔可达 5 秒，
   于是进度条长时间静止、文案始终一句，用户无法判断是"在跑"还是"卡死"。
   这里补三件事，均不伪造进度：
     1) 展示后端真实阶段文案 + 已用时；
     2) 久无新进度但心跳仍到 → 进度条叠加流动微光（存活指示，不改数字）；
     3) 处理超过 8 秒才给出"取消处理"出口（此前处理中无任何退出方式）。 */
const STAGE_DEFAULT="正在准备…";
const STALL_THRESHOLD=1200;   // 超过此毫秒没有新进度即视为停滞
const ALIVE_THRESHOLD=3000;   // 心跳超过此毫秒未到即认为连接已断
const CANCEL_REVEAL_MS=8000;  // 处理多久后才显示取消按钮
let processingController=null;
let processingStartedAt=0;
let processingLastProgressAt=0;
let processingLastSignalAt=0;
let processingCancelled=false;
let processingClockTimer=0;

function setProcessingStage(text){
  if(processingStageEl&&text)processingStageEl.textContent=String(text);
}
function refreshProcessingClock(){
  if(!processingStartedAt)return;
  const elapsed=Date.now()-processingStartedAt;
  if(processingElapsedEl){
    // 超过 15 秒属于 OCR 排队偏慢，给出"稍候"提示，避免用户以为卡死
    processingElapsedEl.textContent="已用时 "+Math.max(0,Math.round(elapsed/1000))+"s"+(elapsed>=15000?" · 稍候":"");
  }
}
function refreshStalledState(){
  const bar=processingProgress?.closest(".processing-progress");
  if(!bar)return;
  const now=performance.now();
  const alive=(now-processingLastSignalAt)<ALIVE_THRESHOLD;
  const stalled=alive&&(now-processingLastProgressAt)>STALL_THRESHOLD;
  bar.classList.toggle("is-stalled",stalled);
}
function startProcessingClock(){
  processingStartedAt=Date.now();
  processingLastProgressAt=performance.now();
  processingLastSignalAt=processingLastProgressAt;
  if(processingClockTimer)clearInterval(processingClockTimer);
  processingClockTimer=setInterval(()=>{
    refreshProcessingClock();
    refreshStalledState();
    if(processingCancelBtn&&!processingCancelled&&(Date.now()-processingStartedAt)>=CANCEL_REVEAL_MS){
      processingCancelBtn.hidden=false;
    }
  },500);
}
function stopProcessingClock(){
  if(processingClockTimer)clearInterval(processingClockTimer);
  processingClockTimer=0;
  processingProgress?.closest(".processing-progress")?.classList.remove("is-stalled");
}

function paintProcessingProgress(value){
  processingProgressValue=Math.max(0,Math.min(100,value));
  const displayValue=Math.round(processingProgressValue);
  if(processingPercent)processingPercent.textContent=displayValue+"%";
  const line=processingProgress?.closest(".processing-progress-line");
  if(line)line.style.setProperty("--progress",processingProgressValue+"%");
  const bar=processingProgress?.closest(".processing-progress");
  if(bar)bar.setAttribute("aria-valuenow",String(displayValue));
}

function animateProcessingProgress(now){
  const elapsed=now-processingProgressStart;
  const ratio=processingProgressDuration>0?Math.min(1,elapsed/processingProgressDuration):1;
  // ease-out：前段变化更明显，后段自然收住；目标值始终来自后端真实进度事件。
  const eased=1-Math.pow(1-ratio,3);
  paintProcessingProgress(processingProgressFrom+(processingProgressTarget-processingProgressFrom)*eased);
  if(ratio<1){
    processingProgressFrame=requestAnimationFrame(animateProcessingProgress);
  }else{
    processingProgressFrame=0;
    paintProcessingProgress(processingProgressTarget);
  }
}

function renderProcessingProgress(value){
  const next=Math.max(0,Math.min(100,Number(value)||0));
  processingLastProgressAt=performance.now();
  processingLastSignalAt=processingLastProgressAt;
  // 后端进度只允许向前推进，避免网络事件乱序造成百分比倒退。
  if(next<processingProgressTarget)return;
  if(processingProgressFrame)cancelAnimationFrame(processingProgressFrame);
  processingProgressTarget=next;
  processingProgressFrom=processingProgressValue;
  processingProgressStart=performance.now();
  const delta=Math.max(0,next-processingProgressFrom);
  // 按实际进度跨度决定过渡时间：小步快、大步平滑，不人为持续增长。
  processingProgressDuration=Math.max(180,Math.min(1800,delta*55));
  processingProgressFrame=requestAnimationFrame(animateProcessingProgress);
}

function resetProcessingProgress(){
  if(processingProgressFrame)cancelAnimationFrame(processingProgressFrame);
  processingProgressFrame=0;
  processingProgressTarget=0;
  processingProgressFrom=0;
  processingProgressStart=0;
  processingProgressDuration=0;
  paintProcessingProgress(0);
}
function resetProcessingUI(){
  stopProcessingClock();
  processingStartedAt=0;
  processingCancelled=false;
  if(processingCancelBtn)processingCancelBtn.hidden=true;
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  sourceMenu.hidden=false;processingPanel.hidden=true;
  renderProcessingProgress(0);
}
/* ===== 处理失败 → 重试动作映射（纯函数，tests/unit-retry-action.test.mjs 切片验证） =====
   与后端 process.js 的 failProcess 信封对齐：recoverable && action 才允许前端重试。
   - autoRetry=true 且复用同一文件：RETRY_OCR / RETRY_SAVE / REPROCESS（点按钮即重跑同一文件）
   - autoRetry=false：RESUBMIT 需重新选文件（回来源菜单）、RETRY_LATER 仅提示稍后（按钮作关闭用） */
/* [RETRY-MAP-START] */
const RETRY_ACTION_INFO={
  RETRY_OCR:{label:"重新识别",autoRetry:true},
  RETRY_SAVE:{label:"重试保存",autoRetry:true},
  REPROCESS:{label:"重新处理",autoRetry:true},
  RESUBMIT:{label:"重新上传",autoRetry:false},
  RETRY_LATER:{label:"请稍后重试",autoRetry:false}
};
function retryActionInfo(action){
  if(!action||!RETRY_ACTION_INFO[action])return null;
  return RETRY_ACTION_INFO[action];
}
/* [RETRY-MAP-END] */
const PROCESS_ERROR_TEXT={
  OCR_RESULT_TIMEOUT:"OCR结果读取超时（已自动重试仍失败），请重新上传重试",
  OCR_TIMEOUT:"OCR识别超时，请稍后重试",
  OCR_NETWORK_TIMEOUT:"OCR服务响应超时，请稍后重试",
  OCR_JOB_FAILED:"OCR识别失败，请上传更清晰的运单照片",
  OCR_EMPTY:"OCR未识别到文字，请上传更清晰的运单照片",
  OCR_NOT_CONFIGURED:"OCR服务尚未配置，请联系管理员",
  OCR_AUTH:"OCR服务鉴权失败，请联系管理员",
  OCR_ENDPOINT:"OCR服务地址异常，请联系管理员",
  OCR_API:"OCR服务暂时不可用，请稍后重试",
  OCR_BAD_RESPONSE:"OCR服务返回异常，请稍后重试",
  OCR_SUBMIT_FAILED:"OCR任务提交失败，请稍后重试",
  OCR_RESULT_MISSING:"OCR结果地址缺失，请重试",
  OCR_RESULT_FETCH:"OCR结果读取失败，请重试",
  PROCESS_CLIENT_TIMEOUT:"处理超时（60秒），请稍后重试或换更清晰的运单图片",
  PROCESS_STREAM_INTERRUPTED:"处理连接中断，请重试",
  EXTRACT_EMPTY:"未从运单中提取到门店，请检查运单内容",
  DISPATCH_ROUTE_MISSING:"请先在首页选择调度线路",
  WAYBILL_FILE_MISSING:"请选择运单文件"
};
function showProcessingError(message, hint, action, recoverable, requestId){
  stopProcessingClock();
  if(processingCancelBtn)processingCancelBtn.hidden=true;
  if(processingPanel)processingPanel.hidden=true;
  if(sourceMenu)sourceMenu.hidden=true;
  if(overlay)overlay.classList.add("processing-error-state");
  const text=PROCESS_ERROR_TEXT[message]||message||"处理失败，请重试";
  if(processingErrorMessage)processingErrorMessage.textContent=text+(hint?(" "+hint+" "):"");
  // 仅当后端声明可恢复且给出了动作时，按钮才是「一键重试」；否则隐藏为关闭按钮
  lastFailureAction=(recoverable&&action)?action:null;
  lastFailureRequestId=(recoverable&&action)?(requestId||null):null;
  if(processingRetry)processingRetry.textContent=retryActionInfo(lastFailureAction)?.label||"关闭";
  if(processingError)processingError.hidden=false;
}
function showProcessingUI(){
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  sourceMenu.hidden=true;processingPanel.hidden=false;
  processingCancelled=false;
  if(processingCancelBtn)processingCancelBtn.hidden=true;
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  renderProcessingProgress(0);
  startProcessingClock();
  refreshProcessingClock();
}
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
}
// 首页上传按钮 toggle（以首页为标准点）：第一次点击打开上传弹窗，
// 弹窗已开时再点即关闭（回到首页标准态）。closeUpload 自带处理中保护。
$("uploadAction")?.addEventListener("click",()=>{if(overlay&&!overlay.hidden)closeUpload();else openUpload()});
if(new URLSearchParams(location.search).get("openUpload")==="1")setTimeout(openUpload,0);
cancel?.addEventListener("click",closeUpload);
// 处理中的唯一退出方式：处理期间取消按钮被隐藏，等待超过 8 秒后才给出出口，
// 既保留处理锁（防重复提交、防误触关闭），又不把用户永久锁在弹窗里。
processingCancelBtn?.addEventListener("click",()=>{
  if(!processingFile||!processingController)return;
  processingCancelled=true;
  processingCancelBtn.disabled=true;
  try{processingController.abort()}catch{}
});
processingRetry?.addEventListener("click",()=>{
  if(processingFile)return;   // 处理中禁止重复触发
  const info=retryActionInfo(lastFailureAction);
  if(lastFailureAction==="RETRY_SAVE"&&lastProcessingFile&&lastFailureRequestId){
    // RETRY_SAVE：仅重保存（后端按 resumeRequestId 复用已构建 order，跳过 OCR/提取/匹配/规划），不重 OCR
    processSelectedFiles(lastProcessingFile, lastFailureRequestId);
  }else if(info&&info.autoRetry&&lastProcessingFile){
    // RETRY_OCR / REPROCESS：复用同一文件重跑完整链路（含 OCR）
    processSelectedFiles(lastProcessingFile);
  }else if(info&&lastFailureAction==="RESUBMIT"){
    // 需重新选文件：回到来源菜单
    openUpload();
  }else{
    // 不可重试（含非 recoverable）：按钮作关闭用
    closeUpload();
  }
});
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});

async function ensureDispatchRoute(){
  if(dispatchRouteId)return true;
  try{
    const r=await fetch("/api/dispatch",{credentials:"same-origin",cache:"no-store"});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.success&&d.dispatchRoute?.id){
      dispatchRouteId=d.dispatchRoute.id;
      return true;
    }
  }catch{}
  return false;
}

function chooseFile(source){
  const input=source==="camera"?$("cameraInput"):source==="photo"?$("photoInput"):$("documentInput");
  if(!input)return;
  input.value="";
  input.click();
}
document.querySelectorAll(".source-option").forEach(btn=>btn.addEventListener("click",()=>chooseFile(btn.dataset.source)));

let processingFile=false;
// 供统一业务导航判断：处理中的运单离开当前工作流前必须经过确认。
window.zpIsProcessing=()=>!!processingFile||!!processingController;
let lastProcessingFile=null;   // 最近一次处理的运单图片组/文件，供一键重试复用
let lastFailureAction=null;    // 最近一次失败的处理动作（action）；null 表示不可重试，按钮作关闭用
let lastFailureRequestId=null; // 最近一次失败的处理票据 requestId（RETRY_SAVE 仅重保存时回传后端 resume）
async function processSelectedFiles(files, resumeRequestId){
  if(!Array.isArray(files))files=files?[files]:[];
  files=files.filter(Boolean);
  if(!files.length||processingFile)return;
  processingFile=true;
  lastProcessingFile=files.slice();
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
        location.replace("/pages/order_detail.html?id="+detailId+"&source=process&dedupe=1");
      }else{
        location.replace("/pages/order_detail.html?id="+detailId+"&source=process&from=process");
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
    if(wasCancelled){
      closeUpload();
      try{window.zpToast?.("已取消处理","success")}catch{}
    }
  }
}
["cameraInput","photoInput","documentInput"].forEach(id=>$(id)?.addEventListener("change",e=>processSelectedFiles(Array.from(e.target.files||[]))));

async function loadHome(){
  const fetchJson=async(url,timeoutMs=8000)=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await fetch(url,{credentials:"same-origin",cache:"no-store",signal:controller.signal});
      const data=await res.json().catch(()=>({}));
      return {res,data};
    }finally{clearTimeout(timer);}
  };
  try{
    // 首页依赖「有效线路」而非仅 dispatchRouteId：
    // 已绑定但未选调度线路的业务用户，/api/dispatch 返回 dispatchRoute:null
    // （临时线路仅在「既无 dispatchRouteId 也无 boundRouteId」时才会分配），
    // 此时必须以 boundRouteId 兜底，否则今日配送永远读不到数据。
    // 该问题在 8d4b9b6 重排 loadHome 后暴露：layer1 被 `if(dispatchRouteId)` 跳过，
    // layer2/3 又用 waybill.routeId==="" 过滤，永不命中 → 显示「暂无运单」。
    const [{res:dispatchRes,data:dispatch},{res:meRes,data:me}]=await Promise.all([
      fetchJson("/api/dispatch"),
      fetchJson("/api/me?homeMe="+Date.now())
    ]);
    if(!dispatchRes.ok||!dispatch.success)throw Error(dispatch.error||"当前配送线路读取失败");
    dispatchRouteId=dispatch.dispatchRoute?.id||"";
    boundRouteId=me&&me.user&&me.user.boundRouteId?String(me.user.boundRouteId):(boundRouteId||"");
    renderSubstituteBadge();
    setRouteBadge(dispatch.dispatchRoute||null);
    // 有效线路 = 显式调度线路（含临时线路）优先，其次管理员绑定线路
    const effectiveRouteId=dispatchRouteId||boundRouteId;

    const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let w=null;
    // 比对键：默认用 effectiveRouteId，但一旦拿到服务端回显的 routeId 就以它为准。
    // 背景：dispatch.dispatchRoute.id 来自 route:<id> 存储体内部的 id 字段，若与
    // Redis 键 id（即会话 dispatchRouteId、运单 routeId）发生数据漂移，前端用
    // dispatchRoute.id 过滤会全部落空（表现为徽标/月度正常、今日配送恒为空）。
    // /api/history 的响应体里回显了服务端实际使用的 routeId，用它比对可免疫漂移。
    let cmpRouteId=effectiveRouteId;

    // 首页“今日配送”以 latest 后端选择结果为唯一权威候选。
    // 历史接口负责列表/统计，不让首页在多张当日运单中自行重新选一张，
    // 避免同日多次上传时出现“刚上传A，首页却显示B”的数据分叉。
    if(effectiveRouteId){
      try{
        const {res,data}=await fetchJson("/api/waybills/latest",20000);
        if(res.ok&&data.success&&data.waybill&&data.waybill.routeId===cmpRouteId&&data.waybill.date===todayKey){
          w=data.waybill;
        }
      }catch{}
    }

    // latest 异常时才回退到当天历史；回退仍按后端返回的 createdAt 顺序取最后一张。
    if(!w&&effectiveRouteId){
      try{
        const {res,data}=await fetchJson("/api/history?date="+encodeURIComponent(todayKey),20000);
        const list=Array.isArray(data.waybills)?data.waybills:[];
        if(res.ok&&data.success!==false){
          const serverRoute=String(data.routeId||"").trim();
          if(serverRoute)cmpRouteId=serverRoute;
          const usable=list.filter(x=>x&&x.routeId===cmpRouteId&&x.date===todayKey);
          usable.sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
          w=usable[usable.length-1]||null;
        }
      }catch{}
    }

    // 第三层复用月度统计已经成功读取的数据索引。若单日接口异常，
    // 只要月度历史能看到今天，就根据当天运单 ID 再取完整运单，避免出现“月度有数据、今日却为空”。
    if(!w&&effectiveRouteId){
      try{
        const {res,data}=await fetchJson("/api/history?months=13",20000);
        if(res.ok&&data.success!==false){
          const serverRoute=String(data.routeId||"").trim();
          if(serverRoute)cmpRouteId=serverRoute;
          const todayEntry=(Array.isArray(data.history)?data.history:[]).find(x=>x?.date===todayKey&&Number(x?.count)>0);
          const id=Array.isArray(todayEntry?.waybillIds)?todayEntry.waybillIds[todayEntry.waybillIds.length-1]:"";
          if(id){
            const {res:detailRes,data:detail}=await fetchJson("/api/waybills/latest?id="+encodeURIComponent(id),20000);
            if(detailRes.ok&&detail.success&&detail.waybill&&detail.waybill.routeId===cmpRouteId&&detail.waybill.date===todayKey)w=detail.waybill;
          }
        }
      }catch{}
    }

    // 摘要与门店明细分开渲染：stores 异常绝不允许把今日数量/重量卡在“加载中”。
    if(w&&w.routeId===cmpRouteId){
      const stores=Array.isArray(w.stores)?w.stores:[];
      const total=Number(w.summary?.finalCount)||Number(w.summary?.total)||stores.length||0;
      // 渲染辅助函数必须定义在两个渲染块的共享作用域：
      // 此前 esc 等定义在 if(todayStoreList) 块内，todayMetrics 块引用时
      // ReferenceError → 被外层 catch 静默吞掉 → 整卡「暂无运单」。
      // 数量语义已统一：只显示最终门店数及必要的自动恢复数。
      const navOf=x=>String(x?.navigation||x?.nav||"").trim();
      const safeUrl=v=>{try{const u=new URL(String(v||"").trim(),location.origin);return /^(https?:)$/.test(u.protocol)?u.href:""}catch{return""}};
      const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
      const attr=v=>esc(v).replace(/'/g,"&#39;");
      todayCount.textContent=total+"家";
      todayWeight.textContent=(Math.round((Number(w.totalWeight)||0)*100)/100).toFixed(2)+"t";

      if(todayStoreList){
        try{
          todayStoreList.innerHTML=stores.length?stores.map((x,i)=>{
            const name=esc(x?.name||x?.rawName||"未识别门店"),nav=safeUrl(navOf(x));
            const body='<span class="today-store-index">'+(i+1)+'</span><span class="today-store-name">'+name+'</span>';
            return nav?'<a class="today-store-row" href="'+attr(nav)+'" target="_self">'+body+'</a>':'<div class="today-store-row">'+body+'</div>';
          }).join(""):'<div class="today-store-empty">今日暂无配送门店</div>';
        }catch{
          todayStoreList.innerHTML='<div class="today-store-empty">今日门店明细暂不可用</div>';
        }
      }

      if(todayMetrics){
        const s=w.summary||{},metrics=[];
        if(Number(s.recoveredCount)>0)metrics.push("恢复"+s.recoveredCount+"家");
        if(Number(s.correction)>0)metrics.push("更正"+s.correction+"家");
        if(Number(s.merged)>0)metrics.push("合并"+s.merged+"家");
        if(Number(s.newStores)>0)metrics.push("新增"+s.newStores+"家");
        if(stores.some(x=>x?.pending))metrics.push("待定"+stores.filter(x=>x?.pending).length+"家");
        if(w.quality?.level==="REVIEW")metrics.push("需复核");
        todayMetrics.innerHTML=metrics.map(x=>'<span>'+esc(x)+'</span>').join("");
      }
    }else{
      setEmptyToday();
    }
  }catch(e){
    // 所有异常都必须结束 loading 状态，不能让首页永久停留在“加载中…”。
    console.error("[loadHome] 异常:",e&&e.stack||e);
    setEmptyToday();
  }
}
loadHome();

// 首页的「两次返回才退出」与系统返回已统一到 ui-unified.js 中央控制器。
// 这里只注册本页返回层级：上传 Bottom Sheet → 下拉菜单。
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>$("uploadArea"),close:()=>{
     // 运单正在处理中：拒绝关闭，绝不穿透到「退出应用」
     if(typeof processingFile!=="undefined"&&processingFile){
       try{window.zpToast?window.zpToast("运单处理中，请稍候","error"):0}catch{}
       return false;
     }
     closeUpload();return true;
   }},
);