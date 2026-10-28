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
 * 两套主题都同时设「图标明暗 + 底色」：
 *   深色 → 浅色图标（白）+ #121826 底
 *   浅色 → 深色图标（黑）+ #F6F7F9 底（对应设计稿里“浅底黑字”的系统状态栏）
 * 只设底色不设图标会出现「白图标压在浅底上」不可读，所以两者必须成对下发；
 * 调用顺序也固定为「先切图标明暗、再改底色」，避免中间态闪一下不可读。
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
      if (!sb) return;
      /* StatusBar 的 Style 枚举是按「背景明暗」命名的，与字面直觉相反：
           Style.Dark  = 深色背景 → 浅色（白）图标
           Style.Light = 浅色背景 → 深色（黑）图标
         浅色主题要的“黑色状态栏文字”就是 Style.Light。
         先切图标明暗、成功后再改底色：避免中间态出现「白图标压在浅底上」不可读。 */
      var wantStyle = theme === "dark" ? "DARK" : "LIGHT";
      var p = typeof sb.setStyle === "function" ? sb.setStyle({ style: wantStyle }) : null;
      Promise.resolve(p)
        .then(function () {
          if (typeof sb.setBackgroundColor === "function") return sb.setBackgroundColor({ color: color });
        })
        .catch(function () {});
    } catch (e) {}
  }

  /* 去重：apply 会在「脚本执行 / DOMContentLoaded / 主题属性变化」三处触发，
     同一主题下重复下发只会白白多打几次原生 IPC（StatusBar 调用是跨桥的）。 */
  var lastKey = "";

  function apply() {
    var theme = currentTheme();
    var color = COLORS[theme] || COLORS.light;
    var key = theme + "|" + color;
    if (key === lastKey) return;
    lastKey = key;
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
