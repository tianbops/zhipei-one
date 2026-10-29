/**
 * 全局 Android App 返回机制回归测试
 * ------------------------------------------------------------------
 * 运行：node tests/nav-return.test.mjs
 *
 * 覆盖（对应《智配One 全局返回机制重构》返回矩阵）：
 *   一、来源驱动返回：业务端 12 条 —— 从哪里进，就回到哪里
 *   二、跨区防火墙：管理员端 12 条 —— 独立工作区，永不串到业务端
 *   三、返回层级 ladder 7 条 —— 弹窗优先、未保存拦截、拒绝关闭不穿透
 *
 * 实现方式：直接截取 js/ui/back.js 中的真实源码片段求值（不是复制副本），
 * 注入假的 window/document/getComputedStyle/location，因此修改源文件后
 * 本测试自动跟随，不会出现"测试通过但线上不是这个行为"的情况。
 *
 * 2026-10-22：ui-unified.js 拆分为 js/ui/ 六个模块后，返回控制器落在 js/ui/back.js，
 * 它依赖的 normPath/detectZone/normFrom 由 js/ui/core.js 提供 —— 本测试先真实求值
 * core.js 得到 window.__zpUi，再把「const UI=window.__zpUi」拼到切片前面，
 * 保证被测的仍是线上那份代码，而不是被测试改写的副本。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");
const CORE_SRC = readFileSync(fileURLToPath(new URL("../js/ui/core.js", import.meta.url)), "utf8");

/** 在假环境里真实执行 core.js，得到 window.__zpUi（与浏览器里完全同一份源码） */
function installCore(win, doc, loc) {
  new Function("window", "document", "location", CORE_SRC)(win, doc, loc);
}

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ---------- 切片一：BACK_MAP → 跨区防火墙 → zpResolveBack ---------- */
function slice(from, to) {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i < 0 || j < 0 || j <= i) throw new Error("源码切片失败：" + from);
  return SRC.slice(i, j);
}
const RESOLVE_BODY = slice("const zpZone=UI.detectZone();", "window.zpGoBack=");
const LADDER_BODY = slice("function zpIsVisible(", "window.zpHandleBack=");

/** 用给定的 URL（可含 ?from= ）求解析结果 */
function resolve(url, fallback) {
  const u = new URL(url, "https://x.invalid");
  const win = {}, doc = { body: { dataset: {} } }, loc = { pathname: u.pathname, search: u.search };
  installCore(win, doc, loc);
  const factory = new Function("window", "document", "location",
    "const UI=window.__zpUi;" + RESOLVE_BODY + "\nreturn window.zpResolveBack;");
  return factory(win, doc, loc)(fallback);
}

console.log("一、收口首页（业务端 19 条）");
{
  // 2026-10-30 模型变更（ZP-NAV-2026-002 修订 F）：不再按 from= 回跳来源页。
  // 业务区任何页面返回都收口到 /home，来源、日期、运单 id 一律不参与解析。
  const cases = [
    ["/home", "", "/home", "首页即工作区根"],
    ["/pages/today?from=home", "", "/home", "今日运单→首页"],
    ["/pages/history?from=home", "", "/home", "历史→首页"],
    ["/pages/data?from=home", "", "/home", "数据中心→首页"],
    ["/pages/account?from=home", "", "/home", "账号设置→首页"],
    ["/pages/dispatch?from=home", "", "/home", "线路→首页"],
    ["/pages/route_apply?from=home", "", "/home", "绑定线路→首页"],
    ["/pages/order_detail?id=W1&source=process&from=process", "", "/home", "运单详情→首页"],
    // 关键行为变更：过去带 date 回历史，现在一律回首页（方案明确接受该体验代价）
    ["/pages/order_detail?source=today&from=history&date=2026-10-02", "", "/home", "历史→详情→首页（不再回历史）"],
    ["/pages/history?from=home&date=2026-10-02", "", "/home", "历史带日期→首页"],
    // 子页面之间不互通：详情→数据资料不再回到「原来那张运单」
    ["/pages/data?from=order&id=W9&source=process", "", "/home", "详情→数据资料→首页（不回原运单）"],
    ["/pages/data", "", "/home", "无来源→首页"],
    ["/pages/order_detail?from=today", "", "/home", "今日运单→详情→首页"],
    ["/pages/data?from=dispatch", "", "/home", "线路→数据资料→首页"],
    ["/pages/route_apply?from=dispatch", "", "/home", "线路→线路申请→首页"],
    ["/pages/account?from=dispatch", "", "/home", "线路→我的→首页"],
    ["/pages/account?from=pages%2Fdispatch", "", "/home", "路径碎片来源不影响收口"],
    ["/pages/account?from=constructor", "", "/home", "原型键来源不影响收口"],
    ["/pages/order_detail?from=admin", "", "/home", "业务页带 from=admin 仍回首页，不进管理端"],
  ];
  for (const [url, fb, want, name] of cases) {
    const got = resolve(url, fb);
    console.log((got === want ? "✅ " : "❌ ") + name.padEnd(30, " ") + "→ " + got);
    t(name, got === want, "得到 " + got + "，期望 " + want);
  }
}

