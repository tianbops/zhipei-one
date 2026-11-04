/* 智配One · 状态栏 / 主题色同步
 * ------------------------------------------------------------------
 * 背景：Android 壳的状态栏底色由宿主（原生层）控制，Web 侧有三条通道能影响它：
 *   1) window.ZhipeiNative.applyTheme(color, darkBg)：智配One 壳自带的自定义
 *      JS 接口（MainActivity.NativeChrome），直接设状态栏/导航栏底色与图标明暗，
 *      并把 WebView、DecorView 背景一起染色。这是 App 内的唯一有效通道。
 *   2) Capacitor StatusBar 插件（壳内已安装时）：可直接改原生状态栏底色。
 *   3) <meta name="theme-color">：PWA standalone、Chrome/Custom Tabs 用。
 *
 * 本文件在主题确定后同步这三条通道，并在用户切换深/浅主题时跟随变化
 * （监听 <html data-zp-theme> 属性变化）。
 *
 * 两套主题都同时设「图标明暗 + 底色」：
 *   深色 → 浅色图标（白）+ #161616 底
 *   浅色 → 深色图标（黑）+ #FFFFFF 底（对应设计稿里“浅底黑字”的系统状态栏）
 * 只设底色不设图标会出现「白图标压在浅底上」不可读，所以两者必须成对下发；
 * 调用顺序也固定为「先切图标明暗、再改底色」，避免中间态闪一下不可读。
 */
(function () {
  "use strict";
  /* 2026-11-04 外观改版：随 --zp-bg 同步换成 Uber 实测色（浅 #FFFFFF / 深 #161616）。
     这两个值必须与 css/ui-base.css 的 --zp-bg、css/ui-theme.css 的深色 --zp-bg 逐字一致，
     否则原生状态栏/导航栏会与页面底差一条色带（tests/appearance-theme-bootstrap E 组在册）。 */
  var COLORS = { dark: "#161616", light: "#FFFFFF" };

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
    /* edge-to-edge 能力协商 + 状态栏高度。壳提供 statusBarInset() 即代表 WebView 已铺满全屏、
       状态栏区域由页面绘制 —— 只有这样它才与页面同帧换色。

       为什么不用 env(safe-area-inset-top) 判断：Android WebView 的 env() 只反映刘海
       cutout，不含状态栏高度，普通机型返回 0；拿它当判据会把色带整个禁用掉。
       旧壳没有这个方法，落在旧分支（让位 + 8px），行为不变。 */
    if (nat0 && typeof nat0.statusBarInset === "function") {
      try {
        var topPx = nat0.statusBarInset();
        if (typeof topPx === "number" && topPx >= 0) {
          document.documentElement.setAttribute("data-zp-e2e", "1");
          /* 0 表示原生还没拿到 inset：此时不写变量，让 CSS 的 env() 兜底；
             原生拿到后会 evaluateJavascript 补写。 */
          if (topPx > 0) {
            document.documentElement.style.setProperty("--zp-e2e-top", topPx + "px");
          }
        }
      } catch (e2eErr) {}
    }
  } catch (e) {}

  function currentTheme() {
    var t = document.documentElement.getAttribute("data-zp-theme");
    if (t === "dark" || t === "light") return t;
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  /* theme-color 要同时维护多条，缺一条就会有场景取到错的色：
   *   - head 里静态写了三条：带 media 的浅/深两条 + 一条无条件兜底。
   *     给「解析期取一次、之后不再跟随 JS」的内核用——这类内核会把浅色值按自己的
   *     深色盘重映射成近黑，正是 Web 端「顶部一条黑带、与页面不同色」的成因。
   *   - JS 一旦确定主题，就把所有条目的 media 去掉、统一写成当前色；
   *     否则媒体查询会把用户手动选的深/浅盖回系统值。
   */
  function syncMeta(color) {
    var nodes = document.querySelectorAll('meta[name="theme-color"]');
    if (!nodes.length) {
      var created = document.createElement("meta");
      created.setAttribute("name", "theme-color");
      (document.head || document.documentElement).appendChild(created);
      nodes = [created];
    }
    for (var i = 0; i < nodes.length; i++) {
      var m = nodes[i];
      if (m.getAttribute("content") !== color) m.setAttribute("content", color);
      if (m.hasAttribute("media")) m.removeAttribute("media");
    }
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

  /* 去重：同步会由「脚本执行 / DOMContentLoaded / 主题属性变化 / 壳侧提前入口」
     多处触发，同一主题下重复下发只会白白多打几次原生 IPC（StatusBar 调用是跨桥的）。 */
  var lastKey = "";

  function push(theme, color) {
    var key = theme + "|" + color;
    /* meta 每次都同步：DOM 可能后补新的 theme-color（如登录页把 meta 放在脚本之后），
       只在颜色变化时同步会漏掉它们、留下带 media 的旧条目。同步本身是幂等的。 */
    syncMeta(color);
    if (key === lastKey) return;
    lastKey = key;
    syncNative(theme, color);
  }

  function apply() {
    var theme = currentTheme();
    push(theme, COLORS[theme] || COLORS.light);
  }

  /* 壳侧同步的提前入口：appearance.js 在改写 data-zp-theme **之前**调用它。
     原生换色要经 JavaBridge → runOnUiThread → 下一帧，天生比网页慢 1~3 帧；
     提前起跑让系统栏与网页尽量落在同一帧，压缩「网页已换色、状态栏还是旧色」的错配带。
     只接受已解析的 dark/light 与在册色值，非法入参直接忽略（宁可少发一次，
     也不把未知色送进原生染色通道）。 */
  window.zpShellThemeSync = function (theme, color) {
    if (theme !== "dark" && theme !== "light") return;
    var safe = color === COLORS.dark || color === COLORS.light ? color : COLORS[theme];
    push(theme, safe);
  };

  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  try {
    new MutationObserver(apply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-zp-theme"]
    });
  } catch (e) {}
})();
