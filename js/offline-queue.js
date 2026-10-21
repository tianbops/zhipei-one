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