console.log("\n二、跨区防火墙（管理员端 12 条）");
{
  const cases = [
    ["/admin", "", "/admin", "管理员根本身就是工作区根"],
    ["/admin?from=home", "", "/admin", "来源=home 不得回落业务首页"],
    ["/admin?from=process", "", "/admin", "来源=process 不得回落业务首页"],
    ["/admin?from=order&id=W9", "", "/admin", "来源=order 不得跳进业务详情"],
    ["/admin?from=history", "", "/admin", "来源=history 不得跳进业务历史"],
    ["/admin?from=data", "", "/admin", "来源=data 不得跳进业务数据"],
    ["/admin", "/home", "/admin", "fallback 为业务首页→防火墙拦截"],
    ["/admin", "/pages/data", "/admin", "fallback 为业务页→防火墙拦截"],
    ["/admin?tab=1", "", "/admin", "四个面板是平级一级页，不构成历史层级"],
    ["/home?from=admin", "", "/home", "反向越权：业务端不得进入管理端"],
    ["/pages/data?from=admin", "", "/home", "反向越权：业务子页不得进入管理端"],
    ["/admin?from=admin", "", "/admin", "自我返回→兜底到本区根，防死循环"],
  ];
  for (const [url, fb, want, name] of cases) {
    const got = resolve(url, fb);
    console.log((got === want ? "✅ " : "❌ ") + name.padEnd(30, " ") + "→ " + got);
    t(name, got === want, "得到 " + got + "，期望 " + want);
  }
}

