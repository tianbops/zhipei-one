/* 智配One · 状态栏 / 主题色同步
 * ------------------------------------------------------------------
 * 背景：Android 壳的状态栏底色由宿主（原生层）控制，Web 侧只有两条通道能影响它：
 *   1) <meta name="theme-color">：PWA standalone、Chrome/Custom Tabs、以及部分 WebView 壳
 *      会读这个值给状态栏上色；
 *   2) Capacitor StatusBar 插件（壳内已安装时）：可直接改原生状态栏底色。
 *
 * 本文件在主题确定后同步这两条通道，并在用户切换深/浅主题时跟随变化
 * （监听 <html data-zp-theme> 属性变化）。
 *
 * 刻意只设“底色”，不设图标明暗：Capacitor 的 StatusBar.setStyle 枚举
 * （Dark/Light 究竟指“深色文字”还是“深色背景”）在各版本间语义不一致，
 * 一旦设反会让白色图标压在浅色底上不可读。壳当前是“深底 + 浅图标”，
 * 深色主题把底色换成 --zp-bg(#121826) 仍在同一明度区间，图标可读性不受影响；
 * 浅色主题因此不改底色，交由壳自身处理。
 */
(function () {
  "use strict";
  var COLORS = { dark: "#121826", light: "#F6F7F9" };

  function currentTheme() {
    var t = document.documentElement.getAttribute("data-zp-theme");
    if (t === "dark" || t === "light") return t;
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  function syncMeta(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      (document.head || document.documentElement).appendChild(meta);
    }
    if (meta.getAttribute("content") !== color) meta.setAttribute("content", color);
  }

  function syncNative(theme, color) {
    try {
      var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (!sb || typeof sb.setBackgroundColor !== "function") return;
      if (theme !== "dark") return; /* 见文件头说明：浅色主题不动壳的默认状态栏 */
      var r = sb.setBackgroundColor({ color: color });
      if (r && typeof r.catch === "function") r.catch(function () {});
    } catch (e) {}
  }

  function apply() {
    var theme = currentTheme();
    var color = COLORS[theme] || COLORS.light;
    syncMeta(color);
    syncNative(theme, color);
  }

  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  try {
    new MutationObserver(apply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-zp-theme"]
    });
  } catch (e) {}
})();
