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

  // 测试与线上排查用：暴露策略常量，便于断言"弱网阈值没被偷偷改松"
  var api = zpFetch;
  api.policy = DEFAULT;
  api.netHint = netHint;
  api.safeToRetry = safeToRetry;
  api.worthRetrying = worthRetrying;
  window.zpFetch = api;
})();
