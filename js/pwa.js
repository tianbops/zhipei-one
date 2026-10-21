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
