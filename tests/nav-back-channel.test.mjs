/**
 * 返回通道契约（tests/nav-back-channel.test.mjs）
 * ------------------------------------------------------------
 * 对应 ZP-NAV-2026-002 修订 G（2026-10-30，v1.0.19）：
 *
 *   1. 原生返回键**不再**走 WebView 的浏览历史（webView.goBack），一律交 window.zpSystemBack。
 *      goBack 只认「上一页文档」，看不到页面内还开着的确认框，会把弹层连同未处理内容一起丢掉。
 *   2. zpDoExit 在原生壳内直接 ZhipeiNative.exitApp()（原生 finish），不再 history.back()——
 *      壳里 back 只会退回上一页，退不出应用。
 *   3. 顶部返回按钮/原生返回不消费历史，因此「关掉一层 UI」后**不得**无条件补压占位；
 *      只有下面还压着弹层时才补。无脑补压会留下指向内页的孤儿记录，连按返回又退回旧页。
 *
 * 本测试同时做源码红线与行为求值，防止这四条被改回去。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ===== 一、原生侧：返回键必须走 zpSystemBack，而不是 goBack =====
 * 原生壳在客户端仓库（tianbops/zhipei），Web 仓库里通常没有 android/ 目录；
 * 存在时一并校验，不存在则跳过（客户端侧由 scripts/check-back-channel.mjs 守住）。 */
const JAVA_PATHS = [
  "android/app/src/main/java/com/tianbops/zhipei/MainActivity.java",
  "android-template/app/src/main/java/com/tianbops/zhipei/MainActivity.java",
];
let javaChecked = 0;
for (const p of JAVA_PATHS) {
  let java;
  try { java = read(p); } catch { continue; }
  javaChecked++;
  const iProbe = java.indexOf("(window.zpSystemBack?1:0)");
  const iCall = java.indexOf('evaluateJavascript("window.zpSystemBack()"');
  const iBack = java.indexOf("webView.goBack()");

  t(`${p}：存在 zpSystemBack 探测`, iProbe > 0);
  t(`${p}：存在 zpSystemBack 调用`, iCall > 0);
  t(`${p}：goBack 出现在探测之后（仅作 JS 未就绪兜底）`, iBack > iProbe && iProbe > 0,
    `probe=${iProbe} back=${iBack}`);
  t(`${p}：goBack 不再是「能退就退」的第一分支`,
    !/if \(webView\.canGoBack\(\)\) \{\s*webView\.goBack\(\);\s*return;\s*\}/.test(
      java.slice(0, iProbe > 0 ? iProbe : java.length)
    ));
}
t("原生侧：Web 仓库内无 android/ 时跳过（不判失败）", true, `已校验 ${javaChecked} 个文件`);

/* ===== 二、zpDoExit：原生壳内优先 exitApp ===== */
const SRC = read("js/ui/back.js");
const exitStart = SRC.indexOf("function zpDoExit()");
const exitEnd = SRC.indexOf("// 顶部返回按钮专用出口");
assert.ok(exitStart > 0 && exitEnd > exitStart, "切片失败：zpDoExit 未找到");
const EXIT_BODY = SRC.slice(exitStart, exitEnd);
t("zpDoExit：调用 ZhipeiNative.exitApp", /ZhipeiNative[\s\S]{0,120}\.exitApp\(\)/.test(EXIT_BODY));
{
  const iExit = EXIT_BODY.indexOf("N.exitApp()");
  const iBack = EXIT_BODY.indexOf("try{history.back()");
  t("zpDoExit：exitApp 在 history.back 之前", iExit > 0 && iBack > iExit, `exit=${iExit} back=${iBack}`);
}

/* ===== 三、行为：zpBackButton 的补压只在「还有下一层」时发生 ===== */
const btnStart = SRC.indexOf("async function zpBackButton()");
const btnEnd = SRC.indexOf("/* 原生壳在 WebView");
assert.ok(btnStart > 0 && btnEnd > btnStart, "切片失败：zpBackButton 未找到");
const BTN_BODY = SRC.slice(btnStart, btnEnd);

function runBackButton({ handled, hasLayer }) {
  const calls = { guard: 0, exit: 0, replace: 0 };
  const factory = new Function(
    "zpHandleBack", "zpTopHook", "zpPushGuard", "zpDoExit", "zpLeaving",
    BTN_BODY + "\nreturn zpBackButton;"
  );
  const fn = factory(
    async () => handled,
    () => (hasLayer ? {} : null),
    () => { calls.guard++; },
    () => { calls.exit++; },
    false
  );
  return fn().then(() => calls);
}

const r1 = await runBackButton({ handled: "handled", hasLayer: true });
t("关掉一层且下面还有弹层 → 补压 1 次", r1.guard === 1, JSON.stringify(r1));

const r2 = await runBackButton({ handled: "handled", hasLayer: false });
t("关掉最后一层 → 不补压（不留孤儿记录）", r2.guard === 0, JSON.stringify(r2));

const r3 = await runBackButton({ handled: "exit", hasLayer: false });
t("根页第二次返回 → 走退出", r3.exit === 1, JSON.stringify(r3));

/* ===== 四、全仓红线：站内不得再有 push 型导航 / 菜单自压历史 ===== */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(name) && !/\.bundle\.js$/.test(name)) out.push(p);
  }
  return out;
}
const SCAN = [...walk(join(ROOT, "js")), ...walk(join(ROOT, "pages"))]
  .filter((p) => !p.includes(`${ROOT}js/ui/back.js`));

const offenders = [];
for (const p of SCAN) {
  const body = readFileSync(p, "utf8");
  if (/location\.assign\(/.test(body)) offenders.push(`${p}:location.assign`);
  if (/history\.pushState\(\{\s*zpMenu/.test(body)) offenders.push(`${p}:pushState(zpMenu)`);
}
t("站内无 location.assign（会多压一条历史）", !offenders.some((o) => o.includes("location.assign")),
  offenders.join(", "));
t("菜单不再自压历史记录", !offenders.some((o) => o.includes("zpMenu")), offenders.join(", "));

console.log(`返回通道契约：${pass} 通过 / ${fail} 失败`);
if (fail) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✓ 返回键脱离浏览历史、退出走原生、补压仅在有下一层时发生");
