/**
 * 智配One · 前端请求自动重试（P0-8）
 * ------------------------------------------------------------------
 * 背景：此前前端**没有任何自动重试**（实测 js/*.js 里 `backoff` 命中数为 0）。
 * 所谓"重试"是失败后弹一个按钮让用户自己再点一次。
 * 而这条链路的实测特征是**分钟级 10 倍抖动**（同一 URL 隔几分钟可从 300ms 变 14s），
 * 也就是说大量失败是瞬时的：下一秒再打一次就成功。把这种失败抛给用户点按钮，
 * 是把网络抖动伪装成了业务错误。
 *
 * 三条纪律（改这里前先看）：
 *   1. **默认只重试 GET/HEAD**。POST 一律不自动重试——运单提交、审核批准这类写操作
 *      重放一次就是一次重复业务，宁可让用户点按钮，也不能替他决定再提交一次。
 *      确需重试的写操作必须显式传 {zpIdempotent:true}（且调用方自己保证幂等）。
 *   2. **只重试"值得重试"的失败**：网络中断 / 超时 / 429 / 5xx。
 *      其它 4xx（401 未登录、403 无权限、409 状态冲突）重试一万次也是同样的错，
 *      重试只会让用户在原地多等几秒再看到同一个错误。
 *   3. **弱网不加重试**：省流量模式（saveData）下完全不重试——用户明确表达了要省流量；
 *      2g/slow-2g 只重试一次——本来就窄的管道，不该被同一份数据灌两遍。
 *
 * 退避：400ms → 800ms（×2 指数），叠加 0~250ms 抖动打散重试尖峰，
 * 单次上限 3s。429 时优先听服务端的 Retry-After（服务端刚上了登录/注册限流，会带这个头）。
 */
(function () {
  var DEFAULT = { retries: 2, baseDelayMs: 400, maxDelayMs: 3000, timeoutMs: 12000, jitterMs: 250 };
  var MAX_RETRY_AFTER_MS = 8000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function netHint() {
    try {
      var c = (typeof navigator !== "undefined") && navigator.connection;
      if (!c) return { saveData: false, slow: false };
      return { saveData: !!c.saveData, slow: /^(slow-2g|2g)$/.test(String(c.effectiveType || "")) };
    } catch (e) { return { saveData: false, slow: false }; }
  }

  function methodOf(opts) { return String((opts && opts.method) || "GET").toUpperCase(); }

  /** 纪律1：POST 默认不重试 */
  function safeToRetry(opts) {
    var m = methodOf(opts);
    if (m === "GET" || m === "HEAD") return true;
    return !!(opts && opts.zpIdempotent === true);
  }

  /** 根据网络状况决定重试次数（纪律3） */
  function maxRetries(net, cfg) {
    if (net.saveData) return 0;
    if (net.slow) return 1;
    var n = cfg && typeof cfg.retries === "number" ? cfg.retries : DEFAULT.retries;
    return Math.max(0, Math.min(3, n));
  }

  /** 纪律2：只重试值得重试的失败 */
  function worthRetrying(res) {
    if (!res) return false;
    if (res.status === 429) return true;                 // 服务端限流：等一等就恢复
    return res.status >= 500 && res.status <= 599;       // 网关/后端抖动
  }

  function retryAfterMs(res) {
    try {
      var v = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      if (!v) return 0;
      var sec = Number(v);
      if (Number.isFinite(sec)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, sec * 1000));
      var at = Date.parse(v);
      if (Number.isFinite(at)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, at - Date.now()));
    } catch (e) {}
    return 0;
  }

  function delayFor(attempt, res) {
    var server = res ? retryAfterMs(res) : 0;
    if (server > 0) return server;
    var backoff = Math.min(DEFAULT.maxDelayMs, DEFAULT.baseDelayMs * Math.pow(2, attempt));
    return backoff + Math.random() * DEFAULT.jitterMs;
  }

  /**
   * 带重试的 fetch。用法与原生 fetch 一致，多一个 cfg：
   *   zpFetch(url, {credentials:"same-origin"}, {timeoutMs:12000, retries:2})
   * @returns {Promise<Response>} 重试耗尽后返回最后一次响应（含 5xx），由调用方按业务处理
   */
  async function zpFetch(url, opts, cfg) {
    opts = Object.assign({}, opts || {});
    cfg = cfg || {};
    var net = netHint();
    var retries = maxRetries(net, cfg);
    var timeoutMs = Number.isFinite(Number(cfg.timeoutMs)) ? Number(cfg.timeoutMs) : DEFAULT.timeoutMs;
    var callerSignal = opts.signal || null;
    var attempt = 0;

    for (;;) {
      var controller = new AbortController();
      var timer = null;
      var onAbort = null;
      if (callerSignal) {
        // 调用方自己取消了（比如页面跳转）→ 立刻中止，不做任何重试
        if (callerSignal.aborted) return Promise.reject(makeAbortError());
        onAbort = function () { controller.abort(); };
        callerSignal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs > 0) timer = setTimeout(function () { controller.abort(); }, timeoutMs);
      var res = null;
      try {
        res = await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
        if (!worthRetrying(res) || attempt >= retries || !safeToRetry(opts)) return res;
      } catch (e) {
        // 调用方主动取消：不重试，原样抛
        if (callerSignal && callerSignal.aborted) throw e;
        if (attempt >= retries || !safeToRetry(opts)) throw e;
        res = null;
      } finally {
        if (timer) clearTimeout(timer);
        if (callerSignal && onAbort) callerSignal.removeEventListener("abort", onAbort);
      }
      attempt++;
      await sleep(delayFor(attempt - 1, res));
    }
  }

  function makeAbortError() {
    var e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  }

  // 统一出口：把重试封装挂到 window.zpFetch（测试按字符串守卫此行）
  var api = zpFetch;
  window.zpFetch = api;
})();

;
/* 智配One · 离线重取/重写队列（P1-4：首个增量=GET 刷新；P1-4b=写操作登记）
 * ------------------------------------------------------------------
 * 场景：
 *   · 配送员弱网/无网打开历史页，GET 失败 → 登记「重连后自动重取」；
 *   · 无网时点删除 → 登记「重连后自动重放该删除」，不再只能失败弹窗。
 * 网络恢复（online 事件 / 回前台）时统一 flush：**先串行重放写操作，
 * 再重放读刷新**（业务数据落定后再刷新展示，避免闪旧数据）。
 *
 * 纪律（与 zpFetch「POST 默认不重试」一脉相承，但边界不同）：
 *   · zpFetch 的「不重试」防的是**同一次请求内的自动重发**（重复提交）；
 *     本队列是**用户无网时主动登记意图**，重连后由用户此前的确认动作驱动，
 *     且只接纳**幂等可重放**的操作——DELETE 按日期/月份是天然幂等的
 *     （服务端对已删除目标返回成功或 404，重放不产生二次业务）。
 *   · 写重放器 fn 约定返回值：true=已完成（出队）；false=暂时性失败
 *     （网络层 / 429 / 503，保留下次重连再试）；throw=业务性失败
 *     （如 403 无权限，重试无意义，出队并 console.warn 告知）。
 *   · 读刷新 fn 无返回值约定（原语义不变：执行一次即出队，单条失败不阻塞其余）。
 *   · 纯加法、零副作用依赖：未加载本脚本时，调用方用 `window.zpOfflineQueue?.`
 *     可选链调用，缺失即静默跳过，绝不因缺模块而报错。
 *
 * 暴露：window.zpOfflineQueue = { scheduleRefresh, scheduleWrite, flush,
 *                                isOffline, size, writeSize }
 */
(function () {
  var pending = new Map();   // key -> 读刷新 fn（同 key 覆盖，天然去重）
  var writes = new Map();    // key -> 写重放 fn（同 key 覆盖；串行重放）
  var flushing = false;

  function isOffline() {
    try { return navigator.onLine === false; } catch (e) { return false; }
  }

  function scheduleRefresh(key, fn) {
    if (typeof fn !== "function") return;
    pending.set(String(key), fn);
    // 登记时若已恢复在线，立即重放（覆盖「离线失败→网络恰好恢复」的竞态）
    if (!isOffline()) flush();
  }

  function scheduleWrite(key, fn) {
    if (typeof fn !== "function") return;
    writes.set(String(key), fn);
    if (!isOffline()) flush();
  }

  function flush() {
    if (flushing) return;
    if (isOffline() || (pending.size === 0 && writes.size === 0)) return;
    flushing = true;
    (async function () {
      // 先写后读：业务数据落定后再刷新展示
      var jobs = Array.from(writes.entries());
      writes.clear();
      for (var i = 0; i < jobs.length; i++) {
        var done = false;
        try { done = (await jobs[i][1]()) === true; }
        catch (e) {
          console.warn("[offline-queue] 写操作放弃重放:", jobs[i][0], e);
          done = true; // 业务性失败：出队（用户可手动重试）
        }
        if (!done) writes.set(jobs[i][0], jobs[i][1]); // 暂时性失败：保留待下次重连
      }
      var reads = Array.from(pending.entries());
      pending.clear();
      for (var j = 0; j < reads.length; j++) {
        try { await reads[j][1](); } catch (e) { /* 单条失败不阻塞其余重放 */ }
      }
      flushing = false;
    })();
  }

  // 网络恢复：重放全部登记项
  window.addEventListener("online", flush);
  // 回前台补一次：覆盖部分设备「重连事件未触发 / 休眠后 online 丢失」的边角
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") flush();
  });

  window.zpOfflineQueue = {
    scheduleRefresh: scheduleRefresh,
    scheduleWrite: scheduleWrite,
    flush: flush,
    isOffline: isOffline,
    size: function () { return pending.size; },
    writeSize: function () { return writes.size; },
  };
})();

;
/* home/core.js —— 共享 DOM 引用、线路状态与徽标渲染
   必须是 js/home/ 的第一个模块：后续模块直接复用这里的 $ / todayCount / dispatchRouteId…
   可见性依据：经典脚本顶层 const/let 落在共享的全局词法环境，后续脚本可直接引用。 */
const $=id=>document.getElementById(id);
const overlay=$("uploadArea"),cancel=$("sourceCancel");
const todayOrders=$("todayOrders"),todayCount=$("todayCount"),todayWeight=$("todayWeight"),todayStoreList=$("todayStoreList"),todayTabs=$("todayTabs"),todayMetrics=$("todayMetrics"),dot=$("statusDot");
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
/* 空态同时收起多单切换器与页高锁定：否则上一轮的 height 会把「暂无门店」压在空白里，
   tab 也会留在卡片上成为死按钮。 */
const setEmptyToday=()=>{if(todayOrders)todayOrders.textContent="";todayCount.textContent="暂无运单";todayWeight.textContent="";
  if(todayStoreList){todayStoreList.style.height="";todayStoreList.innerHTML='<div class="zp-empty zp-empty--tight">今日暂无配送门店</div>'}
  if(todayTabs){todayTabs.innerHTML="";todayTabs.hidden=true}
  if(todayMetrics)todayMetrics.innerHTML=""};
const setRouteBadge=(route)=>{if(!dot)return;const type=route?.type||"";const name=String(route?.name||"").trim();
  /* 全局标准：圆点内只显示线路数字（临时线路显示「临」），「X号线」全名用于文字位置 */
  const badge=(type==="temporary"||/临时/.test(name))?"临":(window.zpRouteShort?window.zpRouteShort(name):(name.match(/\d+/)?.[0]||name.replace(/\s+/g,"").slice(0,2)||"—"));
  dot.textContent=badge;dot.hidden=false};
;
/* home/fit.js —— 首页空态对齐 + 键盘回退
   ------------------------------------------------------------
   列表高度已完全由 CSS 内容驱动（css/home-dashboard.css）：门店几家就铺几家，
   超出一屏由整页滚动承接，既不封顶也不在窗内滚动。因此本文件不再测量高度，
   也不再切换 can-scroll / has-content / is-overflow 等布局类，只剩两件事：

   1) 空态对齐：列表里只剩唯一的 .zp-empty--tight 时挂 .is-empty，让提示文案
      贴顶居中。高度由该元素的 min-height 在纯 CSS 里定死，加不加类都不改变
      卡片高度（所以不会出现「先回缩、再展开」的抖动）；
   2) 键盘冻结：可视区骤降 160px+ 时挂 .is-keyboard，版面回退整页滚动，
      避免卡片被压成一条。

   为什么仍需 MutationObserver：today.js 用 innerHTML 整体替换列表，而
   ResizeObserver 观察的 .zp-scroll 尺寸不随列表内容变化，必须直接监听列表
   子节点变化，.is-empty 才能即时切换（否则要等 600ms 定时器）。 */
(function () {
  var root = document.querySelector("main.home-app");
  if (!root) return;
  var list = document.getElementById("todayStoreList");
  if (!list) return;

  var raf = 0;

  function syncEmpty() {
    var isEmpty = list.children.length === 1 && !!list.querySelector(".zp-empty--tight");
    list.classList.toggle("is-empty", isEmpty);
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; syncEmpty(); });
  }

  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(list, { childList: true });
  }

  /* 键盘：两种 WebView 行为都要覆盖 ——
     A. 键盘把 WebView 整体压矮（innerHeight 变小）；
     B. 只有 visualViewport 变小（innerHeight 不变）。
     地址栏伸缩通常 60–90px，键盘 250px+，用 160px 区分。 */
  var baseH = window.innerHeight;
  var vv = window.visualViewport;
  function syncKeyboard() {
    var byViewport = baseH - window.innerHeight > 160;
    var byVisual = !!vv && window.innerHeight - vv.height > 160;
    root.classList.toggle("is-keyboard", byViewport || byVisual);
  }
  if (vv) {
    vv.addEventListener("resize", syncKeyboard);
    vv.addEventListener("scroll", syncKeyboard);
  }
  window.addEventListener("orientationchange", function () { baseH = window.innerHeight; syncKeyboard(); });

  schedule();
  /* 数据到位后重放一次，覆盖慢网（列表被 innerHTML 替换的时机不固定） */
  setTimeout(schedule, 600);
  setTimeout(schedule, 2000);
})();

;
/* home/upload-progress.js —— 处理期等待体验：进度动画 / 已用时 / 停滞微光 / 阶段文案
   依赖 core 的 $；不伪造进度，百分比只来自后端真实 progress 事件。 */

const processingPanel=$("uploadProcessing"),processingError=$("uploadProcessingError"),processingErrorMessage=$("processingErrorMessage"),processingRetry=$("processingRetry"),sourceMenu=$("uploadSourceMenu"),processingPercent=$("processingPercent"),processingProgress=$("processingProgressDot");
const processingStageEl=$("processingStage"),processingElapsedEl=$("processingElapsed");
const uploadTextPanelEl=$("uploadTextPanel"),waybillTextInputEl=$("waybillTextInput");
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
     3) 处理中不提供任何退出方式（2026-10-30 起删除「取消处理」按钮）：
        处理一旦发出写请求就不可中断，取消只会留下「服务端已落库、用户以为放弃」的
        运单，与返回机制「保存中禁止返回」保持同一口径。 */
const STAGE_DEFAULT="正在准备…";
const STALL_THRESHOLD=1200;   // 超过此毫秒没有新进度即视为停滞
const ALIVE_THRESHOLD=3000;   // 心跳超过此毫秒未到即认为连接已断
let processingController=null;
let processingStartedAt=0;
let processingLastProgressAt=0;
let processingLastSignalAt=0;
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
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  if(!processingPanel||!sourceMenu)return;
  if(overlay)overlay.classList.remove("processing-error-state");
  if(processingError)processingError.hidden=true;
  // 隐藏的同时清空文案：仅 hidden 会把上一次失败的错误码/提示留在 DOM 里，
  // 读屏工具与 DOM 检索仍可读到（2026-10-24 线上核查发现）。
  if(processingErrorMessage)processingErrorMessage.textContent="";
  if(processingRetry)processingRetry.textContent="请重试";
  sourceMenu.hidden=false;
  if(uploadTextPanelEl)uploadTextPanelEl.hidden=true;   // 复位回来源菜单（文本重试回位由 retry 分支再切回文本面板）
  processingPanel.hidden=true;
  resetProcessingProgress();
}
;
/* home/upload-error.js —— 失败信封 → 重试动作映射，错误面板与处理面板切换
   依赖 core、upload-progress。
   注意：[RETRY-MAP-START]..[RETRY-MAP-END] 切片被 tests/unit-retry-action.test.mjs 直接读取，勿改锚点。 */
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
  if(processingErrorMessage)processingErrorMessage.textContent="";
  sourceMenu.hidden=true;
  if(uploadTextPanelEl)uploadTextPanelEl.hidden=true;   // 文本面板与来源菜单互斥，处理期一并隐藏
  processingPanel.hidden=false;
  setProcessingStage(STAGE_DEFAULT);
  if(processingElapsedEl)processingElapsedEl.textContent="已用时 0s";
  resetProcessingProgress();
  startProcessingClock();
  refreshProcessingClock();
}
;
/* home/upload-sheet.js —— 上传弹窗开合与交互绑定（首页按钮 toggle / 取消 / 重试 / 遮罩点击）
   依赖 core、upload-error、upload-process 的运行期状态（处理中保护）。 */
function closeUpload(){
  if(processingFile)return;
  if(overlay){overlay.hidden=true;overlay.setAttribute("aria-hidden","true");document.body.classList.remove("sheet-open");resetProcessingUI()}
  // 焦点归还触发按钮：弹层是 aria-modal，关闭后焦点必须回到原处，
  // 否则键盘用户会掉回文档开头（焦点陷阱只管层内，不管层外归还）。
  try{const trig=$("uploadAction");if(trig&&typeof trig.focus==="function")trig.focus()}catch(_){}
}
function openUpload(){
  if(overlay){resetProcessingUI();overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("sheet-open")}
  // 焦点入层：落在层内第一个可聚焦元素上（按钮而非输入框，不会误弹输入法）。
  try{
    const UI=window.__zpUi;
    const sheet=overlay&&overlay.querySelector(".upload-sheet");
    const list=UI&&UI.focusables?UI.focusables(sheet):[];
    if(list&&list.length)list[0].focus();
  }catch(_){}
}
/* ===== 粘贴文本录入（2026-10-26）：来源菜单第 4 项，切换文本面板 =====
   文本提交后走 processPastedText → 后端 rawText 直录管线（跳过 OCR）。
   失败可重试（RESUBMIT）时回到文本面板，已输入文字保留，改完直接重试。 */
const textPanel=$("uploadTextPanel"),waybillTextInput=$("waybillTextInput"),
      textCharCount=$("textCharCount"),pasteFromClipboardBtn=$("pasteFromClipboard"),
      clearTextBtn=$("clearWaybillText"),
      textPanelBackBtn=$("textPanelBack"),textPanelSubmitBtn=$("textPanelSubmit");
function showTextPanel(){
  if(!textPanel||!sourceMenu)return;
  sourceMenu.hidden=true;textPanel.hidden=false;
  // 打开面板不自动聚焦：本面板以「一键粘贴」为主操作，避免未点粘贴就先弹出输入法；
  // 需要手动输入时用户点一下文本框，键盘自然弹出。
}
function backToSourceMenu(){
  if(!textPanel||!sourceMenu)return;
  textPanel.hidden=true;sourceMenu.hidden=false;
}
if(waybillTextInput&&textCharCount){
  const refreshCount=()=>{
    const n=waybillTextInput.value.length;
    textCharCount.textContent=n+" 字";
    // 「清空」仅在有内容时出现：空面板不放无效按钮
    if(clearTextBtn)clearTextBtn.hidden=n===0;
  };
  waybillTextInput.addEventListener("input",refreshCount);refreshCount();
}
/* 清空已输入文字（误贴/贴错时用）：清空后聚焦输入框，方便重新粘贴 */
if(clearTextBtn&&waybillTextInput){
  clearTextBtn.addEventListener("click",()=>{
    if(!waybillTextInput.value)return;
    waybillTextInput.value="";
    waybillTextInput.dispatchEvent(new Event("input"));
    waybillTextInput.focus();
    if(window.zpToast)window.zpToast("已清空","success");
  });
}
/* 在光标处插入文本（保留选择区，等价于用户手动粘贴的落点） */
function insertWaybillText(text){
  const start=waybillTextInput.selectionStart??waybillTextInput.value.length,end=waybillTextInput.selectionEnd??start;
  waybillTextInput.setRangeText(text,start,end,"end");
  waybillTextInput.dispatchEvent(new Event("input"));
}
/* 降级路径：借原生粘贴，把剪贴板内容直接粘进真实输入框（等价于用户手动粘贴）。
   微信/安卓 WebView、Firefox 常可用此路，而 navigator.clipboard.readText 反而缺失；
   被浏览器策略拦截时返回 false（什么都不做），交由调用方提示长按手动粘贴。 */