/* ---------- 切片二：返回层级 ladder ---------- */
function makeEnv() {
  const env = { confirms: [], confirmAnswer: true };
  env.window = {
    zpBackHooks: [], zpDirtyProbes: [],
    zpConfirm: async (title) => { env.confirms.push(title); return env.confirmAnswer; },
    zpToast: () => {},
  };
  env.document = {
    body: { style: {} },
    confirmEl: null,
    activeElement: null,
    listeners: {},
    querySelector: (sel) => (sel === "#zpUiLayer .zp-confirm" ? env.document.confirmEl : null),
    // back.js 注册了 ESC/Tab 分发器（document 级 keydown 监听），假 DOM 必须能接住，
    // 否则加载即抛 "addEventListener is not a function"（真实浏览器恒有）。
    addEventListener(type, fn) {
      (env.document.listeners[type] = env.document.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = env.document.listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
  };
  const getComputedStyle = () => ({ display: "flex", visibility: "visible", opacity: "1" });
  installCore(env.window, env.document, { pathname: "/", search: "" });
  env.engine = new Function("window", "document", "getComputedStyle",
    "const UI=window.__zpUi;const sharedState=UI.state||{};" + LADDER_BODY +
    "\nreturn {close:zpCloseTopLayer, top:zpTopHook};")(env.window, env.document, getComputedStyle);
  /* 模拟一次 keydown 分发，返回是否调用了 preventDefault */
  env.fire = async (key, opts = {}) => {
    const handler = (env.document.listeners.keydown || [])[0];
    if (!handler) return false;
    let prevented = false;
    const ev = {
      key,
      defaultPrevented: !!opts.defaultPrevented,
      shiftKey: !!opts.shiftKey,
      preventDefault() { prevented = true; ev.defaultPrevented = true; },
    };
    await handler(ev);
    return prevented;
  };
  return env;
}
/** 可聚焦假元素：够 core.js 的 UI.focusables 判定使用 */
const focusableEl = (over) => Object.assign({
  disabled: false, focused: false,
  getAttribute: () => null,
  closest: () => null,
  offsetParent: {},
  getClientRects: () => [0],
  focus() { this.focused = true; },
}, over || {});
const fakeEl = (over) => Object.assign({
  hidden: false, style: {}, closest: () => null,
  getBoundingClientRect: () => ({ width: 200, height: 200 }),
  classList: { contains: () => false },
}, over || {});

console.log("\n三、上下文清洗 zpMarkStale（3 条）");
{
  /** 删除类操作后调用 zpMarkStale，再解析：目标仍必须是本区根 */
  function resolveStale(url, fallback) {
    const u = new URL(url, "https://x.invalid");
    const win = {}, doc = { body: { dataset: {} } }, loc = { pathname: u.pathname, search: u.search };
    installCore(win, doc, loc);
    const factory = new Function("window", "document", "location",
      "const UI=window.__zpUi;" + RESOLVE_BODY + "\nwindow.zpMarkStale();return window.zpResolveBack;");
    return factory(win, doc, loc)(fallback);
  }
  const cases = [
    ["/pages/order_detail?id=W1&source=today&from=history&date=2026-10-02", "", "/home",
      "删空运单后返回→回首页，不回已删运单/已删日期"],
    ["/pages/history?from=home&date=2026-10-02", "", "/home", "历史页失效后→回本区根"],
    ["/admin?from=home", "", "/admin", "管理员端失效后仍回本区根（防火墙优先）"],
  ];
  for (const [url, fb, want, name] of cases) {
    const got = resolveStale(url, fb);
    console.log((got === want ? "✅ " : "❌ ") + name.padEnd(30, " ") + "→ " + got);
    t(name, got === want, "得到 " + got + "，期望 " + want);
  }
}

console.log("\n四、返回层级 ladder（7 条）");
await (async () => {
  // ① 多个弹层同时存在，一次返回只关最上面那一层
  {
    const env = makeEnv(); let cp = false, cd = false;
    const picker = fakeEl(), dialog = fakeEl();
    env.window.zpBackHooks.push(
      { rank: 10, probe: () => picker, close: () => { picker.hidden = true; cp = true; return true; } },
      { rank: 10, probe: () => dialog, close: () => { dialog.hidden = true; cd = true; return true; } });
    await env.engine.close();
    t("历史：选择器开着→只关选择器，不误关下层弹窗", cp && !cd, "picker=" + cp + " dialog=" + cd);
    console.log((cp && !cd ? "✅ " : "❌ ") + "历史：一次返回只关闭最上层弹层");
  }
  // ② 单一弹层
  {
    const env = makeEnv(); let cd = false; const dialog = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => dialog, close: () => { dialog.hidden = true; cd = true; return true; } });
    await env.engine.close();
    t("历史：删除确认弹窗→关闭弹窗", cd);
    console.log((cd ? "✅ " : "❌ ") + "历史：删除确认弹窗被返回关闭");
  }
  // ③ 未保存修改 + 取消 → 不关闭、不穿透
  {
    const env = makeEnv(); env.confirmAnswer = false;
    let closed = false; const panel = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => panel, dirty: () => true, close: () => { closed = true; return true; } });
    const consumed = await env.engine.close();
    t("数据页：有未保存修改且选择取消→不关闭不穿透", env.confirms.length === 1 && !closed && consumed === true,
      "confirm=" + env.confirms.length + " closed=" + closed);
    console.log((env.confirms.length === 1 && !closed ? "✅ " : "❌ ") + "数据页：取消放弃时不关闭、不穿透");
  }
  // ④ 未保存修改 + 放弃 → 关闭
  {
    const env = makeEnv(); let closed = false; const panel = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => panel, dirty: () => true, close: () => { closed = true; return true; } });
    await env.engine.close();
    t("数据页：确认放弃→关闭面板", closed && env.confirms.length === 1);
    console.log((closed ? "✅ " : "❌ ") + "数据页：确认放弃后正常关闭");
  }
  // ⑤ 通用确认框 rank5 必须压过页面 rank10 弹层
  {
    const env = makeEnv(); const confirm = fakeEl(); env.document.confirmEl = confirm;
    let closedPanel = false; const panel = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => panel, dirty: () => true, close: () => { closedPanel = true; return true; } });
    await env.engine.close();
    t("层级：通用确认框 rank5 优先于页面 rank10 弹层", confirm.hidden === true && !closedPanel);
    console.log((confirm.hidden && !closedPanel ? "✅ " : "❌ ") + "层级：通用确认框最先响应返回（防二次弹窗）");
  }
  // ⑥ close 返回 false（业务上拒绝关闭，如上传进行中）→ 仍须吞掉本次返回
  {
    const env = makeEnv(); let hit = false; const sheet = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => sheet, close: () => { hit = true; return false; } });
    const consumed = await env.engine.close();
    t("首页：上传进行中→返回被吸收，不穿透到退出应用", consumed === true && hit);
    console.log((consumed && hit ? "✅ " : "❌ ") + "首页：上传进行中返回不穿透到「退出」");
  }
  // ⑦ 没有可见层 → 交给页面级导航/工作区根
  {
    const env = makeEnv();
    env.window.zpBackHooks.push(
      { rank: 10, probe: () => null, close: () => true },
      { rank: 20, probe: () => Object.assign(fakeEl(), { hidden: true }), close: () => true });
    const consumed = await env.engine.close();
    t("层级：无可见层→交给页面级导航", consumed === false);
    console.log((consumed === false ? "✅ " : "❌ ") + "层级：无可见层时放行到页面导航");
  }
})();


