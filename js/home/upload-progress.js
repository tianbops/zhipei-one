/* home/upload-progress.js —— 处理期等待体验：进度动画 / 已用时 / 停滞微光 / 阶段文案
   依赖 core 的 $；不伪造进度，百分比只来自后端真实 progress 事件。 */

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
  const now=performance.now();
  // 即使收到乱序的旧事件，也记录连接仍有活动；但不能把它当成新进度，
  // 否则停滞指示会被旧百分比反复重置，掩盖真正的处理停顿。
  processingLastSignalAt=now;
  // 后端进度只允许向前推进，避免网络事件乱序造成百分比倒退。
  if(next<processingProgressTarget)return;
  processingLastProgressAt=now;
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
  if(processingCancelBtn){processingCancelBtn.hidden=true;processingCancelBtn.disabled=false;}
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  // 隐藏的同时清空文案：仅 hidden 会把上一次失败的错误码/提示留在 DOM 里，
  // 读屏工具与 DOM 检索仍可读到（2026-10-24 线上核查发现）。
  if(processingErrorMessage)processingErrorMessage.textContent="";
  if(processingRetry)processingRetry.textContent="请重试";
  sourceMenu.hidden=false;processingPanel.hidden=true;
  resetProcessingProgress();
}