function tryExecCommandPaste(){
  return new Promise((resolve)=>{
    const before=waybillTextInput.value;
    let pasted=false;
    const onPaste=()=>{pasted=true};
    waybillTextInput.addEventListener("paste",onPaste);
    waybillTextInput.focus();
    let ok=false;try{ok=document.execCommand("paste")}catch(e){}
    setTimeout(()=>{
      waybillTextInput.removeEventListener("paste",onPaste);
      resolve(!!(ok&&(pasted||waybillTextInput.value!==before)));
    },60);
  });
}
if(pasteFromClipboardBtn&&waybillTextInput){
  pasteFromClipboardBtn.addEventListener("click",async()=>{
    const original=pasteFromClipboardBtn.textContent;
    pasteFromClipboardBtn.disabled=true;pasteFromClipboardBtn.textContent="读取中…";
    try{
      // 0) 首选原生壳桥接（App 内）：壳直接读系统剪贴板，是国产 WebView /
      //    系统内置浏览器里唯一稳定的通道（navigator.clipboard 在那里常被拒）。
      //    三态约定（与壳 MainActivity.getClipboardText 对齐）：
      //      非空字符串 = 剪贴板文本 → 直接粘入；
      //      ""         = 剪贴板里没有文字（空剪贴板/复制的是图片等）→ 权威结论，不降级；
      //      null/无桥 = 读取失败或不在 App 内 → 继续走下面的 Web 链路。
      let nativeText=null,nativeChecked=false;
      try{
        const nat=window.ZhipeiNative;
        if(nat&&typeof nat.getClipboardText==="function"){
          nativeChecked=true;
          nativeText=nat.getClipboardText();
        }
      }catch(e){nativeText=null}
      if(nativeChecked&&typeof nativeText==="string"){
        if(nativeText){insertWaybillText(nativeText);return}
        try{window.zpToast?.("剪贴板里没有文字","info")}catch{}
        return;
      }
      // 1) 异步 Clipboard API（桌面 Chrome/Edge、已授权 WebView 可直接读到）
      if(navigator.clipboard&&navigator.clipboard.readText){
        try{
          const text=await navigator.clipboard.readText();
          if(!text){try{window.zpToast?.("剪贴板是空的","info")}catch{}return}
          insertWaybillText(text); // 成功即粘入，不再强制聚焦（避免无谓弹出输入法）
          return;
        }catch(e){/* 权限拒绝/页面未聚焦 → 继续降级 */}
      }
      // 2) 降级：execCommand 原生粘贴到真实输入框
      if(await tryExecCommandPaste()){waybillTextInput.dispatchEvent(new Event("input"));return}
      // 3) 环境无法程序化读取剪贴板：明确提示 + 聚焦，方便用户长按粘贴
      try{window.zpToast?.("未能读取剪贴板，请长按下方输入框粘贴","info")}catch{}
      waybillTextInput.focus();
    }catch{
      try{window.zpToast?.("粘贴失败，请长按下方输入框粘贴","info")}catch{}
      waybillTextInput.focus();
    }finally{
      pasteFromClipboardBtn.disabled=false;pasteFromClipboardBtn.textContent=original;
    }
  });
}
if(textPanelBackBtn)textPanelBackBtn.addEventListener("click",backToSourceMenu);
// 来源菜单第 4 项「粘贴文本」：upload-process.js 的 chooseFile 对 text 直接跳过（无文件控件），
// 面板切换在这里接管（upload-process.js 先于本文件绑定 click，text 来源在彼处为 no-op）
document.querySelectorAll('.source-option[data-source="text"]').forEach(btn=>btn.addEventListener("click",showTextPanel));
if(textPanelSubmitBtn&&waybillTextInput)textPanelSubmitBtn.addEventListener("click",()=>{
  if(processingFile)return;
  processPastedText(waybillTextInput.value);
});
// 首页上传按钮 toggle（以首页为标准点）：第一次点击打开上传弹窗，
// 弹窗已开时再点即关闭（回到首页标准态）。closeUpload 自带处理中保护。
$("uploadAction")?.addEventListener("click",()=>{if(overlay&&!overlay.hidden)closeUpload();else openUpload()});
if(new URLSearchParams(location.search).get("openUpload")==="1"){
  // 底栏「上传」是 <a href="/home?openUpload=1">，站内导航走 replace，于是首页会以
  // 带参数的地址重新加载一次。打开面板后立刻把参数抹掉（replaceState 不增删记录）：
  // 否则用户之后按返回又会落回带参数的地址、面板第二次弹出，看起来像「返回没生效」。
  try{const u=new URL(location.href);u.searchParams.delete("openUpload");history.replaceState(history.state,"",u.pathname+u.search)}catch{}
  setTimeout(openUpload,0);
}
cancel?.addEventListener("click",closeUpload);
// 处理中不再提供「取消处理」：处理一旦发出写请求就不可中断。
// 返回键同样被 js/ui/back.js 的忙碌守卫拦下并提示，处理结束前不关闭弹层。
processingRetry?.addEventListener("click",()=>{
  if(processingFile)return;   // 处理中禁止重复触发
  const info=retryActionInfo(lastFailureAction);
  if(lastFailureAction==="RETRY_SAVE"&&lastFailureRequestId){
    // 仅重保存：复用已构建的运单数据，不保留或重新上传原图。
    processSelectedFiles([], lastFailureRequestId);
  }else if(info&&info.autoRetry){
    // 重新识别必须重新选择图片；不在失败状态长期保留原图引用。
    openUpload();
  }else if(info&&lastFailureAction==="RESUBMIT"){
    // 需重新提供内容：文本失败回文本面板（已输入文字保留），文件失败回来源菜单重选
    openUpload();
    if(lastFailureSource==="text")setTimeout(showTextPanel,0);
  }else{
    // 不可重试（含非 recoverable）：按钮作关闭用
    closeUpload();
  }
});
overlay?.addEventListener("click",e=>{if(e.target===overlay)closeUpload()});
;
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
        "waybill-server-base-lookup":"baseLookupMs",
        "waybill-server-base-index":"baseIndexMs",
        "waybill-server-base-wait":"baseWaitMs",
        "waybill-server-base-overlap":"baseOverlapMs",
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
      const r2CleanupMs=serverTimingValue("waybill-temp-cleanup");
      const endToEndMs=serverTimingValue("waybill-server-end-to-end");
      if(r2CleanupMs!==null)phases["waybill-server-temp-cleanup"]=r2CleanupMs;
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
;
/* ui/mapnav.js —— 门店名 → 三家地图导航目标 + 点门店名弹选择菜单
   ------------------------------------------------------------
   门店数据里 name 必有，navigation（「导航地址」）与坐标（lat/lng，GCJ-02）可有可无。
   这里做两件事：
   1) 把一个门店对象解析成「三家各自的 URL」，交给渲染层拼 <a href> 与 data 载荷；
   2) 捕获门店名链接的点击，弹底部菜单让司机选高德 / 百度 / 腾讯，再跳对应软件。

   为什么是「每次点门店名弹菜单」而不是设置里选默认：
   浏览器无法枚举已安装的 App，也调不出「用哪个地图打开」的系统选择器。
   唯一可行的是让用户明确选一次；配送场景里每次选比进设置改默认更直观。

   为什么只送到「看位置」页、把是否用 App 留给司机自己点（成熟 H5 范式）：
   成熟 App 处理「点地址去导航」是「选择 → 打开 → 兜底」，下载永远是用户主动
   点击的动作，不是页面自动行为。我们是 H5，浏览器无法枚举已安装 App，因此
   把「是否用 App」也做成显式选择：只送到地图网页的「位置页」，页面里自带
   「打开高德APP」按钮，司机想用 App 导航就自己点，不想就只看位置。
   2026-11 真机回归（决定性差异是「落地页类型」，不是 callnative）：
     · uri.amap.com/navigation 驾车路线页一进去就要开始导航，未装 App 的手机
       会被高德整页引到 ap.amap.com / wap-org.amap.com 的「立即下载」；
     · callnative=1 由高德自动判定并拉起 App，同样把选择权从用户手里拿走；
     · 透传 surl.amap.com 短链会经 m.amap.com/callAPP 中转，未装 App 时
       超时兜底跳下载页，且落地页随出口漂移，不可依赖。
   所以高德有坐标时一律用 uri.amap.com/marker（位置标注页，落 m.amap.com/
   share/index）：零下载页特征、不带 callnative，这正是正式版 407（POI 详情 /
   搜索页）在真机上不跳下载页的原因。
   无坐标时（2026-11-06 起）不再退化成「按门店名搜索」——搜索页要用户自己从
   结果里挑门店，挑错就等于导到别家；改为不调用任何地图，只提示「暂无精确定位，
   请录入」。坐标在数据中心录入，一次录入全局可用。
   百度 / 腾讯同范式（2026-11 真机复核，三家必须一致）：
     · 百度 api.map.baidu.com/marker → 落 map.baidu.com/mobile/.../place/marker，
       自带门店名、地址、「导航 / 打车 / 到这去」；
       旧实现用 /direction 驾车路线页，移动端先落「路线搜索」（终点为空）再退回
       地图首页，等于没把位置带过去。
     · 腾讯 mapapi.qq.com/web/mapComponents/locationMarker → 轻量位置页，
       红色标记 + 门店名 + 逆地理地址 + 「去这里」；
       旧实现 map.qq.com/?what=…&center=… 在移动端被忽略，只给地图首页。
     两条都免开发者 key、都不自动拉起 App；自建 baidumap:// / qqmap:// 在 iOS
     未装会弹系统错误框、WebView 与微信普遍拦截，一律不做。起点不传：各家移动端
     默认用本机 GPS，比浏览器 geolocation 更准。

   坐标系：库里只存一组 GCJ-02（火星坐标）。高德 / 腾讯原生就是 GCJ-02；
   百度是 BD-09，但 URI 支持 coord_type=gcj02 让百度自己转，不存两套坐标。
   经纬度顺序三家不同（高德经度在前、百度纬度在前），各配单测锁死。

   为什么严格校验、且 new URL 不带 base：
   旧实现 new URL(v, location.origin) 会把 "A栋B1" 解析成站内路径并跳过去（404，
   且 back.js 的 replace 让返回键也救不回）。服务端对 navigation 无格式校验，
   历史数据里确实有这种纯文本。 */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.zpMapNav) return;

  var MAP_HOSTS = ["amap.com", "map.baidu.com", "map.qq.com", "ditu.qq.com"];
  var SRC = "zhipei";

  var PROVIDERS = [
    { id: "amap", label: "高德地图", note: "查看门店位置，是否用 App 导航由您选" },
    { id: "baidu", label: "百度地图", note: "查看门店位置，是否用 App 导航由您选" },
    { id: "qq", label: "腾讯地图", note: "查看门店位置，是否用 App 导航由您选" },
  ];

  function text(v) {
    return v == null ? "" : String(v).trim();
  }

  function isMapHost(host) {
    var h = text(host).toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (var i = 0; i < MAP_HOSTS.length; i++) {
      var d = MAP_HOSTS[i];
      /* 必须「等于」或「以 .d 结尾」：amap.com.evil.com 不算 amap.com 子域 */
      if (h === d || h.slice(-(d.length + 1)) === "." + d) return true;
    }
    return false;
  }

  function isMobile() {
    try {
      return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
    } catch (e) {
      return false;
    }
  }

  function standalone() {
    try {
      return (
        !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        window.navigator.standalone === true
      );
    } catch (e) {
      return false;
    }
  }

  function pickName(store) {
    return (
      text(store && store.name) || text(store && store.rawName) || text(store && store.originalName)
    );
  }

  /* 基准库里的坐标（GCJ-02）优先。范围外的值直接忽略，避免拼出 0,0。 */
  function geoOf(store) {
    var lat = Number(store && store.lat);
    var lng = Number(store && store.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < 18 || lat > 54 || lng < 73 || lng > 136) return null;
    return { lat: lat, lng: lng };
  }

  /* 只认白名单地图域名下的 http(s) 链接；纯文本/非地图 URL 一律当没有。 */
  function linkOf(store) {
    var raw = text(store && store.navigation) || text(store && store.nav);
    if (!raw) return "";
    try {
      var u = new URL(raw);
      if (!u.username && !u.password && /^https?:$/.test(u.protocol) && isMapHost(u.hostname)) {
        return u.href;
      }
    } catch (e) {}
    return "";
  }

  function enc(v) {
    return encodeURIComponent(v);
  }

  /* 全程不带 callnative：不主动拉起 App，也不显式置 0（正式版 407 的
     搜索入口带 callnative=1 却不跳下载页，说明决定因素是落地页类型，
     不是这个参数；多带一个参数只是多一个不确定变量）。
     「是否用 App」由落地页自带的「打开高德APP」按钮交给司机自己点。 */

  /* 位置标注页（302 落 m.amap.com/share/index）：position 是「经度,纬度」，
     纬度在前会导到几百公里外。用门店自己的坐标标一个点，页面里自带
     「打开高德APP」按钮 —— 想导航就自己点，我们绝不主动进入导航流程。 */
  function markerUrl(geo, name) {
    var url = "https://uri.amap.com/marker?position=" +
      geo.lng.toFixed(6) + "," + geo.lat.toFixed(6);
    if (name) url += "&name=" + enc(name);
    return url + "&src=" + SRC;
  }

  /* 百度的位置页（URI API marker）。落点是 map.baidu.com 的移动端 place/marker，
     页面自带门店名、地址与「导航 / 打车 / 到这去」，与高德位置页同范式。
     location 是「纬度,经度」—— 与高德相反；coord_type=gcj02 让百度自己转 BD-09。
     content 传一个空格：不传时百度会把字面的「内容」渲染成副标题占位。 */
  function baiduMarkerUrl(geo, name) {
    var url = "https://api.map.baidu.com/marker?location=" +
      geo.lat.toFixed(6) + "," + geo.lng.toFixed(6) +
      "&output=html&coord_type=gcj02&src=" + SRC;
    if (name) url += "&title=" + enc(name) + "&content=%20";
    return url;
  }

  /* 腾讯的位置页（mapComponents 的 locationMarker 组件）。落点是 mapapi.qq.com
     的轻量地图页：红色标记 + 门店名 + 逆地理地址 + 「去这里」，同样不拉起 App。
     marker 整串要整体编码 —— 内含 : , ; 三个分隔符，逐个拼编码会拼错。
     不用 apis.map.qq.com/uri/v1/marker 中转：那条会先尝试 qqmap:// 拉起 App。 */
  function qqMarkerUrl(geo, name) {
    var m = "coord:" + geo.lat.toFixed(6) + "," + geo.lng.toFixed(6);
    if (name) m += ";title:" + name;
    return "https://mapapi.qq.com/web/mapComponents/locationMarker/v/index.html?marker=" + enc(m);
  }

  /* ===== 三家适配器：一张表收口差异 =====
     只在有精确坐标时构造 URL；无坐标直接返回 {_geo:false}，三家一个地址都不给，
     调用方据此只提示「暂无精确定位，请录入」。

     三家都只送「看位置」页，绝不走驾车路线页 / 短链中转页：
       · 高德 uri.amap.com/marker（经度在前）
       · 百度 api.map.baidu.com/marker（纬度在前，coord_type=gcj02 交给百度转）
       · 腾讯 mapapi.qq.com/web/mapComponents/locationMarker
     页面里自带「打开高德APP」「去这里」等入口，是否用 App 由司机自己点。 */
  function providerUrls(store) {
    var geo = geoOf(store);
    if (!geo) return { _geo: false };
    var name = pickName(store);
    return {
      amap: markerUrl(geo, name),
      baidu: baiduMarkerUrl(geo, name),
      qq: qqMarkerUrl(geo, name),
      _geo: true,
    };
  }

  /* 载荷：渲染层塞进 data-zp-nav-payload，菜单点击时还原，
     避免把整个门店对象挂 DOM 上，也不依赖渲染层作用域。 */
  function navPayload(store) {
    var geo = geoOf(store);
    return JSON.stringify({
      name: pickName(store),
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lng : null,
      link: linkOf(store),
    });
  }

  /* 返回 {url, kind:"geo"|"missing"}；门店无名也无坐标时返回 null。
     有坐标 → 高德「看位置」链接（菜单脚本没加载时点门店名也能用，渐进增强）。
     无坐标 → href 用 # 占位：门店名仍可点（点了由菜单委托给出「请录入」提示），
     但绝不把司机带到按名称搜索的结果页 —— 搜索结果要人自己挑，挑错就导到别家。 */
  function resolve(store) {
    var geo = geoOf(store);
    var name = pickName(store);
    if (geo) return { url: markerUrl(geo, name), kind: "geo" };
    return name ? { url: "#", kind: "missing" } : null;
  }

  function linkAttrs(store) {
    var t = resolve(store);
    if (!t) return null;
    var blank = standalone();
    return {
      url: t.url,
      kind: t.kind,
      target: blank ? "_blank" : "_self",
      rel: blank ? "noopener" : "",
      payload: navPayload(store),
    };
  }

  /* ===== 底部选择菜单 ===== */
  var sheet = null;
  var lastAnchor = null;

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function closeMenu() {
    if (sheet) {
      var bg = sheet;
      sheet = null;
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      document.body.classList.remove("zp-mn-open");
    }
    if (lastAnchor && lastAnchor.focus) {
      try { lastAnchor.focus({ preventScroll: true }); } catch (e) {}
    }
    lastAnchor = null;
  }

  function go(url, blank) {
    if (!url) return;
    if (blank) {
      try { window.open(url, "_blank", "noopener"); } catch (e) { location.href = url; }
    } else {
      location.href = url;
    }
  }

  /* 无坐标提示：统一走全局 toast（首页 bundle、运单详情、今日配送、数据中心
     都加载了 feedback.js）。组件缺失时退回 alert —— 宁可粗糙也不静默，
     静默会让人以为是「点了没反应」。 */
  function notifyMissingGeo() {
    var msg = "暂无精确定位，请录入";
    try {
      if (typeof window.zpToast === "function") { window.zpToast(msg, "error"); return; }
    } catch (e) {}
    try { window.alert(msg); } catch (e) {}
  }

  function openMenu(anchor, payload) {
    closeMenu();
    var data;
    try { data = JSON.parse(payload); } catch (e) { return false; }
    if (!data || (!data.name && !data.lat)) return false;

    var urls = providerUrls({
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      navigation: data.link,
    });
    /* 无精确定位：不弹三家、不进任何地图页，只提示去数据中心录入。
       门店名仍是可点元素（模板里 href="#"），这里返回 true 表示「已处理」，
       委托层据此 preventDefault，避免 # 把页面滚回顶部。 */
    if (!urls._geo) {
      notifyMissingGeo();
      return true;
    }
    /* 数据中心等页面把门店名做成 target=_blank 的预览链接；继承它，
       避免管理员点一下就被 _self 带离维护页面。 */
    var blank = standalone() || anchor.getAttribute("target") === "_blank";
    lastAnchor = anchor;

    var bg = el("div", "zp-mn-bg");
    var box = el("div", "zp-mn-sheet");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "选择导航软件");

    var head = el("div", "zp-mn-head");
    head.appendChild(el("div", "zp-mn-title", "导航到 " + data.name));
    var x = el("button", "zp-mn-close", "✕");
    x.type = "button";
    x.setAttribute("aria-label", "关闭");
    x.addEventListener("click", closeMenu);
    head.appendChild(x);
    box.appendChild(head);

    var list = el("div", "zp-mn-list");
    PROVIDERS.forEach(function (p) {
      var row = el("button", "zp-mn-row");
      row.type = "button";
      row.setAttribute("data-provider", p.id);
      /* 只留名称、居中：说明文案对三家完全一样，重复三遍没有信息量；
         语义挪到 aria-label，读屏仍能听到「查看门店位置、是否用 App 由您选」。 */
      row.setAttribute("aria-label", p.label + "：" + p.note);
      row.appendChild(el("span", "zp-mn-row-label", p.label));
      row.addEventListener("click", function () {
        var u = urls[p.id];
        closeMenu();
        go(u, blank);
      });
      list.appendChild(row);
    });
    box.appendChild(list);
    bg.appendChild(box);
    bg.addEventListener("click", function (e) {
      if (e.target === bg) closeMenu();
    });

    document.body.appendChild(bg);
    document.body.classList.add("zp-mn-open");
    sheet = bg;
    /* 聚焦弹层本身，不聚焦第一个选项：脚本聚焦会让「高德地图」带上
       focus-visible 描边，看起来像默认选中了它，触摸场景是误导。
       聚焦 dialog 后读屏仍先读标题，键盘 Tab 依旧能进入选项。 */
    box.setAttribute("tabindex", "-1");
    try { box.focus({ preventScroll: true }); } catch (e) {}
    return true;
  }

  /* 冒泡阶段委托：手势 / 业务已 preventDefault 的点击不接管。
     数据中心左滑后浏览器补发的那次 click 会被 suppressNavUntil 吃掉，这里跳过；
     e2e 用例在捕获阶段 preventDefault 记录 href，也不会弹菜单。 */
  if (typeof document !== "undefined") {
    document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("[data-zp-nav-payload]") : null;
      if (!a) return;
      var payload = a.getAttribute("data-zp-nav-payload");
      if (!payload) return;
      if (!openMenu(a, payload)) return;
      e.preventDefault();
    }, false);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sheet && !e.defaultPrevented) {
        e.preventDefault();
        closeMenu();
      }
    });
  }

  /* 系统返回键先关菜单：沿用项目统一的返回层级钩子。
     back.js 可能晚于本文件加载，用自初始化 push 写法（与其约定一致）。
     rank 8 低于业务弹层（10+），保证菜单是最先响应返回的那一层。 */
  (window.zpBackHooks = window.zpBackHooks || []).push({
    rank: 8,
    probe: function () { return sheet; },
    close: function () { if (!sheet) return false; closeMenu(); return true; },
  });

  window.zpMapNav = {
    resolve: resolve,
    linkAttrs: linkAttrs,
    markerUrl: markerUrl,
    baiduMarkerUrl: baiduMarkerUrl,
    qqMarkerUrl: qqMarkerUrl,
    providerUrls: providerUrls,
    navPayload: navPayload,
    isMapHost: isMapHost,
    isMobile: isMobile,
    PROVIDERS: PROVIDERS,
  };
})();

;
/* home/today.js —— 今日配送三层数据源（latest → 当日历史 → 月度索引）与卡片渲染
   依赖前面全部模块；末尾 loadHome() 自启。
   window.zpHomeMonthlyDataPromise 由 js/home-monthly.js 提供（在 home/*.js 之后加载）。

   本地今日快照（2026-10-30 启动显示优化）：渲染成功后缓存
   {date,dayCount,orders} 到 localStorage；下次启动若快照仍是当天，
   先用快照立即渲染（等待趋近 0），随后正常三层数据源返回后覆盖渲染——
   数据有变则自然纠偏，当日无单/线路切换则走 setEmptyToday() 收敛为空态。
   日期不一致自动失效；退出登录时由 home-bundle-glue.frag 清除，防止换账号串数据。

   同日多单（2026-11-06）：一张卡内按单切页（点 tab / 左右滑动）。
   - 顺序按 uploadedAt 升序（早 → 晚）；tab 只显示「第X单」序号，不显示时间
     （2026-11-07 用户要求：去掉 tab 里的时间，浮层更简洁紧凑）；
   - 选中单记在 sessionStorage（按 id，不按序号），跨天自动失效；
   - 切换只换视图、不重新请求：orders 由 /api/waybills/latest 一次带回；
   - 门店名改为单行省略（简称让名字能一排放下），横向手势让给换单，
     「左滑看全名」只保留在运单详情 / 今日配送独立页（js/ui/store-name-scroll.js）。 */