/* ---------- 切片二之二：ESC 关闭 + Tab 焦点陷阱（P3 对话框焦点陷阱）---------- */
console.log("\n五、ESC 关闭与 Tab 焦点陷阱（6 条）");
await (async () => {
  // ① ESC 只关最上层弹层
  {
    const env = makeEnv(); let cp = false, cd = false;
    const picker = fakeEl(), dialog = fakeEl();
    env.window.zpBackHooks.push(
      { rank: 10, probe: () => picker, close: () => { picker.hidden = true; cp = true; return true; } },
      { rank: 10, probe: () => dialog, close: () => { dialog.hidden = true; cd = true; return true; } });
    const prevented = await env.fire("Escape");
    t("ESC：只关最上层弹层，不误关下层", cp && !cd && prevented, "picker=" + cp + " dialog=" + cd);
    console.log((cp && !cd ? "✅ " : "❌ ") + "ESC：一次只关闭最上层弹层");
  }
  // ② 当前无弹层 → ESC 不越界退出（与系统返回键「越界退出」刻意区分）
  {
    const env = makeEnv();
    env.window.zpBackHooks.push({ rank: 10, probe: () => null, close: () => true });
    const prevented = await env.fire("Escape");
    t("ESC：无弹层时不越界退出", prevented === false);
    console.log((prevented === false ? "✅ " : "❌ ") + "ESC：没有弹层时不退出应用、不导航");
  }
  // ③ 确认框（rank5）叠在页面浮层（rank6）之上 → ESC 先关确认框
  {
    const env = makeEnv(); const confirm = fakeEl(); env.document.confirmEl = confirm;
    let panelClosed = false; const panel = fakeEl();
    env.window.zpBackHooks.push({ rank: 6, probe: () => panel, close: () => { panelClosed = true; return true; } });
    env.window.__zpUi.state.confirmDismisser = () => { confirm.hidden = true; };
    await env.fire("Escape");
    t("ESC：确认框优先于下层浮层", confirm.hidden === true && !panelClosed,
      "confirm.hidden=" + confirm.hidden + " panel=" + panelClosed);
    console.log((confirm.hidden && !panelClosed ? "✅ " : "❌ ") + "ESC：确认框在最上层时先关确认框");
  }
  // ④ 上层组件已自行处理（defaultPrevented）→ 不再重复关闭下层
  {
    const env = makeEnv(); let closed = false; const sheet = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => sheet, close: () => { closed = true; return true; } });
    await env.fire("Escape", { defaultPrevented: true });
    t("ESC：上层已处理时不重复关闭", closed === false);
    console.log((closed === false ? "✅ " : "❌ ") + "ESC：上层组件已处理时不再叠加关闭");
  }
  // ⑤ Tab：焦点锁在最上层弹层内（末项 → 首项）
  {
    const env = makeEnv();
    const a = focusableEl(), b = focusableEl();
    const container = { querySelectorAll: () => [a, b], contains: (n) => n === a || n === b };
    const sheet = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => sheet, trap: () => container, close: () => true });
    env.document.activeElement = b;
    const prevented = await env.fire("Tab");
    t("Tab：焦点在最上层弹层内循环", a.focused === true && prevented === true);
    console.log((a.focused ? "✅ " : "❌ ") + "Tab：焦点在弹层内首尾循环");
  }
  // ⑥ Tab：焦点逸出层外时拉回层内
  {
    const env = makeEnv();
    const a = focusableEl(), b = focusableEl();
    const container = { querySelectorAll: () => [a, b], contains: (n) => n === a || n === b };
    const sheet = fakeEl();
    env.window.zpBackHooks.push({ rank: 10, probe: () => sheet, trap: () => container, close: () => true });
    env.document.activeElement = null;
    await env.fire("Tab");
    t("Tab：焦点逸出层外时拉回层内", a.focused === true);
    console.log((a.focused ? "✅ " : "❌ ") + "Tab：焦点逸出弹层时拉回弹层内");
  }
})();


