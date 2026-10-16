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
 * 实现方式：直接截取 js/ui-unified.js 中的真实源码片段求值（不是复制副本），
 * 注入假的 window/document/getComputedStyle/location，因此修改源文件后
 * 本测试自动跟随，不会出现"测试通过但线上不是这个行为"的情况。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui-unified.js", import.meta.url)), "utf8");

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
const RESOLVE_BODY = slice("const BACK_MAP=", "window.zpGoBack=");
const LADDER_BODY = slice("function zpIsVisible(", "window.zpHandleBack=");

/** 用给定的 URL（可含 ?from= ）求解析结果 */
function resolve(url, fallback) {
  const u = new URL(url, "https://x.invalid");
  const factory = new Function("window", "document", "location", RESOLVE_BODY + "\nreturn window.zpResolveBack;");
  const win = {}, doc = { body: { dataset: {} } }, loc = { pathname: u.pathname, search: u.search };
  return factory(win, doc, loc)(fallback);
}

console.log("一、来源驱动返回（业务端 12 条）");
{
  const cases = [
    ["/home", "", "/home", "首页即工作区根"],
    ["/pages/today?from=home", "", "/home", "首页→今日运单→首页"],
    ["/pages/history?from=home", "", "/home", "首页→历史记录→首页"],
    ["/pages/data?from=home", "", "/home", "首页→数据中心→首页"],
    ["/pages/account?from=home", "", "/home", "首页→账号设置→首页"],
    ["/pages/dispatch?from=home", "", "/home", "首页→当前线路→首页"],
    ["/pages/route_apply?from=home", "", "/home", "首页→绑定线路→首页"],
    ["/pages/order_detail?id=W1&source=process&from=process", "", "/home", "识别/规划完成→运单详情→首页"],
    // 口径：from=history 且带 date= 时必须带 date 回跳——保留「是哪一天」的上下文
    // 优于回到列表首屏（1e511840 引入 date 携带后，本条断言同步为带 date 形态）
    ["/pages/order_detail?source=today&from=history&date=2026-10-02", "", "/pages/history?date=2026-10-02", "历史→某日详情→回历史（保留日期）"],
    ["/pages/data?from=order&id=W9&source=process", "", "/pages/order_detail?id=W9&source=process&from=process", "详情→数据资料→必须回到原来那张运单"],
    ["/pages/data", "", "/home", "无来源→回落到工作区根"],
    ["/pages/order_detail?from=today", "", "/pages/today", "今日运单→详情→回今日运单"],
    // 线路页是一级页，其四个出口返回必须回到线路页（此前缺 dispatch 键，全部掉首页）
    ["/pages/data?from=dispatch", "", "/pages/dispatch", "线路页→数据资料→回线路页"],
    ["/pages/route_apply?from=dispatch", "", "/pages/dispatch", "线路页→线路申请→回线路页"],
    ["/pages/account?from=dispatch", "", "/pages/dispatch", "线路页→我的→回线路页"],
    // 历史链接/旧缓存页里的「路径碎片」写法，归一化后命中映射；未收录的一律回落首页
    ["/pages/account?from=pages%2Fdispatch", "", "/pages/dispatch", "路径碎片归一化命中 dispatch"],
    ["/pages/account?from=pages%2Forder_detail", "", "/home", "未收录的路径碎片→回落首页"],
    ["/pages/account?from=home", "", "/home", "底栏跳转来源=home→回首页"],
    ["/pages/data?from=constructor", "", "/home", "原型键不得误命中映射"],
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
    querySelector: (sel) => (sel === "#zpUiLayer .zp-confirm" ? env.document.confirmEl : null),
  };
  const getComputedStyle = () => ({ display: "flex", visibility: "visible", opacity: "1" });
  env.engine = new Function("window", "document", "getComputedStyle",
    LADDER_BODY + "\nreturn {close:zpCloseTopLayer};")(env.window, env.document, getComputedStyle);
  return env;
}
const fakeEl = (over) => Object.assign({
  hidden: false, style: {}, closest: () => null,
  getBoundingClientRect: () => ({ width: 200, height: 200 }),
  classList: { contains: () => false },
}, over || {});

console.log("\n三、失效上下文 zpMarkStale（3 条）");
{
  /** 先置「已失效」标记再解析：删除类操作后不得再回跳到已删除的对象 */
  function resolveStale(url, fallback) {
    const u = new URL(url, "https://x.invalid");
    const factory = new Function("window", "document", "location",
      RESOLVE_BODY + "\nwindow.zpMarkStale();return window.zpResolveBack;");
    return factory({}, { body: { dataset: {} } }, { pathname: u.pathname, search: u.search })(fallback);
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
const HOME_SRC = readFileSync(fileURLToPath(new URL("../js/home.js", import.meta.url)), "utf8");
const HISTORY_SRC = readFileSync(fileURLToPath(new URL("../js/history.js", import.meta.url)), "utf8");
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
  const overlayHook = /rank\s*:\s*5\s*,\s*probe\s*:\s*\(\)\s*=>\s*overlay/.test(HISTORY_SRC);
  t("历史页：日历选择器注册返回钩子", picker);
  t("历史页：删除确认框注册返回钩子", dialog);
  t("历史页：左滑展开行最后关闭", swipe);
  t("历史页：回收站等浮层优先关闭", overlayHook);
  console.log((picker && dialog && swipe && overlayHook ? "✅ " : "❌ ") + "历史页：日历/确认框/左滑/功能浮层返回层级已覆盖");
}

console.log("\n" + "-".repeat(56));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log("\n失败用例：");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
