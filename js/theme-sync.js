/* 智配One · 状态栏 / 主题色同步
 * ------------------------------------------------------------------
 * 背景：Android 壳的状态栏底色由宿主（原生层）控制，Web 侧有三条通道能影响它：
 *   1) window.ZhipeiNative.applyTheme(color, darkBg)：智配One 壳自带的自定义
 *      JS 接口（MainActivity.NativeChrome），直接设状态栏/导航栏底色与图标明暗，
 *      并把 WebView、DecorView 背景一起染色。这是 App 内的唯一有效通道。
 *   2) Capacitor StatusBar 插件（壳内已安装时）：可直接改原生状态栏底色。
 *   3) <meta name="theme-color">：PWA standalone、Chrome/Custom Tabs 用。
 *
 * 本文件在首屏固定深色后同步三条通道；系统外观与旧的本地主题偏好均不再影响页面。
 *
 * 固定深色：白色系统图标 + #121826 页面底色，避免系统浅色外观带来白底闪屏。
 */
(function () {
  "use strict";
  var COLORS = { dark: "#121826" };

  /* App 壳标记：安卓壳用 WebView 外边距把状态栏区域整体让开（MainActivity
     .applyInsetsMargins），所以页面内的顶部 padding 与状态栏并不重叠，可以压到很小
     （参照系统导航栏的 12dp 口径）。Web 端没有这层让位，仍需 24px 免得标题贴屏幕顶，
     故用属性区分环境，而不是把全局值一刀切小。

     必须在首帧前打标，否则会看到「标题先低后高」跳一下 —— 本脚本因此由 defer 改为
     同步加载（各页 head）。桥由壳在页面脚本前注入，这里一定能读到。 */
  try {
    var nat0 = window.ZhipeiNative;
    var cap = window.Capacitor;
    if ((nat0 && typeof nat0.applyTheme === "function") ||
        (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform())) {
      document.documentElement.setAttribute("data-zp-native", "1");
    }
  } catch (e) {}

  function currentTheme() { return "dark"; }

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
    var dark = theme === "dark";
    /* ① 智配One 壳的自定义桥：applyTheme(色值, 是否深色底)。
       壳里 applyChrome() 会一次性完成状态栏/导航栏底色、图标明暗、WebView 与
       DecorView 背景染色，所以这里是 App 内最直接也最完整的一条通道。
       必须在 StatusBar 插件之前尝试：壳并未安装 @capacitor/status-bar，
       只走插件分支的话 App 内会完全没有效果（线上深色状态栏一直不跟随的根因）。 */
    try {
      var nat = window.ZhipeiNative;
      if (nat && typeof nat.applyTheme === "function") {
        nat.applyTheme(color, dark);
        return;
      }
    } catch (e) {}
    /* ② Capacitor StatusBar 插件（壳若将来安装则自动接管） */
    try {
      var sb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
      if (!sb) return;
      // 深色底固定使用浅色（白）系统图标。
      var wantStyle = "DARK";
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
    if (document.documentElement.getAttribute("data-zp-theme") !== "dark") {
      document.documentElement.setAttribute("data-zp-theme", "dark");
    }
    var color = COLORS.dark;
    var key = theme + "|" + color;
    if (key === lastKey) return;
    lastKey = key;
    syncMeta(color);
    syncNative(theme, color);
  }

  document.documentElement.setAttribute("data-zp-theme", "dark");
  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  try {
    new MutationObserver(apply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-zp-theme"]
    });
  } catch (e) {}
})();