/* ---------- 切片三：线路页原始弹层返回钩子 ---------- */
const DISPATCH_SRC = readFileSync(fileURLToPath(new URL("../pages/dispatch.html", import.meta.url)), "utf8");
{
  const hookStart = DISPATCH_SRC.indexOf("// 手机端系统返回：先关闭最上层确认，再关闭线路选择层");
  const hookEnd = DISPATCH_SRC.indexOf("async function load()", hookStart);
  const hooks = hookStart >= 0 && hookEnd > hookStart ? DISPATCH_SRC.slice(hookStart, hookEnd) : "";
  const confirmProbe = /rank\s*:\s*10\s*,\s*probe\s*:\s*\(\)\s*=>\s*\$\("confirmBackdrop"\).*?close\s*:\s*\(\)\s*=>\s*\{\s*closeConfirm\(\)/s.test(hooks);
  const sheetProbe = /rank\s*:\s*20\s*,\s*probe\s*:\s*\(\)\s*=>\s*\$\("routeSheetBackdrop"\).*?close\s*:\s*\(\)\s*=>\s*\{\s*closeSheet\(\)/s.test(hooks);
  const order = hooks.indexOf('$("confirmBackdrop")') >= 0 &&
    hooks.indexOf('$("routeSheetBackdrop")') > hooks.indexOf('$("confirmBackdrop")');
  t("线路页：真实源码注册确认框返回钩子", confirmProbe);
  t("线路页：真实源码注册线路选择层返回钩子", sheetProbe);
  t("线路页：确认框优先于线路选择层", order);
  console.log((confirmProbe ? "✅ " : "❌ ") + "线路页：确认框钩子存在且关闭确认框");
  console.log((sheetProbe ? "✅ " : "❌ ") + "线路页：线路选择层钩子存在且关闭选择层");
  console.log((order ? "✅ " : "❌ ") + "线路页：返回优先级为确认框→选择层");
}


/* ---------- 切片四：首页上传与历史页返回层级 ---------- */
const HOME_SRC = readFileSync(fileURLToPath(new URL("../js/home/back.js", import.meta.url)), "utf8");
// history.js 已拆分为 js/history/ 四模块（core→render→data→overlay），按加载顺序拼接后切片断言
const HIST_DIR = new URL("../js/history/", import.meta.url);
const HISTORY_SRC = ["core.js", "render.js", "data.js", "overlay.js"]
  .map((f) => readFileSync(fileURLToPath(new URL(f, HIST_DIR)), "utf8")).join("\n");
{
  const homeStart = HOME_SRC.indexOf("// 这里只注册本页返回层级：上传 Bottom Sheet");
  const homeEnd = HOME_SRC.indexOf(");", homeStart);
  const homeHooks = homeStart >= 0 && homeEnd > homeStart ? HOME_SRC.slice(homeStart, homeEnd + 2) : "";
  const uploadHook = /rank\s*:\s*10\s*,\s*probe\s*:\s*\(\)\s*=>\s*\$\("uploadArea"\)/s.test(homeHooks);
  const uploadGuard = /processingFile[\s\S]*?return false[\s\S]*?closeUpload\(\)/.test(homeHooks);
  t("首页：上传面板注册系统返回钩子", uploadHook);
  t("首页：处理中阻止返回穿透并关闭面板", uploadHook && uploadGuard);
  console.log((uploadHook ? "✅ " : "❌ ") + "首页：上传面板返回钩子已注册");
  console.log((uploadHook && uploadGuard ? "✅ " : "❌ ") + "首页：处理中拦截返回，空闲时关闭面板");

  const historyHookStart = HISTORY_SRC.indexOf("/* 返回层级：删除确认弹窗");
  const historyHookEnd = HISTORY_SRC.indexOf("/* ===== 回收站", historyHookStart);
  const historyHooks = historyHookStart >= 0 && historyHookEnd > historyHookStart
    ? HISTORY_SRC.slice(historyHookStart, historyHookEnd) : "";
  const picker = /rank\s*:\s*10\s*,\s*probe\s*:\s*\(\)\s*=>\s*picker/.test(historyHooks);
  const dialog = /rank\s*:\s*10\s*,\s*probe\s*:\s*\(\)\s*=>\s*dialog/.test(historyHooks);
  const swipe = /rank\s*:\s*40\s*,\s*probe\s*:\s*\(\)\s*=>\s*document\.querySelector\("\.history-swipe-row\.swiped"\)/.test(historyHooks);
  // 浮层优先级用「意图」表达，不绑死魔法数字：
  //   rank 越大越晚关闭。它必须早于页面级弹层（rank 10 的选择器/确认框）关闭，
  //   但必须晚于通用确认框（rank 5）——两者同级时按注册顺序浮层会抢先，
  //   导致「彻底删除」确认框叠在浮层上时返回键关掉的是浮层、确认框留在屏上。
  const overlayRankMatch = /rank\s*:\s*(\d+)\s*,\s*probe\s*:\s*\(\)\s*=>\s*overlay/.exec(HISTORY_SRC);
  const overlayRank = overlayRankMatch ? Number(overlayRankMatch[1]) : null;
  const overlayHook = overlayRank !== null && overlayRank > 5 && overlayRank < 10;
  t("历史页：日历选择器注册返回钩子", picker);
  t("历史页：删除确认框注册返回钩子", dialog);
  t("历史页：左滑展开行最后关闭", swipe);
  t("历史页：回收站等浮层优先关闭", overlayHook);
  console.log((picker && dialog && swipe && overlayHook ? "✅ " : "❌ ") + "历史页：日历/确认框/左滑/功能浮层返回层级已覆盖");
}

/* ---------- 切片五：退出协调（zpDoExit 单路径：PWA / 浏览器）----------
 * 背景：原生安卓壳项目已下线，退出不再区分双路径——统一走 history.back()+window.close()
 * 由系统退出 PWA（浏览器里退回上一站）。保留回归覆盖防止「退不出」。 */
const DOEXIT_SRC = slice("function zpDoExit(){", "  // 顶部返回按钮专用出口");

/** 在受控环境里真实执行 zpDoExit（zpLeaving 由外层 let 提供，其余依赖全部注入桩） */
function runDoExit(opts = {}) {
  const rec = { histBack: false, sessionSet: null, closed: false };
  const win = {
    matchMedia: (q) => ({ matches: !!opts.standalone && String(q).includes("display-mode") }),
    navigator: { standalone: false },
    close: () => { rec.closed = true; },
  };
  const sessionStorage = { setItem: (_k, v) => { rec.sessionSet = v; } };
  const history = { back: () => { rec.histBack = true; } };
  const factory = new Function("window", "sessionStorage", "history", "location",
    "let zpLeaving=false;" + DOEXIT_SRC + "\nreturn zpDoExit;");
  factory(win, sessionStorage, history, {})();
  return rec;
}

console.log("\n五、退出协调（zpDoExit）");
{
  const pwa = runDoExit({ standalone: true });
  t("独立 PWA：history.back()+window.close()，并置跨区退出标记",
    pwa.histBack === true && pwa.sessionSet === "1" && pwa.closed === true,
    JSON.stringify(pwa));
  console.log((pwa.histBack && pwa.closed ? "✅ " : "❌ ") + "独立 PWA：越过首条记录 + window.close()");

  const plain = runDoExit({});
  t("普通浏览器：非 standalone 只 history.back()，不 window.close()",
    plain.histBack === true && plain.closed === false,
    JSON.stringify(plain));
  console.log((plain.histBack && !plain.closed ? "✅ " : "❌ ") + "普通浏览器：回退不断会话");
}

console.log("\n" + "-".repeat(56));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log("\n失败用例：");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