const TODAY_SNAP_KEY="zp_home_today_v2";
const TODAY_SEL_KEY="zp_home_today_sel";

const zpEsc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const zpAttr=v=>zpEsc(v).replace(/'/g,"&#39;");

function zpTodayKey(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}
/* 2026-11-07：tab 不再显示上传时间，只保留「第X单」序号。
   排序仍按 uploadedAt（见下方当日历史降级路径），只是不再把时间渲染到 tab 上；
   原先专用于 tab 的「北京时间格式化函数」随之整体移除，不留无人调用的死代码。 */
function zpTodaySelId(){
  try{
    const s=JSON.parse(sessionStorage.getItem(TODAY_SEL_KEY)||"null");
    if(s&&s.date===zpTodayKey())return String(s.id||"");
  }catch{}
  return "";
}
function zpSetTodaySelId(id){
  try{sessionStorage.setItem(TODAY_SEL_KEY,JSON.stringify({date:zpTodayKey(),id:String(id||"")}))}catch{}
}
function zpReadTodaySnap(){
  try{
    const s=JSON.parse(localStorage.getItem(TODAY_SNAP_KEY)||"null");
    if(s&&s.date===zpTodayKey()&&Array.isArray(s.orders)&&s.orders.length)return s;
  }catch{}
  return null;
}

/* 卡片高度跟随「当前页」：多单行数不同，若不锁高，切换时下面的趋势卡会跟着跳。
   高度瞬时切换、不做动画——高度动画反而会让整页上下移动，观感更乱。 */
let zpTodayState={orders:[],idx:0,dayCount:0,go:null};
window.zpSyncTodayHeight=function(){
  if(!todayStoreList)return;
  if(todayStoreList.classList.contains("is-empty"))return;
  const page=todayStoreList.querySelector('.today-page[data-i="'+zpTodayState.idx+'"]');
  if(!page)return;
  todayStoreList.style.height=page.offsetHeight+"px";
};
window.addEventListener("resize",function(){try{window.zpSyncTodayHeight()}catch(e){}},{passive:true});

/* 今日卡渲染（tab + 单页列表 + 摘要 + 质量指标）。
   摘要与指标取「当前单」，单量取「全天」——每个数字都能对上，
   不再出现「2单」是全天、「6家」只来自最后一单的错位。 */
function zpRenderToday(orders,dayCount,fromCache){
  const list=(Array.isArray(orders)?orders:[]).filter(o=>o&&typeof o==="object");
  if(!list.length){setEmptyToday();return}
  const total=Number(dayCount)||list.length;
  zpTodayState={orders:list,idx:0,dayCount:total,go:null};

  const navTarget=x=>{try{return window.zpMapNav&&window.zpMapNav.linkAttrs?window.zpMapNav.linkAttrs(x):null}catch{return null}};
  const countOf=o=>{
    const stores=Array.isArray(o.stores)?o.stores:[];
    return Number(o.summary?.finalCount)||Number(o.summary?.total)||stores.length||0;
  };
  const applySummary=o=>{
    todayCount.textContent=countOf(o)+"家";
    // 重量统一 3 位小数（全局口径，见 AGENTS.md「统计口径」）
    todayWeight.textContent=(Math.round((Number(o.totalWeight)||0)*1000)/1000).toFixed(3)+"t";
  };
  const applyMetrics=o=>{
    if(!todayMetrics)return;
    const s=o.summary||{},stores=Array.isArray(o.stores)?o.stores:[],metrics=[];
    if(Number(s.recoveredCount)>0)metrics.push("恢复"+s.recoveredCount+"家");
    if(Number(s.correction)>0)metrics.push("更正"+s.correction+"家");
    if(Number(s.merged)>0)metrics.push("合并"+s.merged+"家");
    if(Number(s.newStores)>0)metrics.push("新增"+s.newStores+"家");
    if(stores.some(x=>x?.pending))metrics.push("待定"+stores.filter(x=>x?.pending).length+"家");
    if(o.quality?.level==="REVIEW")metrics.push("需复核");
    todayMetrics.innerHTML=metrics.map(x=>"<span>"+zpEsc(x)+"</span>").join("");
  };

  const pageHtml=(o,pi)=>{
    const stores=Array.isArray(o.stores)?o.stores:[];
    if(!stores.length)return '<div class="today-page" data-i="'+pi+'"><div class="zp-empty zp-empty--tight">本单暂无配送门店</div></div>';
    return '<div class="today-page" data-i="'+pi+'">'+stores.map((x,i)=>{
      /* 显示名优先取基准库投影的简称（displayName），没有简称时回退运单全名 */
      const rawName=String(x?.displayName||"").trim()||String(x?.name||"").trim()||String(x?.rawName||"").trim()||String(x?.originalName||"").trim()||"未识别门店";
      const t=navTarget(x);
      const body='<span class="today-store-index">'+(i+1)+'</span><span class="zp-store-name">'+zpEsc(rawName)+'</span>';
      if(!t)return '<div class="today-store-row" data-zp-store-row>'+body+'</div>';
      return '<a class="today-store-row" data-zp-store-row href="'+zpAttr(t.url)+'" target="'+t.target+'"'+(t.rel?' rel="'+zpAttr(t.rel)+'"':'')+
        ' data-zp-nav="'+zpAttr(t.kind)+'" data-zp-nav-name="'+zpAttr(rawName)+'"'+
        ' data-zp-nav-payload="'+zpAttr(t.payload||'')+'"'+
        ' aria-label="第'+(i+1)+'家，'+(t.kind==='missing'?'暂无精确定位，请录入':'导航到 '+zpAttr(rawName))+'">'+body+'</a>';
    }).join("")+"</div>";
  };

  todayOrders.textContent=(total>0?total:1)+"单";

  if(todayStoreList){
    try{
      todayStoreList.innerHTML='<div class="today-view"><div class="today-track">'+list.map(pageHtml).join("")+'</div></div>';
    }catch{
      todayStoreList.innerHTML='<div class="zp-empty zp-empty--tight">今日门店明细暂不可用</div>';
    }
  }

  if(todayTabs){
    /* tab 只显示「第X单」：不带上传时间，去掉时间后按钮更短、浮层更紧凑。
       顺序仍由 orders 的 uploadedAt 升序保证（左旧右新），与默认停在最新一单一致。 */
    todayTabs.innerHTML=list.length>1?list.map((_,i)=>
      '<button type="button" class="today-tab" role="tab" data-i="'+i+'" aria-selected="false">第'+(i+1)+'单</button>'
    ).join(""):"";
    todayTabs.hidden=list.length<2;
  }

  /* 默认单：记住本次会话的选择；没有记录（或那一单已不在列表）则回退到最新一单，
     与「刚上传的新单」这一现实一致——打开首页就能看到新单。 */
  const saved=zpTodaySelId();
  let idx=list.length-1;
  if(saved){
    const k=list.findIndex(o=>String(o.id)===saved);
    if(k>=0)idx=k;
  }

  function go(i,instant){
    i=Math.max(0,Math.min(list.length-1,i));
    zpTodayState.idx=i;
    const track=todayStoreList&&todayStoreList.querySelector(".today-track");
    if(track){
      track.style.transition=instant?"none":"transform 260ms cubic-bezier(.22,.61,.36,1)";
      track.style.transform="translate3d("+(-i*todayStoreList.clientWidth)+"px,0,0)";
    }
    if(todayTabs&&todayTabs.children.length){
      Array.prototype.forEach.call(todayTabs.children,function(b,k){
        const on=k===i;b.setAttribute("aria-selected",on?"true":"false");b.classList.toggle("is-active",on);
      });
      /* ≥4 单时 tab 条会横向溢出：把当前项滚进视野，避免「滑到第 4 单但 tab 停在前面」 */
      const act=todayTabs.children[i];
      if(act&&todayTabs.scrollWidth>todayTabs.clientWidth){
        const left=Math.max(0,act.offsetLeft-(todayTabs.clientWidth-act.offsetWidth)/2);
        try{todayTabs.scrollTo({left:left,behavior:"smooth"})}catch{todayTabs.scrollLeft=left}
      }
    }
    applySummary(list[i]);
    applyMetrics(list[i]);
    zpSetTodaySelId(list[i].id);
    window.zpSyncTodayHeight();
  }
  zpTodayState.go=go;
  go(idx,true);
  zpBindTodaySwipe();
  /* 中文字体晚于脚本到达时，行高会变、锁定高度就偏小（列表底部被裁）。
     字体就绪后补量一次；窗口尺寸变化由 zpSyncTodayHeight 的 resize 监听兜住。 */
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){try{window.zpSyncTodayHeight()}catch(e){}})}catch{}

  if(!fromCache){
    try{localStorage.setItem(TODAY_SNAP_KEY,JSON.stringify({date:zpTodayKey(),dayCount:total,orders:list}))}catch{}
  }
}

/* 左右滑动换单（2026-11-06）
   ------------------------------------------------------------------
   手势资源从「左滑看全名」移交给「换单」：简称让名称能一排放下，
   门店名改单行省略后，横向手势不再被占。
   判定：8px 死区 → |dx| > |dy|×1.2 才接管；一旦判为纵向，本次触点不再介入，
   避免「想滚列表却切了单」。屏幕左缘 24px 留给 iOS 返回手势。
   位移 > 18% 卡宽才切页，边界阻尼 0.35、不循环；滑动后吞掉一次 click，
   防止松手时误开导航（门店行是 <a>）。 */
function zpBindTodaySwipe(){
  const box=todayStoreList;
  if(!box||box.dataset.zpSwipe==="1")return;
  box.dataset.zpSwipe="1";
  /* is-swiping 挂在卡片上（摘要与列表是兄弟节点），用来在滑动时把摘要压淡 */
  const card=box.closest(".task-card")||box;
  let sx=0,sy=0,dx=0,lock=null,down=false;
  const trackOf=()=>box.querySelector(".today-track");
  box.addEventListener("pointerdown",function(e){
    if(!trackOf())return;
    if(e.pointerType==="mouse"&&e.button!==0)return;
    if(e.clientX<24)return;
    down=true;lock=null;dx=0;sx=e.clientX;sy=e.clientY;
    const t=trackOf();if(t)t.style.transition="none";
  },{passive:true});
  box.addEventListener("pointermove",function(e){
    if(!down)return;
    const ax=e.clientX-sx,ay=e.clientY-sy;
    if(!lock){
      if(Math.abs(ax)<8&&Math.abs(ay)<8)return;
      lock=Math.abs(ax)>Math.abs(ay)*1.2?"x":"y";
      if(lock==="x"&&zpTodayState.orders.length>1)card.classList.add("is-swiping");
    }
    if(lock!=="x")return;
    const t=trackOf();if(!t)return;
    dx=ax;
    /* 只有 1 单：不产生位移（否则卡片跟着手指滑动再弹回，像「加载失败」），
       但仍算作横向手势 —— 松手时要吞掉 click，不能因为滑了一下就跳地图。 */
    if(zpTodayState.orders.length<2)return;
    const w=box.clientWidth,n=zpTodayState.orders.length;
    let v=dx;
    if((zpTodayState.idx===0&&dx>0)||(zpTodayState.idx===n-1&&dx<0))v=dx*0.35;
    t.style.transform="translate3d("+(-zpTodayState.idx*w+v)+"px,0,0)";
    if(e.cancelable)e.preventDefault();
  },{passive:false});
  function settle(){
    if(!down)return;
    down=false;
    const t=trackOf();if(t)t.style.transition="";
    if(lock==="x"){
      card.classList.remove("is-swiping");
      const w=box.clientWidth,far=Math.abs(dx)>w*0.18,go=zpTodayState.go;
      if(go&&zpTodayState.orders.length>1)go(zpTodayState.idx+(far?(dx<0?1:-1):0));
      if(Math.abs(dx)>8)box.dataset.zpSwiped=String(Date.now());
    }
    lock=null;dx=0;
  }
  box.addEventListener("pointerup",settle);
  box.addEventListener("pointercancel",settle);
  /* 只吞一次：吞完立即清零，下一次正常点击照常生效 */
  window.addEventListener("click",function(e){
    const at=Number(box.dataset.zpSwiped||0);
    if(!at)return;
    if(Date.now()-at>600){box.dataset.zpSwiped="0";return}
    if(box.contains(e.target)){e.preventDefault();e.stopPropagation();box.dataset.zpSwiped="0"}
  },true);
  if(todayTabs){
    todayTabs.addEventListener("click",function(e){
      const b=e.target.closest&&e.target.closest(".today-tab");
      if(!b)return;
      const go=zpTodayState.go;if(go)go(Number(b.dataset.i)||0);
    });
  }
}

let zpHomeInitialLoadFailed=false;
let zpHomeRecoveryInFlight=false;

async function loadHome(){
  const perfReadyStartedAt=performance.now();
  // 快照先行：同日快照立即渲染（零网络等待），随后正常数据源返回后覆盖或纠偏
  try{
    const snap=zpReadTodaySnap();
    if(snap){
      zpRenderToday(snap.orders,Number(snap.dayCount)||0,true);
      try{window.zpPerfRecord?.("home-today-ready-cache",200,performance.now()-perfReadyStartedAt,null)}catch{}
    }
  }catch{}
  // 超时由 zpFetch 内部管理，避免把超时误判为调用方取消而跳过安全 GET 重试。
  const fetchJson=async(url,timeoutMs=8000)=>{
    const res=await zpFetch(url,{credentials:"same-origin",cache:"no-store"},{timeoutMs});
    const data=await res.json().catch(()=>({}));
    return {res,data};
  };
  try{
    // 首页依赖「有效线路」而非仅 dispatchRouteId：
    // 已绑定但未选调度线路的业务用户，/api/dispatch 返回 dispatchRoute:null
    // （临时线路仅在「既无 dispatchRouteId 也无 boundRouteId」时才会分配），
    // 此时必须以 boundRouteId 兜底，否则今日配送永远读不到数据。
    // 该问题在 8d4b9b6 重排 loadHome 后暴露：layer1 被 `if(dispatchRouteId)` 跳过，
    // layer2/3 又用 waybill.routeId==="" 过滤，永不命中 → 显示「暂无运单」。
    // 聚合接口：一次往返同时拿「调度线路 + 当前用户」（历史为 /api/dispatch 与
    // /api/me 两次并行请求，两次 currentUser 各 2 次 Redis 往返；合并后鉴权只做一次）
    // 并行发起：原实现是「bootstrap 回来 → 才知道 effectiveRouteId → 才敢发 latest」，
    // 但 latest 是服务端按会话自行解析线路的 GET，压根不需要前端先把 routeId 递过去——
    // routeId 只用于**结果校验**，而校验必然发生在两个响应都齐了之后。
    // 串行那段在中国大陆就直接换算成一次跨境往返（实测 bootstrap 单独就要 ~1.3s），
    // 白白加到首屏数据就绪的关键路径上。现在两者同时起飞。
    // 未 await 时不会静默抛错：末尾 .catch 把失败收敛成 null，layer1 自然降级到 layer2/3。
    const latestPromise=fetchJson("/api/waybills/latest",20000).catch(()=>null);
    const {res,data}=await fetchJson("/api/home-bootstrap");
    // 会话失效：头部守卫之外的兜底（如登录态残留但服务端会话已过期）。清标记并回登录页。
    if(res.status===401){zpHomeInitialLoadFailed=false;if(window.zpAuthFail)window.zpAuthFail("expired");return;}
    if(res.ok)try{sessionStorage.setItem("zpAuth","1")}catch(e){}
    if(!res.ok||!data.success)throw Error(data.error||"当前配送线路读取失败");
    dispatchRouteId=data.dispatchRoute?.id||"";
    boundRouteId=data.user&&data.user.boundRouteId?String(data.user.boundRouteId):(boundRouteId||"");
    renderSubstituteBadge();
    setRouteBadge(data.dispatchRoute||null);
    // 有效线路 = 显式调度线路（含临时线路）优先，其次管理员绑定线路
    const effectiveRouteId=dispatchRouteId||boundRouteId;

    const todayKey=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    let w=null;
    // 当天全部有效单（升序），用于单卡切换；w 仍保留「最后一单」语义，供线路校验兜底。
    let orders=[];
    // 当日该线路的运单数（"X单 X家 Xt" 里的 X）。一个运单覆盖一天一条线路，
    // 但当天可能上午/下午各上传一次，所以它不恒等于 1，必须按数据来。
    let dayOrders=0;
    // 比对键：默认用 effectiveRouteId，但一旦拿到服务端回显的 routeId 就以它为准。
    // 背景：data.dispatchRoute.id 来自 route:<id> 存储体内部的 id 字段，若与
    // Redis 键 id（即会话 dispatchRouteId、运单 routeId）发生数据漂移，前端用
    // dispatchRoute.id 过滤会全部落空（表现为徽标/月度正常、今日配送恒为空）。
    // /api/history 的响应体里回显了服务端实际使用的 routeId，用它比对可免疫漂移。
    let cmpRouteId=effectiveRouteId;

    // 首页“今日配送”以 latest 后端选择结果为唯一权威候选。
    // 历史接口负责列表/统计，不让首页在多张当日运单中自行重新选一张，
    // 避免同日多次上传时出现“刚上传A，首页却显示B”的数据分叉。
    if(effectiveRouteId){
      try{
        // 取的是上面已并发出去的那个请求（此刻通常早已在传输中或已完成）
        const latest=await latestPromise;
        if(latest){
          const {res:lr,data:ld}=latest;
          if(lr.ok&&ld.success){
            /* orders 是当天全部有效单（升序）；旧接口/旧缓存只有 waybill，退回单页模式。
               仍按 routeId + date 复校，避免接口版本漂移时把别的线路的单渲染进来。 */
            const all=Array.isArray(ld.orders)&&ld.orders.length?ld.orders:(ld.waybill?[ld.waybill]:[]);
            const mine=all.filter(x=>x&&x.routeId===cmpRouteId&&x.date===todayKey);
            if(mine.length){orders=mine;w=mine[mine.length-1];dayOrders=Number(ld.dayCount)||mine.length}
          }
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
          usable.sort((a,b)=>String(a.uploadedAt||a.createdAt||"").localeCompare(String(b.uploadedAt||b.createdAt||"")));
          orders=usable;
          w=usable[usable.length-1]||null;
          dayOrders=usable.length;
        }
      }catch{}
    }

    // 第三层复用月度统计已经成功读取的数据索引。若单日接口异常，
    // 只要月度历史能看到今天，就根据当天运单 ID 再取完整运单，避免出现“月度有数据、今日却为空”。
    if(!w&&effectiveRouteId){
      try{
        // 月度统计脚本通常已在首页并行读取 25 个月历史；优先复用同一响应，
        // 只有共享请求失败/超时才发起原有 13 个月兜底请求。
        let historyData=null;
        const sharedPromise=window.zpHomeMonthlyDataPromise;
        if(sharedPromise){
          let timer;
          try{
            historyData=await Promise.race([
              sharedPromise,
              new Promise(resolve=>{timer=setTimeout(()=>resolve(null),20000)})
            ]);
          }finally{clearTimeout(timer)}
        }
        if(!historyData?.success||!Array.isArray(historyData.history)){
          const {res,data}=await fetchJson("/api/history?months=13",20000);
          if(res.ok&&data.success!==false)historyData=data;
        }
        if(historyData?.success!==false&&Array.isArray(historyData?.history)){
          const serverRoute=String(historyData.routeId||"").trim();
          if(serverRoute)cmpRouteId=serverRoute;
          const todayEntry=historyData.history.find(x=>x?.date===todayKey&&Number(x?.count)>0);
          // 月度索引只给 ID：这里只能补到一张单，降级为单页模式（tab 自动收起）。
          dayOrders=Number(todayEntry?.count)||0;
          const id=Array.isArray(todayEntry?.waybillIds)?todayEntry.waybillIds[todayEntry.waybillIds.length-1]:"";
          if(id){
            const {res:detailRes,data:detail}=await fetchJson("/api/waybills/latest?id="+encodeURIComponent(id),20000);
            if(detailRes.ok&&detail.success&&detail.waybill&&detail.waybill.routeId===cmpRouteId&&detail.waybill.date===todayKey){
              w=detail.waybill;orders=[detail.waybill];
            }
          }
        }
      }catch{}
    }

    // 渲染统一走 zpRenderToday（快照/新数据同一渲染路径，杜绝两份实现漂移）
    if(orders.length){
      zpRenderToday(orders,dayOrders,false);
    }else{
      setEmptyToday();
    }
    zpHomeInitialLoadFailed=false;
    try{window.zpPerfRecord?.("home-today-ready-network",200,performance.now()-perfReadyStartedAt,null)}catch{}
  }catch(e){
    // 所有异常都必须结束 loading 状态，不能让首页永久停留在“加载中…”。
    zpHomeInitialLoadFailed=true;
    console.error("[loadHome] 异常:",e&&e.stack||e);
    setEmptyToday();
  }
}

// 仅在首页首轮数据加载失败后恢复联网时补拉；不整页刷新，也不打断用户操作。
function zpHomeCanAutoRecover(){
  if(!zpHomeInitialLoadFailed)return false;
  try{if(navigator.onLine===false||document.visibilityState==="hidden")return false}catch{}
  try{if(window.zpIsProcessing?.())return false}catch{}
  try{if(document.body?.classList.contains("sheet-open"))return false}catch{}
  const active=document.activeElement;
  if(active&&(/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)||active.isContentEditable))return false;
  const dialog=document.querySelector('[role="dialog"][aria-modal="true"]');
  if(dialog&&!dialog.closest("[hidden]"))return false;
  return true;
}
function zpRecoverHomeAfterNetwork(){
  if(zpHomeRecoveryInFlight||!zpHomeCanAutoRecover())return;
  zpHomeRecoveryInFlight=true;
  loadHome().finally(()=>{zpHomeRecoveryInFlight=false});
}
window.addEventListener("online",zpRecoverHomeAfterNetwork);
window.addEventListener("focus",zpRecoverHomeAfterNetwork);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")zpRecoverHomeAfterNetwork()});
loadHome();
;
/* home/back.js —— 本页返回层级注册：上传 Bottom Sheet → 下拉菜单
   中央返回控制器在 js/ui/back.js，读取 window.zpBackHooks。 */

