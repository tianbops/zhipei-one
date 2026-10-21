/* 智配One · PWA 注册
 * 注册根目录的 Service Worker，并在新版本 SW 接管控制后自动重载页面，
 * 确保线上修复/改版在用户设备上真正生效（避免永远跑着陈旧缓存的 JS）。
 * 注册失败静默忽略——不支持或 HTTPS 不可用时应退化为普通网页，不能影响业务。
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  let refreshing = false;
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
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();
