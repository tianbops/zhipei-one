/**
 * 按钮触感（tests/haptic.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30，v1.0.20）：给底部导航补「按下去有物理确认」的触感。
 *
 * 这一块最容易静默失效——震没震，用户不一定会反馈，日志里也没有痕迹：
 *   1. 网页里的 navigator.vibrate 在 Capacitor WebView 里不通，只有原生桥
 *      ZhipeiNative.haptic() 真能震（壳侧实现见 MainActivity.hapticFeed：performHapticFeedback，
 *      不申请 VIBRATE 权限、遵守系统「触摸振动」总开关）；
 *   2. 桥名/签名对不上时，网页不会报错，只会「点了没感觉」——和剪贴板那类静默降级同源，
 *      所以方法名、四档语义、通道优先级都要钉在测试里；
 *   3. 连点底栏不能被震成「嗞嗞嗞」，节流必须可测而非靠手感。
 *
 * 断言分两层：源码红线（结构不能被改回去）+ vm 行为求值（真的调了该调的东西）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const SRC = read("js/ui/haptic.js");

/* ===== 一、源码红线 ===== */
t("haptic.js 存在且挂到 window.zpHaptic", /window\.zpHaptic\s*=\s*zpHaptic/.test(SRC));
t("四档语义齐全（light/medium/success/warn）",
  /KINDS\s*=\s*\{\s*light\s*:\s*1\s*,\s*medium\s*:\s*1\s*,\s*success\s*:\s*1\s*,\s*warn\s*:\s*1\s*\}/.test(SRC));
t("原生通道探测 ZhipeiNative.haptic", /window\.ZhipeiNative/.test(SRC) && /\.haptic\b/.test(SRC));
t("浏览器兜底走 navigator.vibrate", /navigator\.vibrate/.test(SRC));
t("click 监听绑在 capture 阶段（业务 stopPropagation 吞不掉）",
  /document\.addEventListener\(\s*"click"[\s\S]{0,400}?\}\s*,\s*true\s*\)/.test(SRC));

/* 选择器必须同时覆盖 <a> 和 <button>。
 * 2026-10-30 线上回归：第一版只写 `.zp-nav a`，而首页中央加号是
 * <button id="uploadAction">、管理端整条底栏都是 <button class="nav-item">——
 * 表现为「在别的页点加号有触感，跳到首页后同一个加号再点就没感觉」。
 * 只写 a 的版本不会报错，只会让一半底栏静默失效。 */
const SEL = (SRC.match(/const SEL="([^"]+)"/) || [, ""])[1];
t("选择器含 .zp-nav a", SEL.includes(".zp-nav a"), SEL);
t("选择器含 .zp-nav button（首页加号）", SEL.includes(".zp-nav button"), SEL);
t("选择器含 .admin-nav a", SEL.includes(".admin-nav a"), SEL);
t("选择器含 .admin-nav button（管理端底栏）", SEL.includes(".admin-nav button"), SEL);
t("选择器含 [data-zp-haptic] 扩展钩子", SEL.includes("[data-zp-haptic]"), SEL);

/* 结构一致性：拿真实页面里的底栏项标签去对选择器。
 * 以后谁把底栏项换成别的标签（如 <div role="tab">），这里会立刻红——
 * 光靠夹具页测不出这种漂移，因为夹具是手写的（上一版就是这么漏的）。 */
const NAV_PAGES = ["home.html", "admin.html"]
  .concat(readdirSync(join(ROOT, "pages")).filter((f) => f.endsWith(".html")).map((f) => "pages/" + f));
let navScanned = 0;
for (const p of NAV_PAGES) {
  const s = read(p);
  if (/<a[^>]*class="zp-nav-item/.test(s)) {
    navScanned++;
    t(`${p}：底栏 <a> 被选择器覆盖`, SEL.includes(".zp-nav a"));
  }
  if (/<button[^>]*class="zp-nav-item/.test(s)) {
    navScanned++;
    t(`${p}：底栏 <button>（加号）被选择器覆盖`, SEL.includes(".zp-nav button"));
  }
  if (/<button[^>]*class="nav-item/.test(s)) {
    navScanned++;
    t(`${p}：管理端 <button> 被选择器覆盖`, SEL.includes(".admin-nav button"));
  }
}
t("至少扫到 6 个页面的底栏项（防止页面改名/结构漂移后测试空跑）", navScanned >= 6, "命中 " + navScanned);
t("nav.js 注入的底栏项是 <a>，已被选择器覆盖",
  read("js/ui/nav.js").includes("'<a class=\"'+cls+'\"") && SEL.includes(".zp-nav a"));