// 首页的「两次返回才退出」与系统返回已统一到 ui-unified.js 中央控制器。
// 这里只注册本页返回层级：上传 Bottom Sheet → 下拉菜单。
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>$("uploadArea"),
   // 焦点陷阱容器：Tab/Shift+Tab 在弹层内循环（ESC/Tab 分发器按 rank 取最上层弹层）
   trap:()=>$("uploadArea")?.querySelector(".upload-sheet"),
   close:()=>{
     // 运单正在处理中：拒绝关闭，绝不穿透到「退出应用」
     if(typeof processingFile!=="undefined"&&processingFile){
       try{window.zpToast?window.zpToast("运单处理中，请稍候","error"):0}catch{}
       return false;
     }
     closeUpload();return true;
   }},
);
;
(()=>{"use strict";
  // 首页「配送趋势 · Smart Trend」模块（内部代号；用户界面仅显示「月度统计」「年度统计」等业务词，无英文技术词）。
  // 设计约束：工业物流终端科技感 —— 来自精细网格 + 数据节点 + 平滑曲线 + 动态切换 + 数字变化，
  // 严禁霓虹蓝/紫渐变、发光、3D、玻璃拟态等廉价科技风。任何异常均静默处理，不得影响 home.js 主流程。
  const $=id=>document.getElementById(id);
  const card=$("trendCard");
  if(!card)return;

  const titleEl=$("trendTitle"),yearBtn=$("trendYearBtn"),monthRow=$("trendMonthRow");
  const prev=$("trendPrev"),next=$("trendNext"),monthEl=$("trendMonth");
  const metricWrap=$("trendMetric"),metricWeightBtn=$("metricWeight"),metricCountBtn=$("metricCount");
  const waybillsEl=$("trendWaybills"),storesEl=$("trendStores"),weightEl=$("trendWeight");
  const wbDelta=$("trendWaybillsDelta"),wtDelta=$("trendWeightDelta");
  const wrap=$("trendChartWrap"),chart=$("trendChart");
  const grid=$("trendGrid"),area=$("trendArea"),line=$("trendLine"),points=$("trendPoints");
  const axis=$("trendAxis");

  const prefersReduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  let daily=[],byMonth=new Map(),currentMonth="";
  let metric="weight";            // 月度曲线指标：weight(按重量 t，默认) / count(按单量)
  let yearMode=false,year=0;
  let monthSeq=[],yearSeq=[],monthIdx=0,yearIdx=0;  // 可滑动序列（仅含「有数据」年/月 + 当前年/月终点）
  let animating=false,touchX=0,touchY=0;

  /* ---------- 基础工具 ---------- */
  const cnMonth=()=>{
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    return p.slice(0,7); // YYYY-MM
  };
  // 可滑动序列：仅「有数据」的年月 + 当前年/月(终点，不超今日)，升序去重。
  // 滑动即在序列上 ±1，无数据年/月天然不在序列 → 自动跳过，边界即序列首尾(越界 no-op)。
  function buildSeqs(){
    const today=cnMonth(),ty=Number(today.slice(0,4));
    const mSet=new Set(),ySet=new Set();
    for(const [k,v] of byMonth){
      if((Number(v.waybills)||0)>0||(Number(v.totalWeight)||0)>0){mSet.add(k);ySet.add(Number(k.slice(0,4)));}
    }
    mSet.add(today); ySet.add(ty);                 // 当前月/年强制为最新终点（即使无数据）
    monthSeq=[...mSet].sort();                     // "YYYY-MM" 字典序即时间序
    yearSeq=[...ySet].sort((a,b)=>a-b);
    monthIdx=Math.max(0,monthSeq.indexOf(today));
    yearIdx=Math.max(0,yearSeq.indexOf(ty));
    currentMonth=monthSeq[monthIdx]||today;
    year=yearSeq[yearIdx]||ty;
  }
  const daysInMonth=ym=>{const [y,m]=ym.split("-").map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate();};
  const label=ym=>{const [y,m]=ym.split("-").map(Number);return y+"年"+m+"月";};
  const esc=v=>String(v==null?"":v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const smoothPath=pts=>{
    if(!pts.length)return "";
    if(pts.length===1)return "M "+pts[0][0]+" "+pts[0][1];
    let d="M "+pts[0][0]+" "+pts[0][1];
    for(let i=1;i<pts.length;i++){
      const p0=pts[i-1],p1=pts[i],mx=(p0[0]+p1[0])/2;
      d+=" C "+mx+" "+p0[1]+", "+mx+" "+p1[1]+", "+p1[0]+" "+p1[1];
    }
    return d;
  };

  // 骨架期月份标签：HTML 静态文案（"2026年10月"）会随月份过期，
  // 模块初始化即写当前月；数据到达后 renderMonth() 会按序列再写一次。
  try{if(monthEl)monthEl.textContent=label(cnMonth())}catch{}

  /* ---------- 月度数据（补齐缺勤日 = 0） ---------- */
  function buildMonthData(ym){
    const days=daysInMonth(ym),byDate=new Map(daily.map(x=>[x.date,x])),out=[];
    for(let d=1;d<=days;d++){
      const date=ym+"-"+String(d).padStart(2,"0"),item=byDate.get(date);
      out.push({date,day:d,count:Number(item?.count)||0,stores:Number(item?.storeCount)||0,weight:Number(item?.totalWeight)||0});
    }
    return out;
  }

  function animateNumber(el,to,fmt){
    if(!el)return;                 // HTML 与 JS 版本错位（旧页面 + 新脚本）时不让整卡挂掉
    const from=Number(el.dataset.v||0);
    el.dataset.v=String(to);
    if(prefersReduced){el.textContent=fmt(to);return;}
    const t0=performance.now(),dur=320;
    (function step(t){
      const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);
      el.textContent=fmt(from+(to-from)*e);
      if(k<1)requestAnimationFrame(step);
    })(t0);
  }

  function setDelta(el,cur,prev,unit){
    if(prev==null||prev<=0){el.textContent="";el.className="trend-delta";el.title="";return;}
    const pct=(cur-prev)/prev*100;
    if(!isFinite(pct)){el.textContent="";el.className="trend-delta";el.title="";return;}
    const up=pct>=0;
    el.textContent=(up?"↑ ":"↓ ")+Math.abs(pct).toFixed(1)+"%";
    el.className="trend-delta "+(up?"is-up":"is-down");
    el.title="同比（对比去年同月）";
  }

  /* ---------- 月度视图渲染 ---------- */
  function renderMonth(){
    const data=buildMonthData(currentMonth);
    const total=data.reduce((s,x)=>s+x.count,0);
    const stores=data.reduce((s,x)=>s+x.stores,0);
    const weight=data.reduce((s,x)=>s+x.weight,0);
    const valOf=x=>metric==="weight"?x.weight:x.count;
    const safeMax=metric==="weight"?0.01:1;            // 重量为 0 时兜底，避免除零、保证基线可见
    const max=Math.max(safeMax,...data.map(valOf));
    const w=360,h=120,left=10,right=10,top=12,bottom=16;
    const cw=w-left-right,ch=h-top-bottom;
    const pts=data.map((x,i)=>{
      const px=left+(data.length===1?cw/2:i*cw/(data.length-1));
      const py=top+(1-valOf(x)/max)*ch;
      return [px,py];
    });
    const path=smoothPath(pts);
    const areaPath=path?path+" L "+pts[pts.length-1][0]+" "+(h-bottom)+" L "+pts[0][0]+" "+(h-bottom)+" Z":"";
    const gridPath=[0,.5,1].map(r=>{const y=top+r*ch;return "M "+left+" "+y+" H "+(w-right);}).join(" ");
    grid.setAttribute("d",gridPath);
    line.setAttribute("d",path);
    area.setAttribute("d",areaPath);
    points.innerHTML="";
    const peakIdx=data.reduce((b,x,i)=>valOf(x)>valOf(data[b])?i:b,0);
    data.forEach((x,i)=>{
      if(!valOf(x))return;
      const p=pts[i],c=document.createElementNS("http://www.w3.org/2000/svg","circle");
      const isPeak=i===peakIdx&&total>0;
      c.setAttribute("cx",p[0]);c.setAttribute("cy",p[1]);
      c.setAttribute("r",isPeak?4.5:2.6);
      c.setAttribute("class","trend-point"+(isPeak?" is-peak":""));
      c.setAttribute("tabindex","0");
      c.setAttribute("aria-label",x.date+" "+x.count+"单 · "+x.weight.toFixed(3)+"t");
      points.appendChild(c);
    });
    // 轴：首日 / 月中 / 末日（只保留一排趋势线，无下方节奏条）
    axis.innerHTML="";
    const last=daysInMonth(currentMonth);
    [1,Math.round(last/2),last].forEach(d=>{
      const s=document.createElement("span");s.textContent=String(d).padStart(2,"0")+"日";axis.appendChild(s);
    });
    // 汇总 + 同比（对比去年同月，比环比更能剥离季节性、看出真实增减）
    animateNumber(waybillsEl,total,v=>String(Math.round(v)));
    animateNumber(storesEl,stores,v=>String(Math.round(v)));
    animateNumber(weightEl,weight,v=>v.toFixed(3));
    const lyKey=sameMonthLastYearKey(currentMonth);
    const ly=lyKey?byMonth.get(lyKey):null;
    setDelta(wbDelta,total,ly?Number(ly.waybills)||0:null);
    setDelta(wtDelta,weight,ly?Number(ly.totalWeight)||0:null);
    // 抬头（两画面统一：月度/年度）
    titleEl.textContent="月度统计";
    monthEl.textContent=label(currentMonth);
    metricWrap.hidden=false;
    prev.disabled=monthIdx<=0;                        // 已是最旧有数据月
    next.disabled=monthIdx>=monthSeq.length-1;        // 已是当前月（未来禁止）
  }

  // 去年同月（同比基准）：2026-10 → 2025-10
  function sameMonthLastYearKey(ym){
    const [y,m]=ym.split("-").map(Number);
    return (y-1)+"-"+String(m).padStart(2,"0");
  }

  /* ---------- 年度视图渲染 ---------- */
  function renderYear(){
    const yk=String(year);
    const months=[];
    for(let m=1;m<=12;m++)months.push(yk+"-"+String(m).padStart(2,"0"));
    // 与月度视图共用同一指标（重量 t / 单量），两画面统一
    const isW=metric==="weight";
    const vals=months.map(mk=>{const x=byMonth.get(mk);if(!x)return 0;return isW?(Number(x.totalWeight)||0):(Number(x.waybills)||0);});
    const total=months.reduce((s,mk)=>{const x=byMonth.get(mk);return s+(x?Number(x.waybills)||0:0);},0);
    const weight=months.reduce((s,mk)=>{const x=byMonth.get(mk);return s+(x?Number(x.totalWeight)||0:0);},0);
    const stores=months.reduce((s,mk)=>{const x=byMonth.get(mk);return s+(x?Number(x.totalStores)||0:0);},0);
    const safeMax=isW?0.01:1;
    const max=Math.max(safeMax,...vals);
    // 12 月活动柱（工业风：细柱 + 峰值略亮）
    const w=360,h=120,left=10,right=10,top=14,bottom=14;
    const cw=w-left-right,slot=cw/12,barW=Math.min(18,slot*0.46);
    let d="",bars="";
    vals.forEach((v,i)=>{
      const x=left+slot*i+slot/2,hh=(v<=0?0.04:v/max)*(h-top-bottom),yy=h-bottom-hh;
      const isPeak=v===max&&v>0;
      const fmtV=v=>isW?v.toFixed(3)+"t":v+"单";
      bars+='<rect x="'+(x-barW/2).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+barW.toFixed(1)+'" height="'+hh.toFixed(1)
        +'" rx="1.5" class="trend-year-bar'+(isPeak?" is-peak":"")+'"><title>'+label(months[i])+" · "+fmtV(v)+"</title></rect>";
    });
    // 基线 + 柱（用 line 通道绘制基线，area 留空）
    grid.setAttribute("d","M "+left+" "+(h-bottom)+" H "+(w-right));
    line.setAttribute("d","");area.setAttribute("d","");
    points.innerHTML=bars;
    // 轴：1 / 4 / 7 / 10 / 12 月
    axis.innerHTML="";
    [1,4,7,10,12].forEach(m=>{const s=document.createElement("span");s.textContent=m+"月";axis.appendChild(s);});
    // 汇总（无环比）
    animateNumber(waybillsEl,total,v=>String(Math.round(v)));
    animateNumber(storesEl,stores,v=>String(Math.round(v)));
    animateNumber(weightEl,weight,v=>v.toFixed(3));
    wbDelta.textContent="";wtDelta.textContent="";
    titleEl.textContent="年度统计";
    monthEl.textContent=year+" 年度";
    metricWrap.hidden=false;   // 与月度画面统一：同样提供 重量/单量 切换
    prev.disabled=yearIdx<=0;                         // 已是最旧有数据年
    next.disabled=yearIdx>=yearSeq.length-1;         // 已是当前年（未来禁止）
  }

  /* ---------- 切换动画（曲线滑出 / 新曲线滑入 + 数字计数） ---------- */
  function animateSwap(dir,renderFn){
    if(animating){return;}
    if(prefersReduced){renderFn();return;}
    animating=true;
    const exitX=dir<0?-40:40;     // dir=-1 前往更新月份：旧内容向左滑出
    const enterX=dir<0?40:-40;
    wrap.style.transition="transform .14s ease, opacity .14s ease";
    wrap.style.transform="translateX("+exitX+"px)";wrap.style.opacity=".12";
    monthEl.style.transition="transform .14s ease";monthEl.style.transform="translateX("+(exitX*0.4)+"px)";
    setTimeout(()=>{
      renderFn();
      wrap.style.transition="none";wrap.style.transform="translateX("+enterX+"px)";wrap.style.opacity="0";
      monthEl.style.transition="none";monthEl.style.transform="translateX("+(enterX*0.4)+"px)";
      void wrap.offsetWidth;
      requestAnimationFrame(()=>{
        wrap.style.transition="transform .26s cubic-bezier(.22,.61,.36,1), opacity .26s ease";
        wrap.style.transform="translateX(0)";wrap.style.opacity="1";
        monthEl.style.transition="transform .26s cubic-bezier(.22,.61,.36,1)";monthEl.style.transform="translateX(0)";
      });
      setTimeout(()=>{animating=false;},280);
    },150);
  }

  /* ---------- 导航 ---------- */
  // 在序列上 ±1：delta=+1 向「当前」(更新，到年/月边界止)；delta=-1 向「更旧」(跳过无数据)。
  // 序列本身只含「有数据」年/月 + 当前年/月，故边界即序列首尾，越界 no-op。
  function stepMonth(delta){
    const ni=monthIdx+delta;
    if(ni<0||ni>=monthSeq.length)return;
    monthIdx=ni;currentMonth=monthSeq[ni];
    animateSwap(delta>0?-1:1,renderMonth);   // 更新方向内容左移、旧方向内容右移
  }
  function stepYear(delta){
    const ni=yearIdx+delta;
    if(ni<0||ni>=yearSeq.length)return;
    yearIdx=ni;year=yearSeq[ni];
    animateSwap(delta>0?-1:1,renderYear);
  }
  // 年份按钮文案随视图状态同步
  function syncYearBtn(){
    // 右上角统一命名：当前在年度视图→按钮显示「月度」(点回月度)；在月度视图→显示「年度」
    if(yearMode){yearBtn.textContent="月度";yearBtn.classList.add("is-active");}
    else{yearBtn.textContent="年度";yearBtn.classList.remove("is-active");}
  }
  function enterYear(){
    if(yearMode)return;
    yearMode=true; yearIdx=yearSeq.length-1; year=yearSeq[yearIdx]; syncYearBtn(); renderYear(); // 进入年度默认定位今年
  }
  function exitYear(){
    if(!yearMode)return;
    yearMode=false; monthIdx=monthSeq.length-1; currentMonth=monthSeq[monthIdx]; syncYearBtn(); renderMonth(); // 退出年度默认定位当月
  }
  function toggleYear(){ if(yearMode)exitYear();else enterYear(); }
  // 左右滑动意图（与按钮、动画解耦，保证手势始终可识别）
  function onSwipeLeft(){  if(yearMode)stepYear(1); else stepMonth(1); }   // 左滑：向当前(更新)，到年/月边界止
  function onSwipeRight(){ if(yearMode)stepYear(-1);else stepMonth(-1); }  // 右滑：向更旧(跳过无数据年/月)
  function setMetric(m){
    if(m!=="weight"&&m!=="count")return;
    metric=m;
    metricWeightBtn.classList.toggle("is-active",m==="weight");
    metricCountBtn.classList.toggle("is-active",m==="count");
    metricWeightBtn.setAttribute("aria-pressed",String(m==="weight"));
    metricCountBtn.setAttribute("aria-pressed",String(m==="count"));
    if(yearMode)renderYear();else renderMonth();   // 两画面共用同一指标，切换即重绘当前视图
  }

  /* ---------- 事件 ---------- */
  prev?.addEventListener("click",()=> yearMode?stepYear(-1):stepMonth(-1));  // ‹ 更旧年/月
  next?.addEventListener("click",()=> yearMode?stepYear(1):stepMonth(1));    // › 更新(到当前年/月止)
  metricWeightBtn?.addEventListener("click",()=>setMetric("weight"));
  metricCountBtn?.addEventListener("click",()=>setMetric("count"));
  yearBtn?.addEventListener("click",toggleYear);
  // 左右滑动：月度 左滑=向当前月(到当月止)、右滑=更旧月；年度 左滑=向今年(到今年止)、右滑=更旧年（均跳过无数据）。
  // 安卓 Chrome 在可纵向滚动页面里：用方向锁定（先到 6px 即判定 X/Y），横向意图时 touchmove
  // preventDefault 吃下手势、阻止浏览器纵向滚动接管并发 touchcancel 误杀手势。
  (function bindSwipe(){
    if(!card)return;
    let sx=0,sy=0,active=false,locked=null;
    const MIN=44;
    const down=e=>{const t=e.touches?.[0]||e;if(!t)return;sx=t.clientX;sy=t.clientY;active=true;locked=null;};
    const move=e=>{
      if(!active)return;
      const t=e.touches?.[0]||e;if(!t)return;
      const dx=t.clientX-sx,dy=t.clientY-sy;
      if(locked===null&&(Math.abs(dx)>6||Math.abs(dy)>6))locked=Math.abs(dx)>Math.abs(dy)?"x":"y";
      if(locked==="x"&&e.cancelable)e.preventDefault(); // 横向意图：阻止页面滚动抢走手势
    };
    const up=e=>{
      if(!active)return;active=false;
      if(locked!=="x")return;             // 纵向手势不触发切换
      const t=e.changedTouches?.[0]||e;if(!t)return;
      const dx=t.clientX-sx,dy=t.clientY-sy;
      if(Math.abs(dx)<MIN||Math.abs(dx)<Math.abs(dy))return;
      if(dx<0)onSwipeLeft();else onSwipeRight();
    };
    card.addEventListener("touchstart",down,{passive:true});
    card.addEventListener("touchmove",move,{passive:false});
    card.addEventListener("touchend",up,{passive:true});
    card.addEventListener("touchcancel",up,{passive:true});
  })();

  /* ---------- 数据加载 ---------- */
  /* 本地历史快照（2026-10-30 启动显示优化）：加载成功后整份缓存
     /api/history?months=13 响应；下次启动先 hydrate 快照立即出图（SWR），
     再请求新数据覆盖渲染。今日卡兜底（js/home/today.js 第三层）同样复用。 */
  const HIST_CACHE_KEY="zp_home_hist_v1";
  let hydrated=false;
  function hydrate(d){
    daily=d.history.filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x?.date||"")));
    byMonth=new Map((Array.isArray(d.months)?d.months:[]).map(x=>[String(x.month),x]));
    buildSeqs();   // 构建可滑动序列（有数据年/月 + 当前年/月）并定位到当前
    card.hidden=false;
    card.classList.remove("is-skel");   // 骨架态 → 数据态（解除整卡禁交互）
    card.classList.add("is-in");
    renderMonth();
    syncYearBtn();
    hydrated=true;
  }
  function readHistCache(){
    try{
      const c=JSON.parse(localStorage.getItem(HIST_CACHE_KEY)||"null");
      if(c&&c.d&&c.d.success&&Array.isArray(c.d.history))return c.d;
    }catch{}
    return null;
  }
  async function load(){
    const perfReadyStartedAt=performance.now();
    const cached=readHistCache();
    if(cached){try{hydrate(cached);window.zpPerfRecord?.("home-history-ready-cache",200,performance.now()-perfReadyStartedAt,null)}catch{}}
    try{
      // 后端把 months 钳制在 13（history.js:Math.min(13,…)），请求 25 实际仍只返回 13 个月窗口；
      // 13 个月最早仅到 11 个月前，不含去年同月，同比恒为空。故按 13 如实请求（返回数据与原来一致）。
      const r=await zpFetch("/api/history?months=13",{credentials:"same-origin",cache:"no-store"});
      if(!r.ok){if(!hydrated)card.hidden=true;return hydrated?cached:null;}   // 非 ok 同样回退，骨架不得停留
      const d=await r.json().catch(()=>null);
      if(!d?.success||!Array.isArray(d.history)){if(!hydrated)card.hidden=true;return hydrated?cached:null;}
      hydrate(d);
      try{window.zpPerfRecord?.("home-history-ready-network",200,performance.now()-perfReadyStartedAt,null)}catch{}
      try{localStorage.setItem(HIST_CACHE_KEY,JSON.stringify({t:Date.now(),d}))}catch{}
      return d;
    }catch{
      // 无快照且请求失败：回退旧行为（整卡隐藏），绝不让骨架卡永久停留
      if(!hydrated)card.hidden=true;
      return hydrated?cached:null;
    }
  }
  // 首页今日配送的最后一级兜底可复用这次历史响应，避免再请求一遍历史窗口。
  window.zpHomeMonthlyDataPromise=load();
})();

;

