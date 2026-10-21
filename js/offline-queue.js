/* 智配One · 离线重取队列（P1-4 首个增量）
 * ------------------------------------------------------------------
 * 场景：配送员在弱网/无网环境打开历史页，GET 直接失败；此前只能显示错误、
 * 等用户手动下拉/重进。本模块把「当前离线、稍后重取」登记下来，**网络恢复
 * （online 事件 / 回前台）时自动重放**，且按 key 去重（同 key 只保留最后一次）。
 *
 * 纪律（与 zpFetch「POST 不重试」一脉相承）：
 *   · **只重放幂等 GET 刷新**。写操作（POST/PUT/DELETE）不纳入本队列——
 *     重放写操作等于重复业务，仍走「失败后用户手动重试」。
 *   · 登记即调用方责任：调用方传入的 fn 必须是「可安全重复执行」的只读刷新
 *     （如 history 的 load()、今日配送的 loadHome()）。
 *   · 纯加法、零副作用依赖：未加载本脚本时，调用方用 `window.zpOfflineQueue?.`
 *     可选链调用，缺失即静默跳过，绝不因缺模块而报错。
 *
 * 暴露：window.zpOfflineQueue = { scheduleRefresh, flush, isOffline, size }
 */
(function () {
  var pending = new Map();   // key -> fn（同 key 覆盖，天然去重）
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

  function flush() {
    if (flushing) return;
    if (isOffline() || pending.size === 0) return;
    flushing = true;
    (async function () {
      var jobs = Array.from(pending.entries());
      pending.clear();
      for (var i = 0; i < jobs.length; i++) {
        try { await jobs[i][1](); } catch (e) { /* 单条失败不阻塞其余重放 */ }
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
    flush: flush,
    isOffline: isOffline,
    size: function () { return pending.size; },
  };
})();