/* ===== 二、vm 行为求值 =====
 * 造一个最小运行环境：只有 document.addEventListener 与可拨动的 performance.now，
 * haptic.js 不需要真实 DOM，交互通过手工构造 click 事件对象驱动。 */
function load({ bridge = null, vibrate = null, vibrateThrows = false } = {}) {
  const calls = { bridge: [], vibrate: [] };
  const listeners = [];
  let clock = 1000;

  const document = {
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
  };
  const win = {
    navigator: vibrate
      ? { vibrate(v) { calls.vibrate.push(v); if (vibrateThrows) throw new Error("no gesture"); return true; } }
      : {},
  };
  if (bridge) {
    win.ZhipeiNative = {
      haptic(kind) { calls.bridge.push(kind); if (bridge === "throw") throw new Error("bridge boom"); },
    };
  }

  const sandbox = {
    window: win,
    document,
    performance: { now: () => clock },
    Date,
    console,
  };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);
  runInContext(SRC, ctx, { filename: "js/ui/haptic.js" });

  /** 模拟一次点击：给一个只实现 closest 的目标，closest 命中则返回带属性的元素壳。 */
  function click(match, attrs = {}) {
    const listener = listeners.find((l) => l.type === "click");
    const element = match
      ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) }
      : null;
    listener.fn({
      target: element ? { closest: () => element } : { closest: () => null },
    });
  }
  return { win, calls, listeners, click, tick: (ms) => { clock += ms; } };
}

/* --- 2.1 壳内：有桥就走桥，不碰 navigator.vibrate --- */
{
  const env = load({ bridge: "ok", vibrate: true });
  env.click(true, {});
  t("壳内点击底栏 → 调 ZhipeiNative.haptic('light')", env.calls.bridge.length === 1 && env.calls.bridge[0] === "light",
    JSON.stringify(env.calls.bridge));
  t("壳内不再叠一层 navigator.vibrate（避免双重震动）", env.calls.vibrate.length === 0);
  t("window.zpHaptic 可直接调用", typeof env.win.zpHaptic === "function");
}

/* --- 2.2 浏览器：无桥时走 vibrate，参数按语义分档 --- */
{
  const env = load({ vibrate: true });
  env.click(true, {});
  t("无桥 → navigator.vibrate(10)（light）", env.calls.vibrate[0] === 10, JSON.stringify(env.calls.vibrate));
  env.tick(200);
  env.click(true, { "data-zp-haptic": "medium" });
  t("medium → vibrate(16)", env.calls.vibrate[1] === 16, JSON.stringify(env.calls.vibrate));
  env.tick(200);
  env.click(true, { "data-zp-haptic": "success" });
  t("success → vibrate(20)", env.calls.vibrate[2] === 20, JSON.stringify(env.calls.vibrate));
  env.tick(200);
  env.click(true, { "data-zp-haptic": "warn" });
  t("warn → 双脉冲 pattern", Array.isArray(env.calls.vibrate[3]) && env.calls.vibrate[3].length === 3,
    JSON.stringify(env.calls.vibrate[3]));
}

/* --- 2.3 未知 kind 按 light 处理（写错不该静默不震） --- */
{
  const env = load({ vibrate: true });
  env.click(true, { "data-zp-haptic": "very-hard" });
  t("未知 kind 归一到 light", env.calls.vibrate[0] === 10, JSON.stringify(env.calls.vibrate));
}

/* --- 2.4 两样都没有：静默返回 false，不抛 --- */
{
  const env = load();
  let threw = false;
  let ret;
  try { ret = env.win.zpHaptic("light"); } catch { threw = true; }
  t("无桥无 vibrate 不抛异常", !threw);
  t("无桥无 vibrate 返回 false", ret === false, String(ret));
  t("没有振动能力时照样能点（监听已装好）", env.listeners.length === 1);
}