(()=>{const d=document.getElementById("todayDate");if(d){const f=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"});d.textContent=f.format(new Date()).replaceAll("/","-")}})();
document.getElementById("logout")?.addEventListener("click",async()=>{const ok=window.zpConfirm?await window.zpConfirm("退出登录","确定要退出当前账号吗？","退出"):true;if(!ok)return;try{await fetch("/api/logout",{method:"POST",credentials:"same-origin",cache:"no-store"})}finally{try{localStorage.removeItem("zpLastAuth");localStorage.removeItem("zpLastRole");localStorage.removeItem("zp_home_today_v1");localStorage.removeItem("zp_home_today_v2");localStorage.removeItem("zp_home_hist_v1");try{sessionStorage.removeItem("zp_home_today_sel")}catch(e){}}catch(e){}location.replace("/")}})

;
/* 智配One · UI 内核（原 js/ui-unified.js 拆分 · 1/6）
 * ----------------------------------------------------------------------------
 * 只包含「被多个 UI 模块共用」的三件东西：路径规整、工作区判定、共享状态。
 * 不含任何副作用（不注册监听、不改 DOM）——所以它可以在测试里被单独求值。
 *
 * ⚠ 必须第一个加载：nav.js（底部常驻导航）与 back.js（返回控制器）都依赖这里。
 */
(function(){
  if(window.__zpUi)return;
  const UI={};

  /* 跨模块共享状态。feedback.js 的确认框把「关闭器」写进来，
     back.js 的返回 ladder 读它——两者不能互相依赖加载顺序，故由内核托管。 */
  UI.state={confirmDismisser:null};

  /* 路径规整。
     ⚠ Cloudflare Pages 会把 /admin 308 重定向到 /admin（pretty URL），
     因此线上 location.pathname 是「无扩展名」形态。所有判定必须先做规整化，
     否则管理员页会被误判为业务页：第一次左滑直接 location.replace("/home")
     穿越到司机首页（2026-10-05 生产事故根因）。 */
  UI.normPath=function(p){
    let s=String(p||"").split("?")[0];
    s=s.replace(/\.html$/,"");
    if(s.length>1&&s.endsWith("/"))s=s.slice(0,-1);
    return s||"/";
  };

  /* 工作区识别：业务端根 /home，管理员端根 /admin（独立工作区，互不串线）。 */
  UI.detectZone=function(){
    const p=UI.normPath(location.pathname);
    const od=(document.body&&document.body.dataset&&document.body.dataset.zpZone)||"";
    if(od==="none")return null;
    if(od)return od;
    if(p==="/admin")return "admin";
    if(p==="/"||p==="/index"||p==="/register"||p==="/setup"||p==="/offline"||p==="/admin-bootstrap")return null; // 登录/引导页不装守卫
    return "business";
  };

  /* 来源归一化：兜底历史链接 / 旧缓存页里形如 from=pages%2Fdispatch 的「路径碎片」写法，
     剥成模块名后再查表，避免这类链接一律掉回首页。 */
  UI.normFrom=function(v){
    if(!v)return "";
    let s=String(v).replace(/^\/+/,"").replace(/\.html$/,"");
    if(s.startsWith("pages/"))s=s.slice(6);
    return s;
  };

  /* ===== 模态焦点管理（P3 对话框焦点陷阱）=====
     对话框（aria-modal）打开后，Tab/Shift+Tab 应在层内循环，键盘焦点不逃出遮罩。
     决策拆成纯函数（便于单测），DOM 装配留给调用方（back.js 的 ESC/Tab 分发器）。

     收集容器内可聚焦元素：跳过 disabled、tabindex="-1"、隐藏祖先、aria-hidden 与不可见项。 */
  UI.focusables=function(root){
    if(!root||typeof root.querySelectorAll!=="function")return [];
    const sel='a[href],button,input,select,textarea,[tabindex]';
    const out=[];
    Array.prototype.forEach.call(root.querySelectorAll(sel),el=>{
      if(!el||el.disabled)return;
      if(el.getAttribute&&el.getAttribute("tabindex")==="-1")return;
      if(el.closest&&el.closest("[hidden]"))return;
      if(el.getAttribute&&el.getAttribute("aria-hidden")==="true")return;
      // offsetParent 对 position:fixed 元素恒为 null，故同时看 getClientRects
      const visible=(el.offsetParent!=null)||(typeof el.getClientRects==="function"&&el.getClientRects().length>0);
      if(!visible)return;
      out.push(el);
    });
    return out;
  };

  /* 焦点陷阱的纯决策：给定可聚焦元素列表、当前焦点元素与 Shift 状态，
     返回应获得焦点的元素；返回 null 表示本次不干预（焦点在层内中间，照常移动）。 */
  UI.trapFocusTarget=function(list,active,shiftKey){
    if(!list||!list.length)return null;
    const first=list[0],last=list[list.length-1];
    if(shiftKey)return active===first?last:null;
    return active===last?first:null;
  };

  /* 把焦点锁在容器内：Tab/Shift+Tab 在首尾循环。返回是否发生了焦点搬运。
     焦点已逸出容器（如切到隐藏面板后浏览器把焦点落在 body）时，Tab 把它拉回层内首/尾，
     否则焦点会从文档开头继续走，直接跳出弹层。 */
  UI.trapTab=function(root,e){
    if(!root||!e)return false;
    const list=UI.focusables(root);
    if(!list.length)return false;
    const active=(typeof document!=="undefined")?document.activeElement:null;
    const inside=!!(active&&root.contains&&root.contains(active));
    let target=null;
    if(!inside)target=e.shiftKey?list[list.length-1]:list[0];
    else target=UI.trapFocusTarget(list,active,!!e.shiftKey);
    if(!target)return false;
    if(typeof e.preventDefault==="function")e.preventDefault();
    try{target.focus()}catch(_){}
    return true;
  };

  window.__zpUi=UI;
})();

;
/* 智配One · 触感反馈层（js/ui/haptic.js）
 * ----------------------------------------------------------------------------
 * 统一入口 window.zpHaptic(kind)：让「手指按下去」有一次物理确认。
 *
 * 为什么要单独一层，而不是各处直接写 navigator.vibrate：
 *   1) App 内是 Capacitor WebView，Vibration API 在 WebView 里不可用——没声明
 *      VIBRATE 权限时 navigator.vibrate 恒返回 false，声明了在部分内核上也不通。
 *      壳内唯一可靠的路径是原生桥 window.ZhipeiNative.haptic()（MainActivity 里
 *      用 View.performHapticFeedback 实现，不申请任何权限）。
 *   2) 浏览器端相反：Android Chrome 只有 navigator.vibrate；iOS Safari 两者都没有。
 *   3) 上层只该表达「轻 / 中 / 成功 / 警示」四种语义，走哪条通道、震多久属于平台细节。
 *
 * 平台优先级：ZhipeiNative.haptic（壳内） > navigator.vibrate（浏览器） > 静默跳过。
 * 没有振动马达、用户关掉系统「触摸振动」时，「不震」就是正确结果——
 * 这里不打印任何提示，也不做「触感不可用」的降级 UI。
 *
 * 依赖：无（可独立加载，不依赖 core.js）。
 * 被依赖：nav.js 的底部导航、页面里带 data-zp-haptic 的按钮。
 */
(function(){
  if(window.zpHaptic)return;

  /* 只接受这四种语义；未知值一律按 light 处理，
     避免调用方写错 kind 时静默不震（更难排查）。 */
  const KINDS={light:1,medium:1,success:1,warn:1};

  /* 浏览器兜底参数（毫秒 / [震,停,震]）。壳内不用这些值——强度由系统
     HapticFeedbackConstants 决定，各厂商马达的标定由 ROM 负责，比手写时长更稳。 */
  const VIBRATE={light:10,medium:16,success:20,warn:[12,60,12]};

  /* 原生桥。属性访问成本可忽略，每次调用现探——
     壳的注入时机早于页面脚本，但 WebView 重建（如崩溃恢复）后会换实例，
     缓存住就会拿到失效对象。 */
  function bridge(){
    const n=window.ZhipeiNative;
    return n&&typeof n.haptic==="function"?n:null;
  }

  function nowMs(){
    return (typeof performance!=="undefined"&&performance.now)?performance.now():Date.now();
  }

  /* 节流。两个阈值解决两类抖动：
       - 同一 kind 120ms 内合并：底栏连点两下，不该震出「嗞嗞」两声；
       - 不同 kind 至少隔 60ms：确认框「取消→确定」这种极快的连击，
         不该把两次轻震叠成一次长震。
     静默丢弃而不是排队——触感的时效性只有几毫秒，延后补震反而是错的。 */
  let lastAt=0,lastKind="";
  function allow(kind){
    const now=nowMs();
    if(now-lastAt<(kind===lastKind?120:60))return false;
    lastAt=now;lastKind=kind;
    return true;
  }

  function zpHaptic(kind){
    const k=KINDS[kind]?kind:"light";
    if(!allow(k))return false;
    const b=bridge();
    if(b){
      try{ b.haptic(k); return true; }
      catch(e){/* 桥抛错（旧壳方法签名不符等）就当没有，继续走浏览器兜底 */}
    }
    const nav=window.navigator;
    if(nav&&typeof nav.vibrate==="function"){
      try{ return nav.vibrate(VIBRATE[k]); }catch(e){/* 无用户手势时 Chrome 会抛，忽略 */}
    }
    return false;
  }
  window.zpHaptic=zpHaptic;

  /* ===== 触发点 =====
     统一绑 click，不用 pointerdown/touchstart：
       - 手指按下后在按钮上滑走（滚动列表时的常见动作）不该有震动，
         只有「确实点在按钮上并抬起」才算一次操作——这也是系统控件的口径。
       - click 在现代浏览器没有 300ms 延迟，按下反馈由按钮自身的 :active 负责，
         触感补的是「这一下生效了」的确认感，时机正好。
  /* 绑在 capture 阶段：业务 handler 里的 stopPropagation/preventDefault 都吞不掉它
     （底栏「处理中离开」守卫就是先 stopPropagation 再弹确认框的）。

     ⚠ 选择器必须同时覆盖 <a> 和 <button>（2026-10-30 线上回归）：
     底栏项**不是同一种元素**。首页中央加号是 <button id="uploadAction">（点了就地开
     上传面板，不跳转），其他页的加号是 <a href="/home?openUpload=1">；管理端整条
     底栏全是 <button class="nav-item">。第一版只写了 `.zp-nav a`，于是
     「在别的页点加号有触感 → 跳到首页后，同一个加号变成按钮 → 再点就没感觉了」。
     只写 a 的版本会让一半底栏静默失效，且没有任何报错。 */
  const SEL=".zp-nav a,.zp-nav button,.admin-nav a,.admin-nav button,[data-zp-haptic]";
  document.addEventListener("click",e=>{
    const t=e.target;
    const el=t&&typeof t.closest==="function"?t.closest(SEL):null;
    if(!el)return;
    // data-zp-haptic 可取值 medium/success/warn；不写值或空串按轻触感处理。
    zpHaptic(el.getAttribute("data-zp-haptic")||"light");
  },true);
})();

;
/* 智配One · 外观偏好 + 线路名显示标准（原 js/ui-unified.js 拆分 · 2/6）
 * 主题（system/dark/light）与全局字号缩放，外加线路名的全局显示口径。
 * 依赖：无（core.js 只被 nav/back 需要，本模块自洽）。
 */
(function(){
  if(window.zpGetAppearanceTheme)return;

  /* ===== 线路名全局显示标准 =====
     圆点/徽章内（zpRouteShort）→ 只显示线路数字（26px 圆点放不下「6号线」），
     临时线路显示「临」；其它文字位置（zpRouteName）→ 统一「X号线」格式；
     无法归一为「数字+单位」结构的名字原样保留（如「机场线」）。 */
  const routeDigitsOf=value=>{const m=String(value??"").match(/\d+/);return m?m[0]:""};
  window.zpRouteShort=value=>{
    const raw=String(value??"").trim();
    if(!raw)return "—";
    if(/临时/.test(raw))return "临";
    const digits=routeDigitsOf(raw);
    if(digits)return digits;
    return raw.length<=2?raw:raw.slice(0,2);
  };
  window.zpRouteName=value=>{
    const raw=String(value??"").trim();
    if(!raw)return "";
    if(/号线$/.test(raw))return raw;
    const m=raw.match(/^(\d+)\s*(号线路|号线|号|路)$/);
    if(m)return m[1]+"号线";
    if(/^\d+$/.test(raw))return raw+"号线";
    return raw;
  };
  // 用户偏好只保存在当前浏览器，不写入业务账号或服务端数据。
  (function initAppearancePreferences(){
    const root=document.documentElement;
    const THEME_KEY="zp_appearance_theme";
    const SCALE_KEY="zp_appearance_font_scale";
    const validThemes=["system","dark","light"];
    const read=(key,fallback)=>{try{return localStorage.getItem(key)||fallback}catch{return fallback}};
    const applyTheme=theme=>{
      const chosen=validThemes.includes(theme)?theme:"system";
      const resolved=chosen==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):chosen;
      const dark=resolved!=="light";
      /* 主题底色严格成对：深色 #161616 ↔ 浅色 #FFFFFF（2026-11-04 随 Uber 实测色改版）。
         映射表是 meta theme-color 的唯一真值来源（浅色取映射值，深色取键本身），
         杜绝多处各写一半对不齐。 */
      const SHELL_BG={"#161616":"#FFFFFF"};
      const bg=dark?"#161616":SHELL_BG["#161616"];
      /* 外观切换必须原子换色（2026-11-03，深浅切换时顶部闪纯黑/纯白）：
         color-scheme 不是可过渡属性，data-zp-theme 一改就**瞬时**生效，把 UA 基层
         （canvas、滚动条、表单控件、WebView 合成层底色）立刻翻成该配方的默认极端色
         ——切深色是纯黑、切浅色是纯白；而 .zp-ui-ready 给所有元素（含 html/body）
         挂了 background-color .22s 渐变，主题色要 220ms 才到位。这两段时间常数不一致，
         中间那一截露出来的就是既非 #161616 也非 #FFFFFF 的过渡灰 —— 正是用户
         看到的「状态栏位置闪一下」。
         （2026-11-04 底色改为纯黑/纯白后，单程切换的两端恰好等于 UA 默认极端色，
          闪动幅度变小；但浅↔深的中间过渡灰仍存在，故整套原子换色逻辑继续保留。）
         做法：切换期间摘掉 zp-ui-ready（全站过渡都以它为宿主，摘掉即整体失效，
         比新增一条 !important 更干净，也不动 CSS 强制声明预算），换色在同帧原子完成，
         双 rAF 后再挂回，后续交互过渡不受影响。首帧前 zp-ui-ready 本就未挂，
         此时没有过渡可关，不必修。 */
      const wasReady=root.classList.contains("zp-ui-ready");
      if(wasReady)root.classList.remove("zp-ui-ready");
      /* 壳侧换色要多跳两趟线程（JavaBridge → runOnUiThread → 下一帧），比网页慢
         1~3 帧；改 DOM 之前先同步下发，让原生尽早起跑，两侧尽量落进同一帧。
         去重由 theme-sync.js 的 lastKey 兜住，随后观察器同主题调用不会重复跨桥。 */
      try{if(typeof window.zpShellThemeSync==="function")window.zpShellThemeSync(resolved,bg)}catch(e){}
      root.dataset.zpTheme=resolved;
      root.dataset.zpThemeChoice=chosen;
      const meta=document.querySelector('meta[name="theme-color"]');
      if(meta)meta.setAttribute("content",bg);
      document.dispatchEvent(new CustomEvent("zp:appearancechange",{detail:{theme:chosen,resolved}}));
      if(wasReady){
        try{requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.add("zp-ui-ready")))}
        catch(e){root.classList.add("zp-ui-ready")}
      }
    };
    // 全局字号缩放的目标标签：必须覆盖所有可能直接包裹文本的标签。
    // 历史教训：原先漏了 div（及 em/i/b/h5/h6 等文字级标签），导致如
    // .zp-empty 这类「div 直接包文字」的提示在调字号时完全不变化，
    // 表现为同一页面有的字变大有的不变。新增文字级标签时优先补到这里。
    const textSelector="p,span,a,button,label,input,select,textarea,li,td,th,strong,small,em,i,b,u,s,cite,code,kbd,var,mark,time,figcaption,option,optgroup,dt,dd,blockquote,caption,address,h1,h2,h3,h4,h5,h6,legend,summary,output,div,.summary,.message,.page2-soft,.store-row,.account-row,.page2-row,.page2-label,.topbar,.order-title";
    const collectTextTargets=(rootNode=document)=>{
      const targets=[];
      if(rootNode instanceof Element&&rootNode.matches(textSelector))targets.push(rootNode);
      rootNode.querySelectorAll?.(textSelector).forEach(el=>targets.push(el));
      return targets.filter(el=>!el.closest("svg,script,style"));
    };
    const cacheTextBase=el=>{
      if(el.dataset.zpFontBase)return;
      // 记录原始 inline 字号，恢复到 100% 时不破坏页面自己的行内样式。
      el.dataset.zpFontInline=el.style.getPropertyValue("font-size");
      el.dataset.zpFontInlinePriority=el.style.getPropertyPriority("font-size");
      let size=parseFloat(getComputedStyle(el).fontSize);
      // 动态插入的文本可能继承了已缩放父级的字号；若当前字号就是父级字号，
      // 继承父级的未缩放基准，避免再次乘比例造成层级越深文字越大。
      let parent=el.parentElement;
      while(parent&&parent!==document.documentElement){
        if(parent.dataset?.zpFontBase){
          const parentSize=parseFloat(getComputedStyle(parent).fontSize);
          if(Number.isFinite(parentSize)&&Math.abs(size-parentSize)<0.1){
            size=Number(parent.dataset.zpFontBase);
          }
          break;
        }
        parent=parent.parentElement;
      }
      if(Number.isFinite(size)&&size>0)el.dataset.zpFontBase=String(size);
    };
    const scanText=(rootNode=document)=>{
      const targets=collectTextTargets(rootNode);
      // 两阶段处理：先缓存整个子树的原始计算字号，再统一应用缩放；
      // 不能一边改父元素一边读取子元素，否则首次载入非 100% 字号时会层层叠乘。
      targets.forEach(cacheTextBase);
      const scale=Math.max(0.85,Math.min(1.3,Number(root.style.getPropertyValue("--zp-font-scale"))||1));
      targets.forEach(el=>{
        const base=Number(el.dataset.zpFontBase);
        if(Number.isFinite(base)&&base>0)el.style.setProperty("font-size",(base*scale)+"px","important");
      });
    };
    const resetTextScale=()=>{
      collectTextTargets(document).forEach(el=>{
        if(!el.dataset.zpFontBase)return;
        el.style.removeProperty("font-size");
        const inlineSize=el.dataset.zpFontInline||"";
        const inlinePriority=el.dataset.zpFontInlinePriority||"";
        if(inlineSize)el.style.setProperty("font-size",inlineSize,inlinePriority);
        delete el.dataset.zpFontBase;
        delete el.dataset.zpFontInline;
        delete el.dataset.zpFontInlinePriority;
      });
    };
    let textObserver=null;
    let textScaleActive=false;
    const applyScale=value=>{
      const n=Math.max(0.85,Math.min(1.3,Number(value)||1));
      root.style.setProperty("--zp-font-scale",String(n));
      if(Math.abs(n-1)<0.001){
        if(textObserver){textObserver.disconnect();textObserver=null;}
        // 默认字号不需要逐元素写入同值 !important，也不需要常驻 MutationObserver。
        if(textScaleActive)resetTextScale();
        textScaleActive=false;
      }else{
        scanText();
        textScaleActive=true;
        if(!textObserver&&document.body&&window.MutationObserver){
          textObserver=new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)scanText(node)})));
          textObserver.observe(document.body,{childList:true,subtree:true});
        }
      }
      document.dispatchEvent(new CustomEvent("zp:fontscalechange",{detail:{scale:n}}));
    };
    window.zpSetAppearanceTheme=theme=>{const v=validThemes.includes(theme)?theme:"system";try{localStorage.setItem(THEME_KEY,v)}catch{}applyTheme(v)};
    window.zpGetAppearanceTheme=()=>read(THEME_KEY,"system");
    window.zpSetFontScale=value=>{const n=Math.max(.85,Math.min(1.3,Number(value)||1));try{localStorage.setItem(SCALE_KEY,String(n))}catch{}applyScale(n)};
    window.zpGetFontScale=()=>Math.max(.85,Math.min(1.3,Number(read(SCALE_KEY,"1"))||1));
    applyTheme(window.zpGetAppearanceTheme());
    applyScale(window.zpGetFontScale());
    // 首帧后再开启过渡：避免初始渲染从浏览器默认色「闪」到主题色；
    // 此后主题切换与 :active 状态变化的颜色/背景才平滑过渡。
    try{requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.add("zp-ui-ready")))}catch(e){root.classList.add("zp-ui-ready")}
    if(window.matchMedia){
      const media=window.matchMedia("(prefers-color-scheme: light)");
      const onChange=()=>{if(window.zpGetAppearanceTheme()==="system")applyTheme("system")};
      media.addEventListener?media.addEventListener("change",onChange):media.addListener?.(onChange);
      // 布局断点切换（屏幕旋转/窗口缩放跨过 @media）会改变固定 px 字号的基准；
      // 若用户已开启非 100% 字号缩放，需重算基准，否则缩放值会停留在旧断点基准上。
      ["(max-width:430px)","(max-width:380px)","(max-width:360px)"].forEach(q=>{
        const mq=window.matchMedia(q);
        const onLayoutChange=()=>{if(textScaleActive){resetTextScale();scanText()}};
        mq.addEventListener?mq.addEventListener("change",onLayoutChange):mq.addListener?.(onLayoutChange);
      });
    }
  })();
})();

;
/* 智配One · 全局反馈层（原 js/ui-unified.js 拆分 · 3/6）
 * 确认框 zpConfirm、Toast zpToast、密码框「小眼睛」。
 * 依赖：core.js（共享状态桥）
 * 被依赖：nav.js（处理中离开确认）、back.js（返回 ladder 关闭确认框）
 */
