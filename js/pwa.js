/* 智配One · PWA 注册
 * 只做一件事：注册根目录的 Service Worker。
 * 注册失败静默忽略——不支持或 HTTPS 不可用时应退化为普通网页，不能影响业务。
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();
