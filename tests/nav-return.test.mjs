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
    ["/home.html", "", "/home.html", "首页即工作区根"],
    ["/pages/today.html?from=home", "", "/home.html", "首页→今日运单→首页"],
    ["/pages/history.html?from=home", "", "/home.html", "首页→历史记录→首页"],
    ["/pages/data.html?from=home", "", "/home.html", "首页→数据中心→首页"],
    ["/pages/account.html?from=home", "", "/home.html", "首页→账号设置→首页"],
    ["/pages/dispatch.html?from=home", "", "/home.html", "首页→当前线路→首页"],
    ["/pages/route_apply.html?from=home", "", "/home.html", "首页→绑定线路→首页"],
    ["/pages/order_detail.html?id=W1&source=process&from=process", "", "/home.html", "识别/规划完成→运单详情→首页"],
    ["/pages/order_detail.html?source=today&from=history&date=2026-10-02", "", "/pages/history.html", "历史→某日详情→回历史"],
    ["/pages/data.html?from=order&id=W9&source=process", "", "/pages/order_detail.html?id=W9&source=process&from=process", "详情→数据资料→必须回到原来那张运单"],
    ["/pages/data.html", "", "/home.html", "无来源→回落到工作区根"],
    ["/pages/order_detail.html?from=today", "", "/pages/today.html", "今日运单→详情→回今日运单"],
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
    ["/admin.html", "", "/admin.html", "管理员根本身就是工作区根"],
    ["/admin.html?from=home", "", "/admin.html", "来源=home 不得回落业务首页"],
    ["/admin.html?from=process", "", "/admin.html", "来源=process 不得回落业务首页"],
    ["/admin.html?from=order&id=W9", "", "/admin.html", "来源=order 不得跳进业务详情"],
    ["/admin.html?from=history", "", "/admin.html", "来源=history 不得跳进业务历史"],
    ["/admin.html?from=data", "", "/admin.html", "来源=data 不得跳进业务数据"],
    ["/admin.html", "/home.html", "/admin.html", "fallback 为业务首页→防火墙拦截"],
    ["/admin.html", "/pages/data.html", "/admin.html", "fallback 为业务页→防火墙拦截"],
    ["/admin.html?tab=1", "", "/admin.html", "四个面板是平级一级页，不构成历史层级"],
    ["/home.html?from=admin", "", "/home.html", "反向越权：业务端不得进入管理端"],
    ["/pages/data.html?from=admin", "", "/home.html", "反向越权：业务子页不得进入管理端"],
    ["/admin.html?from=admin", "", "/admin.html", "自我返回→兜底到本区根，防死循环"],
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

console.log("\n三、返回层级 ladder（7 条）");
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

console.log("\n" + "-".repeat(56));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log("\n失败用例：");
  failures.forEach((f) => console.log("  · " + f));
  process.exit(1);
}
