/**
 * 启动屏握手（tests/boot-ready.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30，v1.0.22）：启动屏改为「等网页首帧就绪才退」，握手点由网页侧的
 * js/boot-ready.js 调 ZhipeiNative.webReady() 完成。
 *
 * 这块失败得极其安静：
 *   - 少发一次握手 → 启动屏一直挂到原生 6 秒超时，用户盯着 logo 干等；
 *   - 发早了（脚本一执行就发 / 只等一次 rAF）→ 启动屏撤得比首屏还快，空窗原样回来；
 *   - 页面漏引脚本 → 该路径下启动屏只能靠超时撤，同样退化为 6 秒白等。
 * 所以既钉源码结构，也在 vm 里真跑一遍「双 rAF 才发、只发一次、无桥不报错」。
 */
import { readFileSync } from "node:fs";
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

const SRC = read("js/boot-ready.js");

/* ===== 一、源码红线 ===== */
t("boot-ready.js 存在且为 IIFE", /\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/.test(SRC));
t("无桥时直接退出（PWA/浏览器零开销）",
  /if\s*\(!nat\s*\|\|\s*typeof\s+nat\.webReady\s*!==\s*"function"\)\s*return/.test(SRC));
t("调用 ZhipeiNative.webReady", /nat\.webReady\(\)/.test(SRC));
t("必须双 rAF（单次 rAF 会在首帧上屏前就撤启动屏）",
  /requestAnimationFrame\(function\s*\(\)\s*\{[\s\S]{0,120}?requestAnimationFrame\(fire\)/.test(SRC));
t("幂等标记 sent（页面多入口/兜底不得重复握手）", /var\s+sent\s*=\s*false/.test(SRC) && /if\s*\(sent\)\s*return/.test(SRC));
t("有 setTimeout 兜底（rAF 被节流时不至于挂到原生超时）", /setTimeout\(fire\s*,\s*1200\)/.test(SRC));
t("不直接操作 DOM（脚本可能在 body 末尾、DOM 状态不可假设）", !/document\.(getElementById|querySelector)/.test(SRC));

/* ===== 二、每个页面都必须引入 ===== */
const PAGES = [
  "home.html", "index.html", "admin.html", "admin-bootstrap.html", "offline.html",
  "register.html", "setup.html",
  "pages/account.html", "pages/data.html", "pages/dispatch.html", "pages/history.html",
  "pages/order_detail.html", "pages/privacy.html", "pages/route_apply.html",
  "pages/terms.html", "pages/today.html",
];
for (const p of PAGES) {
  let html = "";
  try { html = read(p); } catch { /* 缺页面在下面统一报 */ }
  const has = /<script[^>]+src="\/js\/boot-ready\.js(\?v=[A-Za-z0-9_.-]+)?"/.test(html);
  t(`${p} 引入 boot-ready.js（带 ?v= 版本号）`, has);
  if (has) {
    const at = html.indexOf("/js/boot-ready.js");
    const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
    t(`${p} 的 boot-ready 位于 </body> 之前`, at > 0 && at < bodyEnd);
  }
}

/* ===== 三、Service Worker 预缓存必须带上它 ===== */
const SW = read("sw.js");
t("sw.js PRECACHE 含 boot-ready（否则离线启动拿不到握手脚本）",
  /\/js\/boot-ready\.js\?v=[a-f0-9]+/.test(SW));

/* ===== 四、vm 行为求值 ===== */
function boot({ bridge = true, rafThrows = false } = {}) {
  const calls = [];
  const rafs = [];
  const timers = [];
  const win = {};
  if (bridge) win.ZhipeiNative = { webReady: () => calls.push(Date.now()) };
  const ctx = {
    window: win,
    requestAnimationFrame: (cb) => {
      if (rafThrows) throw new Error("no raf");
      rafs.push(cb);
      return rafs.length;
    },
    setTimeout: (cb, ms) => { timers.push({ cb, ms }); return timers.length; },
  };
  createContext(ctx);
  runInContext(SRC, ctx);
  return { calls, rafs, timers, win };
}

// 无桥：不发、不排队、不抛
{
  const r = boot({ bridge: false });
  t("无桥环境：不排队 rAF、不设兜底定时器", r.rafs.length === 0 && r.timers.length === 0,
    `rafs=${r.rafs.length} timers=${r.timers.length}`);
}

// 有桥：第一帧不发，第二帧才发（证明不是「脚本执行即发」）
{
  const r = boot();
  t("有桥环境：脚本执行时不立刻握手", r.calls.length === 0);
  t("有桥环境：第一次 rAF 只是排下一帧", r.rafs.length === 1 && r.calls.length === 0,
    `rafs=${r.rafs.length} calls=${r.calls.length}`);
  r.rafs.shift()(); // 执行第一帧回调
  t("第一帧回调后仍未握手", r.calls.length === 0, `calls=${r.calls.length}`);
  t("第一帧回调排出了第二帧", r.rafs.length === 1);
  r.rafs.shift()(); // 执行第二帧回调
  t("第二帧回调后握手一次", r.calls.length === 1, `calls=${r.calls.length}`);
  // 兜底定时器再触发不得重复握手
  for (const x of r.timers) x.cb();
  t("兜底定时器不重复握手（幂等）", r.calls.length === 1, `calls=${r.calls.length}`);
}

// rAF 不可用：立刻握手，不能因为环境差异卡住启动屏
{
  const r = boot({ rafThrows: true });
  t("rAF 抛错时立刻握手（不依赖动画帧）", r.calls.length === 1, `calls=${r.calls.length}`);
}

/* ===== 汇总 ===== */
if (fail) {
  console.error(`✗ boot-ready：${pass} 通过 / ${fail} 失败`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ boot-ready：${pass}/${pass} 通过`);