(function(){
  if(window.zpConfirm)return;
  const UI=window.__zpUi||(window.__zpUi={state:{}});
  const sharedState=UI.state||(UI.state={});

  function esc(v){return String(v??"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]))}
  function ensure(){
    let el=document.getElementById("zpUiLayer");
    if(el)return el;
    el=document.createElement("div");
    el.id="zpUiLayer";
    el.innerHTML='<div class="zp-confirm" hidden><div class="zp-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="zpConfirmTitle"><h3 id="zpConfirmTitle"></h3><p id="zpConfirmText"></p><div class="zp-confirm-actions"><button type="button" data-zp-cancel>取消</button><button type="button" data-zp-ok>确定</button></div></div></div><div class="ui-toast" id="zpToast" aria-live="polite"></div>';
    document.body.appendChild(el);
    return el;
  }
  const eyeOpen='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 12s3.2-5 9.8-5 9.8 5 9.8 5-3.2 5-9.8 5-9.8-5-9.8-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  const eyeClosed='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6.6 0 9.8 6 9.8 6a16.5 16.5 0 0 1-3 3.5M6.2 6.3C3.5 8 2.2 12 2.2 12s3.2 6 9.8 6c1 0 1.9-.2 2.7-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function setupPasswordToggles(root=document){
    const inputs=[];
    if(root.matches?.('input[type="password"]'))inputs.push(root);
    root.querySelectorAll?.('input[type="password"]').forEach(input=>inputs.push(input));
    inputs.forEach(input=>{
      if(input.dataset.zpPasswordEyeBound==="1")return;
      let control=input.parentElement;
      if(!control?.classList.contains("zp-password-control")&&!control?.classList.contains("reset-password-control")){
        control=document.createElement("div");
        control.className="zp-password-control";
        input.parentNode.insertBefore(control,input);
        control.appendChild(input);
      }else control.classList.add("zp-password-control");
      let button=control.querySelector(":scope > .zp-password-eye");
      if(!button){
        button=document.createElement("button");
        button.type="button";
        button.className="zp-password-eye";
        button.setAttribute("aria-label","显示密码");
        button.setAttribute("aria-pressed","false");
        control.appendChild(button);
      }
      input.dataset.zpPasswordEyeBound="1";
      const sync=()=>{
        const hasValue=input.value.length>0;
        button.hidden=!hasValue;
        if(!hasValue&&input.type!=="password")input.type="password";
        const visible=input.type==="text";
        button.innerHTML=visible?eyeClosed:eyeOpen;
        button.setAttribute("aria-pressed",String(visible));
        button.setAttribute("aria-label",visible?"隐藏密码":"显示密码");
      };
      input.addEventListener("input",sync);
      input.addEventListener("change",sync);
      button.addEventListener("click",()=>{
        if(!input.value.length)return;
        input.type=input.type==="password"?"text":"password";
        sync();
        input.focus();
      });
      sync();
    });
  }
  window.zpSetupPasswordToggles=setupPasswordToggles;
  function initPasswordToggles(){
    setupPasswordToggles(document);
    if(document.body&&window.MutationObserver){
      const observer=new MutationObserver(records=>{
        records.forEach(record=>record.addedNodes.forEach(node=>{
          if(node.nodeType===1)setupPasswordToggles(node);
        }));
      });
      // 收敛（阶段 8 P3）：去掉 subtree:true —— 回调对新增节点递归查密码框，subtree 冗余；
      // 密码框或其容器是 body 直接子 addedNode 即被 childList 捕获（验证见 tests/tools/visual/inspect_observer.js）。
      observer.observe(document.body,{childList:true});
    }
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initPasswordToggles,{once:true});
  else initPasswordToggles();

  window.zpConfirm=function(title,text,okText){
    return new Promise(resolve=>{
      const root=ensure(),box=root.querySelector(".zp-confirm"),ok=root.querySelector("[data-zp-ok]"),cancel=root.querySelector("[data-zp-cancel]");
      root.querySelector("#zpConfirmTitle").textContent=title||"确认操作";
      root.querySelector("#zpConfirmText").textContent=text||"确定继续吗？";
      ok.textContent=okText||"确定";
      box.hidden=false;
      const previousOverflow=document.body.style.overflow;
      document.body.style.overflow="hidden";
      let done=false;
      const onKey=e=>{
        if(e.key==="Escape"){e.preventDefault();finish(false);return}
        // 焦点陷阱：对话框内 Tab/Shift+Tab 循环，键盘焦点不逃出遮罩
        if(e.key==="Tab"){
          const f=box.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
          const list=Array.from(f).filter(el=>!el.disabled&&el.offsetParent!==null);
          if(list.length){
            const first=list[0],last=list[list.length-1];
            if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
            else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
          }
        }
      };
      const finish=v=>{if(done)return;done=true;box.hidden=true;ok.onclick=null;cancel.onclick=null;box.onclick=null;document.removeEventListener("keydown",onKey);document.body.style.overflow=previousOverflow;resolve(v)};
      // 共享桥：android 返回键（back.js）与 Esc 走同一个 finish，
      // 否则关了框但滚动没解锁、Promise 永不 resolve。
      sharedState.confirmDismisser=()=>finish(false);
      ok.onclick=()=>finish(true);cancel.onclick=()=>finish(false);
      box.onclick=e=>{if(e.target===box)finish(false)};
      document.addEventListener("keydown",onKey);
      setTimeout(()=>cancel.focus(),0);
    });
  };

  window.zpToast=function(message,type="success"){
    const root=ensure(),toast=root.querySelector("#zpToast");
    toast.textContent=message||"";
    /* 底部有 tabbar（.zp-nav）时上抬：默认 bottom 24px 会压在加号按钮上，
       文案被挡一半。没有 tabbar 的页面（运单详情等）保持原位。 */
    const lift=document.querySelector(".zp-nav")?" above-nav":"";
    toast.className="ui-toast "+(type||"")+lift+" show";
    clearTimeout(window.zpToast._timer);
    window.zpToast._timer=setTimeout(()=>toast.classList.remove("show"),2200);
  };
})();

;
/* 智配One · 业务端常驻一级导航（原 js/ui-unified.js 拆分 · 4/6）
 * 底部 5 位导航的注入、「处理中离开」「点击已激活 tab」两道点击守卫，
 * 以及底栏的滚动自隐藏（2026-11-04）。
 * 依赖：core.js（区域判定）、feedback.js（zpConfirm，运行时才用）
 */
(function(){
  if(window.__zpNavInstalled)return;
  window.__zpNavInstalled=true;
  const UI=window.__zpUi;

  /* ===== 业务端常驻一级导航 ===== */
  function zpEnsureBusinessBottomNav(){
    // 直接调 UI.detectZone() 而不读任何在本函数之后声明的 const：
    // 本文件在 readyState!=="loading"（defer / 动态注入）时，底部这两行会先于
    // 那些声明执行，读 const 会触发 TDZ ReferenceError，导致整个常驻导航静默消失。
    // UI.detectZone 由 core.js 提供，先于本文件加载，可安全提前调用。
    if(UI.detectZone()!=="business")return;
    document.body.classList.add("zp-business-nav-page");
    if(document.querySelector(".zp-nav"))return;
    const path=UI.normPath(location.pathname);
    const q=new URLSearchParams(location.search);
    let active="";
    if(path==="/home")active="home";
    else if(path==="/pages/history")active="history";
    else if(path==="/pages/dispatch"||path==="/pages/data"||path==="/pages/route_apply")active="route";
    else if(path==="/pages/account")active="account";
    else if(path==="/pages/order_detail")active=(q.get("source")==="history"||q.get("from")==="history")?"history":"home";
    else if(path==="/pages/today")active="home";
    // 5 位结构：首页 / 历史 / 中间上传加号 / 线路 / 我的。
    // 「上传」由普通 tab 改为中心凸起圆形加号（plus:true 无文字标签，仅图标）。
    const items=[
      {id:"home",label:"首页",href:"/home",cls:"zp-nav-home",icon:'<path d="M3.5 9.8 12 3.5l8.5 6.3V19a1.5 1.5 0 0 1-1.5 1.5h-3.2v-6H9.2v6H5A1.5 1.5 0 0 1 3.5 19z"/>'},
      {id:"history",label:"历史",href:"/pages/history?from=home",icon:'<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 5v4h4"/><path d="M12 7.5v5l3.2 1.9"/>'},
      {id:"upload",label:"上传",href:"/home?openUpload=1",plus:true,icon:'<path d="M12 5v14"/><path d="M5 12h14"/>'},
      {id:"route",label:"线路",href:"/pages/dispatch?from=home",icon:'<path d="M4 6h16v12H4z"/><path d="M8 10h8M8 14h5"/>'},
      {id:"account",label:"我的",href:"/pages/account?from=home",icon:'<circle cx="12" cy="8" r="3"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/>'}
    ];
    const nav=document.createElement("nav");
    nav.className="zp-nav";
    nav.setAttribute("aria-label","主要功能");
    nav.innerHTML=items.map(item=>{
      const cls="zp-nav-item"+(item.cls?" "+item.cls:"")+(item.plus?" zp-nav-plus":"")+(active===item.id?" is-active":"");
      const label=item.plus?"":'<span>'+item.label+'</span>';
      const dim=item.plus?'width="24" height="24" stroke-width="2.2"':'width="21" height="21" stroke-width="1.8"';
      return '<a class="'+cls+'" href="'+item.href+'"'+(active===item.id?' aria-current="page"':"")+(item.plus?' aria-label="'+item.label+'"':'')+'><span class="zp-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" '+dim+' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'+item.icon+'</svg></span>'+label+'</a>';
    }).join("");
    document.body.appendChild(nav);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",zpEnsureBusinessBottomNav,{once:true});
  else zpEnsureBusinessBottomNav();

  // 业务处理进行中时，常驻导航不能无提示地把用户带离当前运单流程。
  document.addEventListener("click",async e=>{
    const link=e.target.closest?.(".zp-nav a");
    if(!link||typeof window.zpIsProcessing!=="function"||!window.zpIsProcessing())return;
    const href=link.getAttribute("href")||"";
    if(!href||link.dataset.zpNavGuarded==="1")return;
    e.preventDefault();
    e.stopPropagation();
    if(typeof window.zpLeaveProcessing==="function"){
      await window.zpLeaveProcessing(href);
    }else if(typeof window.zpConfirm==="function"){
      const ok=await window.zpConfirm("退出本次处理？","本次识别与规划将中止，尚未保存的结果不会保留。","退出本次处理");
      if(ok)location.replace(href);
    }
  },true);

  // 一级导航：点击已激活的底部 tab 不再跳回首页（已有独立首页按钮，跳转属多余），
  // 而是停留在当前页并把内容滚回顶部（成熟 App 范式，如微信/Instagram）。
  // 点击未激活 tab 仍照常导航到对应页面（走 a 默认 href）。
  // 首页上传弹窗的 toggle 由 home.js 处理（#uploadAction，非 a 标签，不走本规则）。
  document.addEventListener("click",e=>{
    const active=e.target.closest?.(".zp-nav a.is-active");
    if(!active)return;
    if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing())return; // 处理中交由上方守卫确认
    e.preventDefault();
    const scroller=document.querySelector(".zp-scroll");
    if(scroller)scroller.scrollTop=0;
    window.scrollTo(0,0);
  },true);

  /* ===== 底栏滚动自隐藏（2026-11-04 用户提出缺此交互） =====
     浮岛化后底栏仍是常驻 fixed，长列表滚到中途会压住内容。规则取主流 App 口径：
       · 向下滚、离开顶部一段后，累计位移到阈值 → 收起
       · 向上滚累计到位 → 立刻回来（回滑即回，不等停手）
       · 滚到顶部 → 强制显示（回顶时底栏应在，避免「滚回去却空着」的突兀）
     注意：滚到【底部】不再强制弹起——与 Uber 一致：尾段若已收起就保持收起，
     用户继续上滑/回滑才回来。页面内容为底栏让的 88px 在底栏收起时本就留作末段余白，
     这是浮动底栏的固有取舍，Uber 同样如此。
     几条实现约束：
       · scroll 不冒泡，只能用捕获阶段监听；同时覆盖 .zp-scroll 内滚与整页滚动。
       · 首页底栏是 HTML 静态写的、其余页由上面注入，故一律按类名现取，不持有引用。
       · 只认「页面级主滚动容器」类名（.zp-scroll / .order-store-list），不靠占屏比例：
         首页「今日门店」内嵌列表、帮助弹层、导入面板等内嵌滚动不带这些类，天然被排除，
         在小区块里划两下不会把底栏收掉。改类名识别是为修「隐藏失效」——「占屏过半」
         这类比例判据在真机上不可靠：PWA standalone 顶部白条让视口高度与容器高度
         语义错位，数据中心固定工具区展开、order 页顶部卡片、分屏 / 系统大字号都会把
         主滚动区压到过半以下，一旦低于门槛整页怎么滚底栏都不收。
       · 阈值用累计位移而非单帧位移：惯性滚动每帧只有几 px，单帧判断收不起来。 */
  var NAV_HIDE_DELTA=8;    // 累计位移达到这个数才切换，抗抖动
  var NAV_SHOW_TOP=56;     // 距顶这个范围内永远显示（底栏不强显，随 Uber 口径）
  var navEl=null,navHidden=false,navLastY=-1,navAcc=0,navTicking=false;

  function navScrollTarget(e){
    var el=e.target;
    // 整页滚动（document/window 触发）→ 认文档滚动元素，覆盖「降级为整页滚动」的页面
    if(!el||el===document||el===window)return document.scrollingElement||document.documentElement;
    if(el.nodeType!==1)return null;
    // 只认页面级主滚动容器类名，且确实可滚动。不用「占屏过半」的比例判据：
    // 该类比例在真机（PWA 白条 / 固定区展开 / 大字号 / 分屏）会误判主滚动区为「小区块」，
    // 导致底栏完全不隐藏（数据中心隐藏失效的根因）。
    if((el.classList.contains("zp-scroll")||el.classList.contains("order-store-list"))&&
       el.scrollHeight-el.clientHeight>4)return el;
    return null;
  }
  function navApply(hide){
    if(!navEl||!navEl.isConnected){
      navEl=document.querySelector(".zp-nav");
      if(!navEl)return;
      navHidden=navEl.classList.contains("is-nav-hidden"); // 元素被替换过时以实际类名为准
    }
    if(navHidden===hide)return;
    navHidden=hide;
    navEl.classList.toggle("is-nav-hidden",hide);
    /* 收起后退出现行 Tab 序。2026-11-05 五版：不能整条 inert ——
       按参考软件的做法，收起时中间的加号仍留在屏幕底部、并且要能点，
       父级 inert 会把加号一起废掉（inert 无法在子级局部解除）。
       改为只把其余导航项移出 Tab 序 / 读屏：位移出屏只是看不见，
       键盘和读屏若不处理仍会停在一排看不见的链接上。 */
    var items=navEl.querySelectorAll(".zp-nav-item"),i;
    for(i=0;i<items.length;i++){
      if(items[i].classList.contains("zp-nav-plus"))continue;
      if(hide){items[i].setAttribute("tabindex","-1");items[i].setAttribute("aria-hidden","true");}
      else{items[i].removeAttribute("tabindex");items[i].removeAttribute("aria-hidden");}
    }
  }
  /* 首页顶部浮层启用时，底栏显隐由 js/home/head-float.js 统一接管（顶底互斥反向），
     这里必须让位，否则两套逻辑会互相覆盖 .is-nav-hidden。其余页面行为不变。 */
  window.zpNavSetHidden=function(hide){navApply(hide)};

  function navOnScroll(e){
    if(window.__zpHeadFloatActive)return;
    var el=navScrollTarget(e);
    if(!el||navTicking)return;
    navTicking=true;
    requestAnimationFrame(function(){
      navTicking=false;
      var y=el.scrollTop;
      if(navLastY<0){navLastY=y;return;}   // 首帧只记位置：恢复滚动位置跳进来时不当作「向下滚了很远」
      var max=el.scrollHeight-el.clientHeight;
      var dy=y-navLastY;
      navLastY=y;
      if(y<=NAV_SHOW_TOP){navAcc=0;navApply(false);return;}
      navAcc=dy>0?Math.max(0,navAcc)+dy:Math.min(0,navAcc)+dy;
      if(navAcc>=NAV_HIDE_DELTA){navAcc=0;navApply(true);}
      else if(navAcc<=-NAV_HIDE_DELTA){navAcc=0;navApply(false);}
    });
  }
  document.addEventListener("scroll",navOnScroll,{capture:true,passive:true});
})();
/* 业务端一级导航样式见 css/ui-overlay.css / css/ui-theme.css（.zp-business-nav-page 相关规则）。
   历史教训：曾有人把 CSS 整段粘贴进 JS，导致文件语法错误、整个 UI 层全部失效——
   现在已有 tests/js-syntax.test.mjs 在 CI 里挡住这一类改动。 */

;
/* 智配One · 全局返回控制器（原 js/ui-unified.js 拆分 · 5/6）
 * ----------------------------------------------------------------------------
 * 顶部返回按钮 与 Android 系统返回执行同一套逻辑 zphandleBack()，按
 * 「上一级业务上下文」逐级返回。业务来源一律由 URL 的 from= 明确携带，
 * 严禁使用 document.referrer / history.length 推断。
 *
 * 层级解析顺序（rank 小者优先）：
 *   10 Dialog/Bottom Sheet  20 Drawer/菜单  30 未保存编辑
 *   40 左滑展开行          50 页面导航     60 工作区根(两次返回退出)
 *
 * zpHandleBack 返回值：
 *   "handled"    页面内消费掉一层 UI（或拒绝关闭），调用方需补压 guard 历史项
 *   "exit-armed" 工作区根首次返回，已 toast 提示；不补压，下次返回交给系统退出
 *   "exit"       工作区根第二次返回，确认退出应用；调用方必须执行 zpDoExit()
 *   "leave"      非根页面的普通返回，已 location.replace 发起页面导航；
 *                调用方不要再做任何历史动作，否则一次返回会变成退两层
 *
 * 依赖：core.js（normPath / detectZone / normFrom / 共享状态）
 * 被依赖：无（各业务页在运行时调用 window.zpHandleBack / zpRegisterBackHook）
 */
(function(){
  if(window.zpHandleBack)return;
  const UI=window.__zpUi||(window.__zpUi={state:{}});
  const sharedState=UI.state||(UI.state={});

  /* 返回层级模型（ZP-NAV-2026-002 · 修订 G，2026-10-30 二次修订）：
   *
   *   depth 0  工作区根   /home、/admin                       → 两次返回退桌面
   *   depth 1  功能根页   history / dispatch / account / today → 回区根
   *   depth 2  细节页     order_detail / data / route_apply / privacy / terms
   *                                                           → 回来源父级，无来源回区根
   *
   * 为什么不是「一律回区根」（修订 F）：子页面也收口到 /home 之后，
   * 「历史 → 运单详情 → 返回」会直接跳回首页，用户丢掉「刚才看的是哪一天」；
   * 数据资料、线路申请这类二级编辑页同理，返回等于放弃上下文。返回的语义是
   * 「上一层界面」，只有**没有**上一层时才是区根。
   *
   * 为什么不用 history.back()：站内导航统一 replace（见文件末尾），栈里没有上一页；
   * 且依赖浏览器历史会让「首页返回又退回内页」的老问题复发（v1.0.18 前的实测序列
   * 首页 → 首页 → 历史 → 首页）。层级在这里显式声明，不猜 referrer、不猜 history.length。
   *
   * 单根保证不变：目标 depth 必须**严格小于**当前页，所以不会平级横跳
   * （派单→历史→返回不会回到派单），也不可能跨区（业务区拿不到 /admin）。
   */
  const zpZone=UI.detectZone();
  // 区根用无扩展名形态（省一次 308 跳转；带 .html 的旧写法依赖重定向也能到）
  const zpRoot=zpZone==="admin"?"/admin":"/home";
  const zpIsWorkspaceRoot=UI.normPath(location.pathname)===UI.normPath(zpRoot);

  // 删除类操作（如删完当天最后一张运单）之后调用：把 URL 上的 id/date 摘掉，
  // 避免刷新或 bfcache 恢复时又落回已删除的对象（详情页变「读取失败」空态）。
  window.zpMarkStale=function(){
    // 同时把当前历史项里的失效 id/date 摘掉，避免刷新或 bfcache 恢复时又回到死链
    try{
      const u=new URL(location.href);
      u.searchParams.delete("id");u.searchParams.delete("date");
      history.replaceState(history.state,"",u.pathname+u.search);
    }catch{}
  };

  // 页面层级表。未知页面按 1 处理（只往区根走），宁可保守也不给未登记页面编造层级。
  const zpPageDepth={
    "/home":0,"/admin":0,
    "/pages/history":1,"/pages/dispatch":1,"/pages/account":1,"/pages/today":1,
    "/pages/order_detail":2,"/pages/data":2,"/pages/route_apply":2,"/pages/privacy":2,"/pages/terms":2
  };
  function zpDepthOf(path){
    const k=UI.normPath(path);
    return Object.prototype.hasOwnProperty.call(zpPageDepth,k)?zpPageDepth[k]:1;
  }
  // from= → 父级。**只认白名单键**：from 由 URL 携带、任何人可改，不能当跳转指令用
  // （历史实现直接拿 from 拼路径，`from=admin` 就能把业务页送进管理端）。
  const zpFromParent={
    history:"/pages/history",
    dispatch:"/pages/dispatch",
    account:"/pages/account",
    process:"/home",
    home:"/home"
  };
  /* 静态父级：没有 from= 也能确定归属的页。
     页脚/条款归属「我的」；数据中心归属「线路维护」——它是「线路维护」页里的
     「数据中心」入口进来的二级页，默认返回就该回到线路维护，丢回首页会丢掉
     刚选的线路上下文（2026-11-05 产品设定）。from=order 的编辑往返在
     zpParentOf 最前面单独处理，不受这里影响。 */
  const zpStaticParent={
    "/pages/privacy":"/pages/account",
    "/pages/terms":"/pages/account",
    "/pages/data":"/pages/dispatch"
  };

  /* 本页是否由「静态父级 → 子页」的普通导航 push 进来（见文件末尾的放行逻辑）。
     标记由父页点击时写入、子页加载时立即消费并清除，只属于当前文档生命周期；
     严格校验「本页的静态父级 === 标记值」，避免残留标记误判。 */
  let zpCameByPush=false;
  try{
    const marker=sessionStorage.getItem("zpNavPushParent");
    if(marker){
      sessionStorage.removeItem("zpNavPushParent");
      const here=UI.normPath(location.pathname);
      zpCameByPush=!!zpStaticParent[here]&&UI.normPath(marker)===UI.normPath(zpStaticParent[here]);
    }
  }catch(e){}

  function zpParentOf(path,params){
    // 详情 → 数据资料（编辑线路）：必须回到那张运单，否则用户丢掉正在改的单。
    // 这是一对同级页的往返（2↔2），返回给 allowSameDepth 豁免；
    // 回填的 from 取 origin（详情页原本的来源），保证再按返回还能继续往上一层走，
    // 不会变成 detail⇄data 无限来回。
    if(path==="/pages/data"&&params.get("from")==="order"){
      const id=params.get("id")||"";
      if(!id)return {url:zpRoot};
      const origin=params.get("origin")||"";
      const back=Object.prototype.hasOwnProperty.call(zpFromParent,origin)?origin:"process";
      const od=params.get("odate")||"";
      return {
        url:"/pages/order_detail?id="+encodeURIComponent(id)+"&source=process&from="+back+(od?"&date="+encodeURIComponent(od):""),
        allowSameDepth:true
      };
    }
    const from=params.get("from")||"";
    // 回历史列表时带上原日期：历史页用 date 参数定位到那一天（focusDate），
    // 不带的话用户回来只看到默认区间，等于又得重新找一遍。
    if(from==="history"){
      const d=params.get("date")||"";
      return {url:d?"/pages/history?date="+encodeURIComponent(d):"/pages/history"};
    }
    if(Object.prototype.hasOwnProperty.call(zpFromParent,from))return {url:zpFromParent[from]};
    return {url:zpStaticParent[path]||zpRoot};
  }

  // 返回目标解析。
  window.zpResolveBack=function(){
    let path=zpRoot;
    try{path=UI.normPath(location.pathname)}catch{}
    const depth=zpDepthOf(path);
    // 区根与功能根页：只往区根走（功能根页之间是平级，不互相回跳）
    if(depth<=1)return zpRoot;
    let target=zpRoot,sameDepth=false;
    try{
      const r=zpParentOf(path,new URLSearchParams(location.search));
      target=r.url;sameDepth=!!r.allowSameDepth;
    }catch{}
    // 安全阀一：本站绝对路径（拒绝 //evil、外链、相对路径）
    if(typeof target!=="string"||target.charAt(0)!=="/"||target.charAt(1)==="/")return zpRoot;
    let tpath;
    try{tpath=UI.normPath(new URL(target,"https://x.invalid").pathname)}catch{return zpRoot}
    // 安全阀二：深度必须严格更小（防 from 手改成同级页导致 A↔B 死循环）；
    // 唯一例外是 detail⇄data 的编辑往返，已在 zpParentOf 里显式声明。
    if(!sameDepth&&zpDepthOf(tpath)>=depth)return zpRoot;
    // 安全阀三：跨区（管理员区不产生任何业务路径目标）
    if(zpZone==="admin"&&tpath!=="/admin")return zpRoot;
    return target;
  };
  window.zpGoBack=function(fallback){location.replace(zpResolveBack(fallback))};

  // 可见性探测：同时覆盖 [hidden] 元素 与 内联 style.display 的弹层
  function zpIsVisible(el){
    if(!el||el.hidden)return false;
    if(el.closest&&el.closest("[hidden]"))return false;
    let cs;try{cs=getComputedStyle(el)}catch{return false}
    if(!cs||cs.display==="none"||cs.visibility==="hidden"||cs.opacity==="0")return false;
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0;
  }

  // 返回层级钩子。页面脚本先于本文件加载，故用「自初始化 push」写法。
  // 注意：push 不会排序，必须在每次消费前统一按 rank 升序，否则本文件追加的
  // 内置钩子会排到页面钩子之后，优先级失效。
  function zpSortedHooks(){
    const h=window.zpBackHooks||[];
    h.sort((a,b)=>((a&&a.rank)|0)-((b&&b.rank)|0));
    return h;
  }
  window.zpBackHooks=window.zpBackHooks||[];
  window.zpRegisterBackHook=function(h){
    if(!h||typeof h.probe!=="function")return;
    window.zpBackHooks.push(h);
    zpSortedHooks();
  };
  // 页面级未保存拦截（无弹层时的编辑态，如数据页暂存修改）
  window.zpDirtyProbes=window.zpDirtyProbes||[];

  window.zpDismissConfirm=function(){if(sharedState.confirmDismisser)sharedState.confirmDismisser()};

  // 内置层级①：通用确认框（zp-confirm）。rank 5 低于所有页面钩子，
  // 保证「确认框一定是最先响应返回的那层」，避免被页面弹层抢先导致二次弹窗。
  window.zpBackHooks.push({rank:5,
    probe:()=>document.querySelector("#zpUiLayer .zp-confirm"),
    close:()=>{
      if(sharedState.confirmDismisser){sharedState.confirmDismisser();return true}
      const el=document.querySelector("#zpUiLayer .zp-confirm");
      if(el){el.hidden=true;document.body.style.overflow=""} // 兜底务必解锁滚动
      return true;
    }});

  let zpExitArmed=false,zpExitTimer=0,zpLeaving=false,zpAdminNonRoot=false;
  // 压一条「占位历史」，使第一次系统返回先触发 popstate（被本控制器接管），
  // 而不是直接越过首条记录由系统关掉 PWA（那样就没有「再按一次」提示了）。
  function zpPushGuard(){
    try{history.pushState({zpGuard:((history.state&&history.state.zpGuard)|0)+1},"")}catch{}
  }

  /* ===== 退出接力（2026-11-04）=====
     登录跳转写的是 /home?v=时间戳，底栏「首页」Tab 却是 /home。站内导航一律
     location.replace，只替换「当前项」，栈底那条 /home?v= 会永久残留；点 Tab 回到
     首页后，第二次返回会落到这条 URL 不同的首页记录并**重新加载文档**，旧文档的
     popstate 回调（含 zpDoExit）来不及跑就被卸载，于是人还留在 App 里退不出去。
     修法不猜历史长度：第二次返回时把「正在退出」同步写进 sessionStorage，下一份
     业务页文档发现自己是 back/forward 到达且带有效标记，就在 load 之后继续后退，
     直到真正离开站点。zpExitAt 给标记 3 秒时效；正常 navigate 打开 App 时清标记，
     绝不会把新会话一进来就退掉。 */
  const ZP_EXIT_TTL=3000;
  function zpHasExit(){
    try{
      if(sessionStorage.getItem("zpExitAdmin")!=="1")return false;
      const t=Number(sessionStorage.getItem("zpExitAt")||0);
      if(!t)return true;                       // 旧格式 / 管理员跨区标记：无时效，靠 back/forward 判定兜底
      return Date.now()-t<ZP_EXIT_TTL;
    }catch{return false}
  }
  /* 第一次返回（exit-armed）也落盘：第二次返回若落到 URL 不同的历史项，
     浏览器是「跨文档」后退，旧文档收不到 popstate，zpHandleBack/zpDoExit 都不会跑。
     新文档只能靠这个标记认出「用户正在再按一次退出」的窗口里。 */
  function zpHasExitReady(){
    try{
      const t=Number(sessionStorage.getItem("zpExitReady")||0);
      return !!t&&Date.now()-t<2500;
    }catch{return false}
  }
  function zpClearExitMarks(){
    try{sessionStorage.removeItem("zpExitAdmin");sessionStorage.removeItem("zpExitAt");sessionStorage.removeItem("zpExitReady")}catch{}
  }
  function zpIsBackNav(){
    try{
      // performance.navigation.type（2 = TYPE_BACK_FORWARD）在文档刚创建时同步可读；
      // Navigation Timing 的 entry 要晚一点才有，back.js 是头部/尾部同步脚本，等不到它。
      if(performance.navigation&&performance.navigation.type===2)return true;
      const n=performance.getEntriesByType&&performance.getEntriesByType("navigation")[0];
      if(n&&n.type==="back_forward")return true;
    }catch{}
    return false;
  }
  function zpContinueExit(){
    const go=()=>{try{history.back()}catch{}};
    // 文档加载期同步调用 history.back() 会被浏览器丢弃，必须等 load 之后再退。
    if(document.readyState==="complete")setTimeout(go,0);
    else window.addEventListener("load",()=>setTimeout(go,0),{once:true});
  }

  async function zpConfirmDiscard(){
    const ok=await window.zpConfirm("放弃修改？","当前修改尚未提交，返回后将丢失。","放弃");
    return ok;
  }

  /* ===== 不可中断操作守卫（ZP-NAV-2026-002 第五节）=====
     运单正在 OCR/规划（首页）与核对页正在提交确认，都属于「已经发出写请求」的状态：
     此时返回键既不能关弹层、也不能离开页面——离开会留下服务端已落库但用户以为放弃的运单，
     或让客户端提前释放上传引用却不知道结果。统一在这里拦下并提示，只有一个出口：等结果。
     请求本身有服务端超时兜底（OCR_TIMEOUT / PROCESS_*），不会永久卡死。 */
  function zpBusyMessage(){
    try{
      if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing())return "运单正在处理，请稍候";
      if(typeof window.zpIsConfirming==="function"&&window.zpIsConfirming())return "正在保存，请稍候";
    }catch{}
    return "";
  }

  // 自上而下关闭一层 UI；返回 true 表示本次返回已被页面内消化
  async function zpCloseTopLayer(){
    const busy=zpBusyMessage();
    if(busy){
      if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing()&&typeof window.zpLeaveProcessing==="function"){
        await window.zpLeaveProcessing();
        return true;
      }
      try{window.zpToast?window.zpToast(busy,"error"):0}catch{}
      return true;   // 保存中仍禁止离开，处理中则走统一取消确认
    }
    const hooks=zpSortedHooks();
    for(const h of hooks){
      let el=null;try{el=h.probe()}catch{continue}
      if(!el||!zpIsVisible(el))continue;
      if(typeof h.dirty==="function"){
        let dirty=false;try{dirty=!!h.dirty()}catch{}
        if(dirty&&!await zpConfirmDiscard())return true; // 留在编辑，不穿透
      }
      try{await h.close()}catch{}
      // 已消费一层。注意：close 的返回值不参与判定——无论它返回什么，本次返回都算被页面内
      // 消化、不再向下穿透。所谓"拒绝关闭"（如首页上传进行中）的语义就等价于"不穿透"，
      // 具体提示由 close 内部自行 toast，不需要靠返回值表达。
      return true;
    }
    return false;
  }

  // 自上而下找出最上层可见弹层（ESC/Tab 分发器用）。返回 null 表示当前没有弹层。
  function zpTopHook(){
    for(const h of zpSortedHooks()){
      let el=null;try{el=h.probe()}catch{continue}
      if(!el||!zpIsVisible(el))continue;
      return h;
    }
    return null;
  }
  window.zpCloseTopLayer=zpCloseTopLayer;

  /* ===== ESC 关闭 + Tab 焦点陷阱（与 Android 返回键共用同一分层阶梯）=====
     - ESC：只关闭最上层的页面内弹层；当前没有弹层时什么都不做——不退出应用、不导航，
       与系统返回键「越界退出」的语义刻意区分开。
     - Tab：把焦点锁在最上层弹层内（容器由该层的 hook.trap 提供）。自带陷阱的层
       （如确认框 zpConfirm）不提供 trap，沿用它自己的实现。
     ⚠ ESC 必须与 Android 返回键走同一套 rank 阶梯，否则两层弹层叠放时会出现
       「ESC 关掉下层、上层还挂着」的错位（历史浮层与确认框曾因此互相抢层级）。 */
  document.addEventListener("keydown",async e=>{
    if(e.key==="Escape"){
      if(e.defaultPrevented)return; // 上层组件已自行处理（如 zp-picker 在捕获阶段拦截）
      const top=zpTopHook();
      if(!top)return;               // 无弹层：ESC 不越界退出
      e.preventDefault();           // 同步阻止默认行为（须在事件派发结束前）
      await zpCloseTopLayer();
      return;
    }
    if(e.key!=="Tab")return;
    const h=zpTopHook();
    if(!h||typeof h.trap!=="function")return;
    let root=null;try{root=h.trap()}catch{return}
    if(!root)return;
    const UI=window.__zpUi||{};
    if(typeof UI.trapTab!=="function")return;
    UI.trapTab(root,e);
  });

  window.zpHandleBack=async function(fromPopstate){
    if(await zpCloseTopLayer())return "handled";
    if(zpIsWorkspaceRoot){
      // 管理员空间：先把模块收口到管理员首页（模块 0），再走「两次返回退桌面」。
      // 2026-10-30 起返回键不再注销会话：旧实现在这里 POST /api/logout 直接回登录页，
      // 既违反「返回键永不登出」，也无法满足 A1「管理员首页返回 = 退桌面、不进入业务首页」。
      if(zpZone==="admin"){
        const A=window.ZPAdmin;
        const cur=A&&A.S&&typeof A.S.page==="number"?A.S.page:0;
        if(cur>0&&A&&typeof A.page==="function"){
          A.page(0);
          return "handled";
        }
      }
      if(zpExitArmed){
        // 管理员与普通用户统一：第二次返回只退出 App，不注销、不清理任何登录凭证。
        // 同步落盘退出意图（不能放进 zpDoExit）：本次返回可能跨文档，旧文档的
        // popstate 回调随时会被卸载，下一份业务页要靠这个标记接着往后退。
        try{sessionStorage.setItem("zpExitAt",String(Date.now()))}catch{}
        try{sessionStorage.setItem("zpExitAdmin","1")}catch{}
        return "exit";
      }
      zpExitArmed=true;
      try{sessionStorage.setItem("zpExitReady",String(Date.now()))}catch{}
      try{window.zpToast?window.zpToast("再按一次退出应用","info"):0}catch{}
      clearTimeout(zpExitTimer);
      // 窗口过期：仅复位武装标记，不再补占位。
      // 安卓独立 PWA 下 window.close() 对「主页启动的顶层上下文」是空操作，
      // 真正退出只能靠「越过首条记录让系统关掉 PWA」。武装期间刻意不补占位，
      // 第二次返回才能退到首条记录之前、由系统退回桌面；补占位反而会让第二次
      // 返回卡在管理端、要多按几次才滑出去（旧版就表现为「穿越到业务首页」）。
      // 窗口过期：复位武装标记。仅当管理员端「非根」（同窗口进入、底下压着业务端首页）
      // 时补回占位——这样停顿后再按会重新武装而非直接滑到司机首页；管理员端「根」
      // （独立窗口，底下无业务页）则不补，保证停顿后下一次返回能越过首条记录由系统退出。
      zpExitTimer=setTimeout(()=>{zpExitArmed=false;try{sessionStorage.removeItem("zpExitReady")}catch{};if(zpZone==="admin"&&zpAdminNonRoot)zpPushGuard()},2000);
      return "exit-armed";
    }
    // 离开页面前：页面级未保存拦截
    for(const fn of (window.zpDirtyProbes||[])){
      let dirty=false;try{dirty=!!fn()}catch{}
      if(dirty&&!await zpConfirmDiscard())return "handled";
    }
    const target=zpResolveBack("/home");
    /* 本页是「父级 → 子页」push 进来的，且返回目标正是那个父级：
       用物理后退消费栈里那条父级记录，浏览器直接加载父级文档。
       顶栏箭头（非 popstate）与原生壳都走这里；弹层阶梯、未保存拦截
       已在上面跑完，不会绕过。popstate 路径不这么做 —— 那次 back 是系统
       自己发起的，再做一次 history.back() 会多退一层。 */
    const here=UI.normPath(location.pathname);
    if(!fromPopstate&&zpCameByPush&&zpStaticParent[here]&&
       UI.normPath(target)===UI.normPath(zpStaticParent[here])){
      zpCameByPush=false;
      /* 多页架构下父子 URL 不同，这次 back 是跨文档加载父级页，
         不会触发子页的 popstate，无需抑制标记（同文档场景不存在）。 */
      try{history.back();return "leave"}catch(e){}
    }
    location.replace(target);
    return "leave";
  };

  // 真正离开应用：越过首条历史记录，由系统退出 PWA（浏览器里退回上一站）。
  // 顶部返回按钮 与 Android 物理/手势返回共用这一出口，保证两者行为完全一致。
  // 安卓独立 PWA 下 window.close() 对「主页启动的顶层上下文」是空操作，唯一可靠的退出
  // 方式是让浏览器越过首条记录去关掉 PWA；武装期间刻意不补占位，此刻当前页正停在首条
  // 记录上，再 back() 一步即越过去。即便历史里残留业务端首页，这一步会一并越过。
  function zpDoExit(){
    zpLeaving=true;
    // 原生壳内：直接结束 Activity。v1.0.19 起壳层返回键已不看 canGoBack、不走 goBack，
    // WebView 里的 history.back() 只会把页面退回上一页而退不出应用，唯一可靠出口是
    // ZhipeiNative.exitApp()（原生 finish()）。存在壳就立即返回，不再碰历史。
    try{
      const N=window.ZhipeiNative;
      if(N&&typeof N.exitApp==="function"){N.exitApp();return}
    }catch{}
    // 独立 PWA / 浏览器：越过首条历史记录，由系统退出（退回上一站/桌面）。
    // 置位一次性退出标记：若历史里残留业务端首页，下一页加载时会继续后退，绝不停在司机首页
    try{sessionStorage.setItem("zpExitAdmin","1")}catch{}
    try{history.back()}catch{}
    try{
      const standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone===true;
      if(standalone)window.close(); // 部分环境可真正收起；失败则上面的 back 已越界退出
    }catch{}
  }
  // 顶部返回按钮专用出口：必须消费 zpHandleBack 的返回值。以前直接丢弃返回值，
  // 根页第二次点返回拿到"退出"却什么都不做——顶部按钮永远退不出应用，只有物理键能退。
  async function zpBackButton(){
    const r=await zpHandleBack();
    if(zpLeaving)return;
    // 只有「关掉一层后下面还压着弹层」才补占位。
    // 顶部按钮与原生返回键都不消费历史记录（它们不触发 popstate），无脑补压会平白
    // 多出一条记录：离开本页时 location.replace 只替换当前项，这条多余记录就成了
    // 指向内页的孤儿，连按返回又会退回已经离开的页面（v1.0.18 之前的老毛病）。
    if(r==="handled"){if(zpTopHook())zpPushGuard();return}
    if(r==="exit"){zpDoExit();return}
    // "leave"：非根页面的普通返回，location.replace 已发起页面导航，此处不做任何额外动作
  }

  /* 原生壳在 WebView「无历史可退」时调用 window.zpSystemBack()（MainActivity 的
     OnBackPressedCallback）。拆分 ui-unified.js 时这个入口被漏掉，导致登录/引导页按
     返回毫无反应——这里补回来：登录页（未识别工作区）返回即退出 App；工作区页则完整
     走一遍 zpBackButton（根页两次返回退桌面）。 */
  /* 子页面不压占位（见 zpBindPageBack 里的说明），所以「不可中断操作」开始时
     必须显式申请一条：否则保存中按返回会直接离开页面，绕过 zpBusyMessage。
     业务侧在 confirming=true / 长任务开始处调用；重复调用无副作用。 */
  window.zpArmGuard=function(){
    try{if(!(history.state&&history.state.zpGuard))zpPushGuard()}catch{}
  };

  window.zpSystemBack=function(){
    if(!zpZone){
      try{
        const N=window.ZhipeiNative;
        if(N&&typeof N.exitApp==="function"){N.exitApp();return}
      }catch{}
      return;
    }
    return zpBackButton();
  };

  /* ===== 站内导航一律 replace（2026-10-30） =====
     多页架构下每个 <a href> 都会 push 一条历史。历史里压着历史页、详情页之后，
     按返回就会「首页 → 详情 → 历史 → 首页」地反复横跳，连按多次才退得出去，
     方向完全不可预期——这正是最初那段录屏。
     层级返回（见文件开头的 zpPageDepth）解决的是「该回到哪一层」，
     replace 解决的是「栈里根本不该留那么多层」：两者缺一不可。
     站内跳转统一 replace 后，栈里只留当前页一条正式记录（外加根页的占位），
     返回目标由层级表算，绝不会被历史记录带偏。
     判定：同源 + 以 / 开头 + 无 target/download/修饰键；外链、下载、mailto/tel、
     纯锚点一律放行。用冒泡阶段并检查 defaultPrevented，不抢业务自己处理的点击
     （如处理中的离开确认、选中 tab 滚回顶部）。 */
  /* 有静态父级的子页（数据资料 / 页脚条款）：若当前页正好就是那个父级，
     放行普通 <a> 导航，让物理历史保留「父级 → 子页」两层。
     ------------------------------------------------------------------
     为什么必须留这一条例外：站内一律 replace 时，子页的上一条历史记录是
     「工作区根」文档。安卓手势/系统返回是跨文档后退，浏览器直接加载根页，
     popstate 不触发，zpHandleBack 的层级控制完全没机会介入 —— 线上表现为
     「数据资料按返回回到首页而不是线路维护」。顶栏箭头走 zpBackButton 不受影响，
     所以只有系统返回错。保留父级记录后，系统返回自然落回父级页。 */
  function zpPushChildParent(destPath){
    let parent=null;
    try{parent=zpStaticParent[UI.normPath(destPath)]||null}catch(e){}
    if(!parent)return false;
    let here;
    try{here=UI.normPath(location.pathname)}catch(e){return false}
    if(here!==UI.normPath(parent))return false;
    try{sessionStorage.setItem("zpNavPushParent",here)}catch(e){}
    return true;
  }

  document.addEventListener("click",function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(!a||(a.target&&a.target!=="_self")||a.hasAttribute("download"))return;
    const raw=a.getAttribute("href")||"";
    if(!raw||raw.charAt(0)==="#"||/^(mailto:|tel:|javascript:)/i.test(raw))return;
    let url;try{url=new URL(raw,a.baseURI)}catch{return}
    if(url.origin!==location.origin)return;
    // 同页链接（当前 tab、页内跳转）：不重复导航，否则又会压一条同样的历史
    if(url.pathname===location.pathname&&url.search===location.search)return;
    if(zpPushChildParent(url.pathname))return;   // 放行：浏览器自己 push 一条历史
    e.preventDefault();
    location.replace(url.href);
  },false);

  function zpBindPageBack(){
    document.querySelectorAll(".app-back,#backBtn").forEach(el=>{
      if(el.dataset.zpBackBound==="1")return;
      el.dataset.zpBackBound="1";
      el.addEventListener("click",e=>{e.preventDefault();zpBackButton()});
    });
  }

  /* ===== 工作区隔离：管理员端与业务端互不串线 =====
     角色由登录页 / 管理端写入 sessionStorage（zpRole），业务页据此做门禁：
       1) 正在执行「退出应用」流程（zpExitAdmin 置位）→ 放行并继续后退，绝不停留；
       2) 管理员会话却落在业务页 → 立刻送回管理端，业务界面一帧都不露出。
     退出登录一律先回到登录页，登录页进入即清空 zpRole，因此换账号登录司机后不会被误判。 */
  window.zpSetRole=function(role){
    try{sessionStorage.setItem("zpRole",(role==="admin"||role==="system_admin")?"admin":"user")}catch{}
  };
  window.zpClearRole=function(){try{sessionStorage.removeItem("zpRole")}catch{}};
  // 登录态同步标记：业务页头部守卫据此在「渲染前」即时判定放行/拦截，避免未登录先渲染再跳转（可被返回绕过）。
  window.zpAuthOK=function(){try{sessionStorage.setItem("zpAuth","1")}catch(e){}};
  window.zpAuthClear=function(){try{sessionStorage.removeItem("zpAuth")}catch(e){}};
  // 会话失效（401）兜底：清标记并回登录页。供各页 /api/me 失败时调用。
  window.zpAuthFail=function(reason){try{sessionStorage.removeItem("zpAuth")}catch(e){}try{localStorage.removeItem("zpLastAuth");localStorage.removeItem("zpLastRole")}catch(e){}try{location.replace("/?reason="+(reason||"expired"))}catch(e){}};
  function zpIsAdminSession(){
    try{return sessionStorage.getItem("zpRole")==="admin"}catch{return false}
  }
  // 返回 true 表示本页已被隔离逻辑接管，调用方应停止后续初始化
  function zpZoneGuard(){
    if(zpZone!=="business")return false;
    const backNav=zpIsBackNav();
    // 正常 navigate 打开 App：清掉上一轮全部退出标记，TTL 还没过期也不会误退。
    if(!backNav)zpClearExitMarks();
    if(backNav&&(zpHasExit()||zpHasExitReady())){
      // 退出接力：清掉 armed 预置，写正式退出标记（下一份文档还能继续接力），
      // load 之后继续后退，直到真正离开站点。此刻绝不能弹回管理端，
      // 否则「两次返回退出」会变成回到管理端，永远退不出去。
      try{
        sessionStorage.removeItem("zpExitReady");
        sessionStorage.setItem("zpExitAt",String(Date.now()));
        sessionStorage.setItem("zpExitAdmin","1");
      }catch{}
      zpContinueExit();
      return true;
    }
    if(zpIsAdminSession()){try{location.replace("/admin")}catch{};return true}
    return false;
  }

  (function zpInstallBack(){
    // 管理员端与司机端同处一个 PWA 窗口。登录即栈底（location.replace 进入，背后无首页），
    // 故正常进入时 admin 就是历史首条记录；极少数「司机会话→退出→再登录管理员」路径下，
    // 历史里会残留业务端首页（非根）。下面的跨区退出标记负责兜底：离开管理员端时（或进入时
    // 若已非根）置一次性标记，业务端页（全新加载 / bfcache 恢复都会触发）消费标记继续后退，
    // 直到真正退出 PWA，绝不停在司机首页。
    // 非根判定：admin.html 加载时历史长度 >1，说明它底下还压着别的文档（如司机首页）。
    zpAdminNonRoot=(zpZone==="admin")&&(function(){try{return history.length>1}catch{return false}})();
    if(zpZone==="business"){
      // 业务区门禁：管理员会话不在此停留；正在退出则继续后退（内部已处理标记）
      if(zpZoneGuard())return;
    }else{
      // 非业务页：清残留（含时间戳与 armed 预置），防误触把新会话退出去
      zpClearExitMarks();
    }
    // 管理员端「非根」进入（历史里残留业务端首页，如司机会话→退出→再登录管理员）：
    // 进入即置跨区退出标记，保证任何一次离开都能越过业务端首页，直接退到桌面。
    if(zpZone==="admin"&&zpAdminNonRoot){
      try{sessionStorage.setItem("zpExitAdmin","1")}catch{}
    }
    zpBindPageBack();
    // bfcache 恢复不会重跑本 IIFE，但系统返回完全可能把用户带回到一个缓存的业务页
    // （管理员端最容易踩到），因此恢复时再过一次门禁。
    window.addEventListener("pageshow",e=>{zpBindPageBack();if(e.persisted)zpZoneGuard()});
    if(!zpZone)return; // 登录/引导页只统一按钮行为，不安装系统返回守卫
    // 只有「工作区根」压占位（2026-10-30 修正）。
    // 根页需要它：第一次系统返回先被本控制器接管，才有「再按一次退桌面」。
    // 子页面**不能**压：location.replace 只替换「当前项」，多压一条占位会让
    // 上一个页面的正式记录永久残留在栈里，连按返回就退回已经离开的内页
    // （线上实测序列：首页 → 首页 → 历史查询 → 首页）。
    // 子页面按返回直接落到栈里的根页，正是单根模型要的结果，不需要占位。
    if(zpIsWorkspaceRoot&&!(history.state&&history.state.zpGuard))zpPushGuard();
    window.addEventListener("popstate",async()=>{
      if(window.zpSuppressPop){window.zpSuppressPop=false;return} // 自己触发的 back，吃掉
      /* 第二次返回（已武装）必须同步走完退出，绝不能 await：这次返回常落到 URL
         不同的历史项并重新加载文档，旧文档的 async 续体会在导航完成前被卸载，
         zpDoExit 与退出标记都来不及落地，人就卡在栈底那条残留首页上。 */
      if(zpExitArmed&&zpIsWorkspaceRoot&&!zpLeaving&&!zpTopHook()){
        zpExitArmed=false;clearTimeout(zpExitTimer);
        try{sessionStorage.removeItem("zpExitReady");sessionStorage.setItem("zpExitAt",String(Date.now()))}catch{}
        zpDoExit();
        return;
      }
      // 业务端页上（含 bfcache 恢复）：消费跨区退出标记，继续后退直到真正退出
      if(zpZone==="business"&&zpHasExit()){
        // 同文档（URL 相同、未重载）的返回也要接力：标记不删，逐条退到离开站点。
        try{history.back()}catch{};return
      }
      /* 传 true：系统自己已经退过一层历史，不能再 history.back() 多退一层 */
      const r=await zpHandleBack(true);
      if(zpLeaving)return;
      if(r==="handled"){if(zpTopHook())zpPushGuard();return} // 还有下一层要关才补占位；层关光了就不再补，免得堆出孤儿记录
      if(r==="exit-armed")return;               // 处于「再按一次退出」窗口：窗口内再按即离开
      // "leave" = 非根页面的普通返回。此时 location.replace 已把当前历史项换成目标页，
      // 绝不能再置跨区退出标记、也不能再 back() 一步：那会把「一次返回」变成退两层，
      // 甚至在详情页按返回时连带退出 PWA。只有工作区根确认退出（"exit"）才走 zpDoExit。
      if(r==="exit")zpDoExit();
    });
  })();
})();