/* --- 2.5 节流：同类 120ms 内合并，异类至少隔 60ms --- */
{
  const env = load({ bridge: "ok" });
  env.click(true, {});
  env.tick(50);
  env.click(true, {});
  t("同类 50ms 内第二次被吞（连点底栏不碎震）", env.calls.bridge.length === 1, JSON.stringify(env.calls.bridge));
  env.tick(100); // 距首次 150ms
  env.click(true, {});
  t("同类超过 120ms 后恢复", env.calls.bridge.length === 2, JSON.stringify(env.calls.bridge));
  env.tick(10); // 距上次 10ms
  env.click(true, { "data-zp-haptic": "medium" });
  t("异类 10ms 内被吞（不叠成一次长震）", env.calls.bridge.length === 2, JSON.stringify(env.calls.bridge));
  env.tick(60);
  env.click(true, { "data-zp-haptic": "medium" });
  t("异类超过 60ms 后放行", env.calls.bridge.length === 3, JSON.stringify(env.calls.bridge));
}

/* --- 2.6 桥抛错时回落浏览器通道（旧壳/实现异常不该让点击无感） --- */
{
  const env = load({ bridge: "throw", vibrate: true });
  env.click(true, {});
  t("桥抛错被吞掉", true);
  t("桥抛错后回落到 navigator.vibrate", env.calls.vibrate.length === 1, JSON.stringify(env.calls.vibrate));
}

/* --- 2.7 vibrate 自己抛错（Chrome 无用户手势）也不影响点击 --- */
{
  const env = load({ vibrate: true, vibrateThrows: true });
  let threw = false;
  try { env.click(true, {}); } catch { threw = true; }
  t("vibrate 抛错不外泄", !threw);
}

/* --- 2.8 点空白处不震 --- */
{
  const env = load({ bridge: "ok" });
  env.click(false);
  t("点非按钮区域不震动", env.calls.bridge.length === 0);
}

/* ===== 三、页面装配：所有页面都得加载到这一层 =====
 * home 走 bundle（js/home.bundle.js 内含 haptic 源），其余页面单独引。 */
const PAGES = [
  "admin.html",
  "pages/account.html", "pages/data.html", "pages/dispatch.html", "pages/history.html",
  "pages/order_detail.html", "pages/privacy.html", "pages/route_apply.html",
  "pages/today.html", "pages/terms.html",
];
for (const p of PAGES) {
  t(`${p} 引用了 /js/ui/haptic.js`, read(p).includes("/js/ui/haptic.js"));
}
t("home.html 通过 bundle 获得触感层（不单独引第二份，避免重复绑定）",
  read("home.html").includes("/js/home.bundle.js") && !read("home.html").includes("/js/ui/haptic.js"));
t("home.bundle.js 内含 haptic 实现", read("js/home.bundle.js").includes("window.zpHaptic"));
t("bundle 构建源包含 js/ui/haptic.js",
  read("scripts/build-home-bundle.mjs").includes('"js/ui/haptic.js"'));
t("haptic.js 在 core.js 之后、appearance.js 之前拼入 bundle",
  read("scripts/build-home-bundle.mjs").indexOf('"js/ui/haptic.js"') >
  read("scripts/build-home-bundle.mjs").indexOf('"js/ui/core.js"') &&
  read("scripts/build-home-bundle.mjs").indexOf('"js/ui/haptic.js"') <
  read("scripts/build-home-bundle.mjs").indexOf('"js/ui/appearance.js"'));

/* ===== 四、底部悬浮按钮也要有触感（页面底部的真实用例） ===== */
t("订单详情「待确认」悬浮按钮标注 data-zp-haptic=medium",
  /order-pending-fab[\s\S]{0,120}dataset\.zpHaptic\s*=\s*['"]medium['"]|dataset\.zpHaptic\s*=\s*['"]medium['"][\s\S]{0,120}order-pending-fab/.test(
    read("js/order_detail/render.js")
  ));

console.log(`\n按钮触感：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error("\n失败项：");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("✅ 全部通过");