;
/* ===== 页面跳转预取（2026-10-20 中国大陆慢网专项）=====
 * 背景：线上实测（不走 VPN）跨境链路每个新连接 TLS 握手要 2~13s，单次文档 TTFB
 * 0.35~7.4s，而页面又没有校验器可协商缓存 —— 这就是「页面之间跳转慢」的全部来源。
 * 客户端能补的一环：在用户点下去之前就把目标页的 HTML 和连接预热好，
 * 让「点击 → 看到页面」不再压着这段跨境往返。
 *
 * 三条铁律（勿改，tests/nav-prefetch.test.mjs 逐条断言）：
 *   1. 只预取**静态页面 HTML**。/api/*、第三方域名一律不碰（SW 也不缓存 API）。
 *   2. 弱网/省流量模式直接放弃（navigator.connection.saveData / 2g）。
 *   3. 全程 try/catch + 幂等去重，任何异常都不能影响主流程。
 *
 * （原 js/ui-unified.js 拆分 · 6/6，无依赖，可最后加载）
 */
(function(){
  if(typeof window==="undefined"||!window.document)return;
  if(window.__zpNavPrefetchInstalled)return;
  window.__zpNavPrefetchInstalled=true;

  /* 每个页面出发最可能去的地方。只填相对固定的全静态目标，
     带业务参数的详情页（如 order_detail?date=…）放它的基础路径即可：
     预取只是暖 HTTP 缓存，详情页自己仍会按参数重新取数据。 */
  const TARGETS={
    "/home":["/pages/today","/pages/history","/pages/dispatch","/pages/account"],
    "/home.html":["/pages/today","/pages/history","/pages/dispatch","/pages/account"],
    "/today":["/home","/pages/history"],
    "/pages/today":["/home","/pages/history"],
    "/history":["/home","/pages/order_detail"],
    "/pages/history":["/home","/pages/order_detail"],
    "/dispatch":["/home","/pages/history"],
    "/pages/dispatch":["/home","/pages/history"],
    "/account":["/home"],
    "/pages/account":["/home"],
    "/data":["/home"],
    "/pages/data":["/home"],
    "/admin":["/home"],
  };
  const DEFAULT_TARGETS=["/home"];
  const MAX=4;                       // 一次会话最多预取几个，别把弱网带宽挤光
  const done=new Set();

  const normalize=raw=>{
    try{const u=new URL(raw,location.href);
      if(u.origin!==location.origin)return null;             // 第三方不碰
      const p=u.pathname.replace(/\/+$/,"")||"/";
      if(p.indexOf("/api/")===0)return null;                 // 业务数据不碰
      return p;
    }catch(e){return null}
  };
  const allowed=()=>{
    try{const c=navigator.connection||navigator.mozConnection||null;
      if(c&&(c.saveData||/(^|-)2g$|^slow-2g$/.test(c.effectiveType||"")))return false;
    }catch(e){}
    return true;
  };
  const prefetch=raw=>{
    try{
      // 统一入口守卫：空闲预热与 pointerdown/touchstart 意图预取都必须遵守弱网策略。
      if(!allowed())return false;
      const path=normalize(raw);
      if(!path||done.has(path)||done.size>=MAX)return false;
      done.add(path);
      const link=document.createElement("link");
      link.rel="prefetch";            // 低优先级，不与当前页资源抢带宽
      link.as="document";
      link.href=path;
      link.crossOrigin="anonymous";
      (document.head||document.documentElement).appendChild(link);
      return true;
    }catch(e){return false}
  };
  /* 空闲时预热：把「下一批可能去的页面」的 TCP/TLS 连接先建立起来。
     即使浏览器策略没把结果放进 HTTP 缓存，连接预热本身也省掉了最贵的握手。 */
  const warmOnIdle=()=>{
    if(!allowed())return;
    const key=(location.pathname||"/").replace(/\/+$/,"")||"/";
    const list=TARGETS[key]||DEFAULT_TARGETS;
    list.forEach(prefetch);
  };
  try{
    if(window.requestIdleCallback)window.requestIdleCallback(warmOnIdle,{timeout:2500});
    else setTimeout(warmOnIdle,1500);
  }catch(e){try{setTimeout(warmOnIdle,1500)}catch(_){}}

  /* 意图预取：pointerdown/touchstart 比 click 早几十到几百毫秒，
     这段时间足够把目标页的连接甚至文档准备好。 */
  document.addEventListener("pointerdown",e=>{
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(a)prefetch(a.getAttribute("href"));
  },{passive:true,capture:true});
  document.addEventListener("touchstart",e=>{
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(a)prefetch(a.getAttribute("href"));
  },{passive:true,capture:true});
})();

;
/* 智配One · PWA 注册 + 版本守卫
 * 确保线上修复/改版在用户设备上真正生效（避免永远跑着陈旧缓存的 JS）。
 *
 * 背景（2026-10-21 复盘）：单靠 controllerchange 不够——若设备当前跑着旧版
 * pwa.js（尚未注册 controllerchange 监听），新 SW 接管后旧页面不会重载，
 * 表现为「部署成功却看不到修复」。故做多层兜底：
 *   1) sw.js 激活后主动 navigate() 所有已打开页面（见 sw.js 注释，根治旧设备）；
 *   2) controllerchange 监听：新 SW 接管时重载（覆盖 SW 激活后新出现的客户端）；
 *   3) 版本守卫：加载完成 / 回前台时比对 /version.json，发现新版本号即重载
 *      （兜底「只升了版本号、SW 未变」的发布场景，如发版 tag 仅改 version.json）。
 * 注册失败静默忽略——不支持或 HTTPS 不可用时应退化为普通网页，不能影响业务。
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  const SEEN_KEY = "zp-seen-version";   // 本地记忆「上次见到的版本号」，避免重复刷新
  let refreshing = false;
  let lastGuardAt = 0;
  const GUARD_INTERVAL = 30_000;        // 版本守卫最多每 30s 查一次，避免频繁打网络

  function doReload() {
    if (refreshing) return;
    // 运单识别/规划等处理中：延后重载，避免打断当前流程；处理结束后再试。
    if (typeof window.zpIsProcessing === "function" && window.zpIsProcessing()) {
      setTimeout(doReload, 2000);
      return;
    }
    refreshing = true;
    window.location.reload();
  }

  // 新 SW（新版本）接管当前页面时触发一次：重载以加载新 HTML/JS/CSS。
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    doReload();
  });

  // 版本守卫：发布新版本号后，即使 SW 未变也能把旧页面拉到最新。
  async function guardVersion() {
    const now = Date.now();
    if (now - lastGuardAt < GUARD_INTERVAL) return;   // 节流：同一会话内不频繁打网络
    lastGuardAt = now;
    try {
      const _f = window.zpFetch || fetch;
      const res = await _f("/version.json?ts=" + now, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const live = data && typeof data.version === "string" ? data.version : null;
      if (!live) return;
      let seen = null;
      try { seen = localStorage.getItem(SEEN_KEY); } catch { /* 隐私模式：忽略守卫 */ }
      if (!seen) {                                    // 首次：记下当前版本，不刷新
        try { localStorage.setItem(SEEN_KEY, live); } catch { /* 忽略 */ }
        return;
      }
      if (live !== seen) {                            // 新版本已发布：更新记忆并刷新（单跳，不会循环）
        try { localStorage.setItem(SEEN_KEY, live); } catch { /* 忽略 */ }
        doReload();
      }
    } catch (_) { /* 网络异常忽略，下次回前台再试 */ }
  }

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
    setTimeout(guardVersion, 1500);                  // 首屏稍后核对，避免与首屏渲染抢资源
  });
  // 应用从后台切回前台（用户重新打开 App / 切回标签页）时再核对一次
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") guardVersion();
  });
})();

;
/* js/home/head-float.js —— 首页顶部两层浮层的显隐（方向驱动二态弹收）
   ------------------------------------------------------------------
   p∈[0,1]：顶部浮层展开进度。p=1 完整展开、p=0 整块钻到品牌区天花板背后。

   2026-11-07 第七轮（用户：「上滑屏幕下方浮岛隐藏、上方浮岛弹出；下滑屏幕下方浮岛
   弹出、上方浮岛隐藏。目前刚好反了，请修正」）：
   把方向映射对调 —— 上一轮是「上滑 → 上方收回、底栏升起」，正好相反。
   现在：
     · 上滑（内容上移，scrollTop 变大）→ 上方浮岛弹出 + 下方浮岛隐藏；
     · 下滑（内容下移，scrollTop 变小）→ 上方浮岛隐藏 + 下方浮岛弹出；
     · 只累计同向位移 6px 即切换（屏幕一动就反应），方向反转立刻清零
       （惯性回弹、手抖不会来回闪）；
     · 不再有「回到顶部必弹」的位置例外：回顶是一次下滑，按下滑规则走。

   其余不变：
     · 只有两个稳定态 p=1 / p=0，切换走 --zp-island-dur/.ease（.14s 同曲线），
       与底栏同帧起步同帧停住 —— 这就是「上下呼应」；
     · 滚动帧只在跨方向时写一次 p，不做比例跟随 → 没有「挂在内容上滑」；
     · 允许遮挡：纯 overlay，不写任何文档流高度（spacer 恒 0），列表的 scrollTop
       与行位置在弹收全程一格不动 —— 「浮岛运动会推动门店列表」的红线继续守住。
   底栏：上方浮岛弹出 → 下方浮岛沉下；上方浮岛隐藏 → 下方浮岛升起。
   两者是互斥反向的一对，共用同一对运动令牌，所以同帧起步、同帧停住。 */
(function(){
  var main=document.querySelector("main.home-app");
  if(!main)return;
  var float=document.getElementById("zpHeadFloat");
  var scroller=main.querySelector(":scope > .zp-scroll");
  var topbar=main.querySelector(":scope > .topbar");
  if(!float||!scroller||!topbar)return;

  /* 通知 nav.js：首页底栏显隐由本模块接管（互斥反向），停用其滚动自隐藏，
     否则两套逻辑会互相覆盖 .is-nav-hidden。 */
  window.__zpHeadFloatActive=true;

  var H=1;                 /* 浮层高度（= transform 的 100% 行程） */
  var p=1;                 /* 当前展开进度，二态：只会是 1 或 0（探针 setP 例外） */
  var shown=true;          /* 二态真值：true=弹出、false=收回 */
  var rafId=0, navHidden=null, booted=false;

  /* MOVE=同向累计位移多少即切换（6px 基本等于「屏幕一动就反应」，方向反转清零
     让回弹不误触）。TOP_AT 只用于首帧定态：进首页时在顶部就展开配送卡，
     之后方向完全由手指决定（回到顶部是一次下滑，按下滑规则隐藏上方浮岛）。 */
  var TOP_AT=6, MOVE=6;
  var lastSt=0, acc=0;

  function clamp(v,a,b){return v<a?a:(v>b?b:v)}
  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  /* 顶底互斥反向：浮岛弹出（p=1）→ 底栏沉下；收回（p=0）→ 底栏升起。
     与浮岛同一次状态切换、同一对运动令牌，所以同帧起步、同帧停住。 */
  function syncNav(){
    var want=p>=.5;
    if(want!==navHidden){navHidden=want;navHide(want)}
  }
  function write(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
    /* 投影只在弹出时出现：收回态保持干净底色，避免阴影溢出到品牌区下沿 */
    float.classList.toggle("is-open",p>=.5);
  }
  /* 二态切换：一次写到底，交给 CSS 的 .14s 过渡去弹/收。
     不逐帧写 —— 这正是「不跟着屏幕滑」与「弹出/收回」的分界。 */
  function apply(show,animate){
    if(show===shown)return;
    shown=show;
    p=show?1:0;
    float.classList.toggle("is-scrolling",animate===false);
    write();
    syncNav();
  }

  /* 方向驱动：屏幕一动就给反应。
     d>0 = 内容上移（手指往上推）→ 上方浮岛弹出、下方浮岛隐藏；
     d<0 = 内容下移（手指往下拉）→ 上方浮岛隐藏、下方浮岛弹出。
     只累计与当前方向相同的位移，反向立刻清零（惯性回弹不误触）。 */
  function frame(){
    rafId=0;
    var st=scroller.scrollTop;
    var d=st-lastSt;
    lastSt=st;
    if(!d)return;
    if((acc>0)!==(d>0))acc=0;
    acc+=d;
    if(acc>=MOVE){                        /* 上滑 → 上方弹出（下方随互斥隐藏） */
      acc=0;
      if(!shown)apply(true);
    }else if(acc<=-MOVE){                 /* 下滑 → 上方隐藏（下方随互斥弹出） */
      acc=0;
      if(shown)apply(false);
    }
  }
  /* 滚动帧只在跨方向时真正改状态；其余帧只是读一次 scrollTop。 */
  function onScroll(){
    if(!rafId)rafId=requestAnimationFrame(frame);
  }

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    main.style.setProperty("--zp-ceiling-h",Math.max(0,br.bottom-mr.top)+"px");
    H=Math.round(float.getBoundingClientRect().height)||1;
    /* 首帧必须无过渡：CSS 初始是展开态（避免 JS 到位前先闪一下 -100%），
       首帧按当前 scrollTop 定态时若带 .14s，会看到浮岛「滑进来」一下。 */
    var first=!booted;
    if(first){
      booted=true;
      shown=scroller.scrollTop>TOP_AT?false:true;
      p=shown?1:0;
      lastSt=scroller.scrollTop;
      acc=0;
      float.classList.add("is-scrolling");
      /* 首帧底栏也要瞬间到位：弹出态底栏本来就该沉下，若带 .14s，
         进首页会看到底部自己滑一下。掐掉过渡，下一帧恢复。 */
      var nv=document.querySelector(".zp-nav");
      if(nv)nv.style.transition="none";
      navHidden=p>=.5;
      navHide(navHidden);
      write();
      requestAnimationFrame(function(){
        float.classList.remove("is-scrolling");
        if(nv)nv.style.transition="";
      });
    }else{
      write();
    }
  }

  scroller.addEventListener("scroll",onScroll,{passive:true});

  /* 显式切换（供线上探针与桌面调试使用）。animate=false 时禁过渡，用于摆放基线。 */
  function setP(v,animate){
    v=clamp(v,0,1);
    shown=v>=.5;
    p=v;
    lastSt=scroller.scrollTop;
    acc=0;
    if(animate===false)float.classList.add("is-scrolling");
    else float.classList.remove("is-scrolling");
    write();
    syncNav();
  }

  if(window.ResizeObserver){
    new ResizeObserver(function(){measure()}).observe(float);
  }else{
    window.addEventListener("resize",measure,{passive:true});
  }
  window.addEventListener("load",measure);
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure)}catch(e){}

  window.__zpHeadFloat={
    getP:function(){return p},
    getH:function(){return H},
    isShown:function(){return shown},
    setP:setP,
    show:function(){setP(1,true)},
    hide:function(){setP(0,true)}
  };
  measure();
})();
