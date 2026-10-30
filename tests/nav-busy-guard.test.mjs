/**
 * 不可中断操作守卫回归测试（ZP-NAV-2026-002 第五节）
 * ------------------------------------------------------------------
 * 运行：node tests/nav-busy-guard.test.mjs
 *
 * 覆盖：
 *   一、zpBusyMessage 判定（首页 OCR/处理中、核对页确认提交中）
 *   二、zpCloseTopLayer 在忙碌时消费返回、不关弹层、不穿透
 *   三、核对页「提交中禁止关闭」：单一关闭入口 + 三个 UI 入口都走它
 *   四、「取消处理」按钮已彻底删除（HTML/JS/CSS 三处都不许再出现）
 *   五、Tab 根页（历史/线路/我的）不显示返回箭头
 *
 * 实现方式与 nav-return.test.mjs 一致：截取 js/ui/back.js 的真实源码片段求值，
 * 注入假的 window/zpToast，因此改源码后本测试自动跟随。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");
const read = (p) => readFileSync(fileURLToPath(new URL("../" + p, import.meta.url)), "utf8");

const CORE_OD = read("js/order_detail/core.js");
const CONFIRM_OD = read("js/order_detail/confirm.js");
const BOOT_OD = read("js/order_detail/boot.js");
const HOME_HTML = read("home.html");
const PROGRESS_JS = read("js/home/upload-progress.js");
const SHEET_JS = read("js/home/upload-sheet.js");
const BASE_CSS = read("css/home-base.css");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

function slice(from, to) {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i < 0 || j < 0 || j <= i) throw new Error("源码切片失败：" + from);
  return SRC.slice(i, j);
}

/* ---------- 真实求值：zpBusyMessage ---------- */
const BUSY_BODY = slice("function zpBusyMessage(){", "\n  // 自上而下关闭一层 UI");
const makeBusy = (win) => new Function("window", BUSY_BODY + "\n return zpBusyMessage;")(win);

console.log("一、zpBusyMessage 判定（5 条）");
{
  const win = {};
  const busy = makeBusy(win);

  t("无忙碌状态返回空串", busy() === "");

  win.zpIsProcessing = () => true;
  t("OCR/运单处理中 → 运单正在处理", busy() === "运单正在处理，请稍候");

  delete win.zpIsProcessing;
  win.zpIsConfirming = () => true;
  t("核对页保存中 → 正在保存", busy() === "正在保存，请稍候");

  win.zpIsProcessing = () => true;
  t("两者同时成立时处理中优先", busy() === "运单正在处理，请稍候");

  win.zpIsProcessing = () => { throw new Error("probe boom"); };
  t("探测器抛错不得让返回键崩溃", busy() === "");
}

/* ---------- 真实求值：zpCloseTopLayer 的守卫段 ---------- */
console.log("\n二、忙碌时返回被消费且不穿透（6 条）");
{
  const GUARD_BODY =
    BUSY_BODY + "\n" +
    slice("async function zpCloseTopLayer(){", "    const hooks=zpSortedHooks();") +
    '    return "fell-through";\n  }';

  let toasts = [];
  const win = { zpToast: (m, k) => toasts.push([m, k]) };
  const guard = new Function("window", GUARD_BODY + "\n return zpCloseTopLayer;")(win);

  (async () => {
    win.zpIsProcessing = () => true;
    const r1 = await guard();
    t("处理中返回 true（本次返回已消化，不穿透）", r1 === true, String(r1));
    t("处理中提示文案与级别", toasts[0] && toasts[0][0] === "运单正在处理，请稍候" && toasts[0][1] === "error", JSON.stringify(toasts));

    delete win.zpIsProcessing;
    win.zpIsConfirming = () => true;
    toasts = [];
    const r2 = await guard();
    t("保存中返回 true", r2 === true, String(r2));
    t("保存中提示文案", toasts[0] && toasts[0][0] === "正在保存，请稍候", JSON.stringify(toasts));

    // 清空忙碌后再走一次：应当穿透到 hooks（证明守卫只拦忙碌态）
    delete win.zpIsConfirming;
    toasts = [];
    const r3 = await guard();
    t("非忙碌时正常穿透（不误伤普通返回）", r3 === "fell-through", String(r3));
    t("非忙碌时不弹提示", toasts.length === 0, JSON.stringify(toasts));

    finish();
  })();
}

/* ---------- 三、核对页提交中禁止关闭 ---------- */
console.log("\n三、核对页提交中禁止关闭（6 条）");
{
  t("core.js 声明 confirming 状态", /let confirming=false;/.test(CORE_OD));
  t("core.js 暴露 window.zpIsConfirming", /window\.zpIsConfirming\s*=\s*\(\)\s*=>\s*confirming/.test(CORE_OD));

  const submitBlock = CONFIRM_OD.slice(CONFIRM_OD.indexOf("$('submitConfirm').onclick"));
  t("提交前置位 confirming=true", /confirming=true;/.test(submitBlock.split("try{")[0]));
  t("提交结束复位（finally）", /finally\{confirming=false\}/.test(submitBlock));

  const closeFn = CONFIRM_OD.slice(CONFIRM_OD.indexOf("function closeConfirmDialog(){"), CONFIRM_OD.indexOf("function openConfirm(){"));
  t("关闭入口在提交中直接返回", /if\(confirming\)\{/.test(closeFn) && /return;/.test(closeFn));

  // 三个 UI 入口 + 返回钩子必须都走同一个关闭函数，不能各自 hidden=true
  const bootClose = BOOT_OD.split("\n").filter((l) => /confirmDialog.*hidden\s*=\s*true/.test(l));
  t("boot.js 不再有绕过守卫的直接关闭", bootClose.length === 0, bootClose.join(" | "));
  t("boot.js 三处入口改用 closeConfirmDialog",
    (BOOT_OD.match(/closeConfirmDialog\(\)/g) || []).length >= 4);
}

/* ---------- 四、「取消处理」按钮彻底移除 ---------- */
console.log("\n四、「取消处理」按钮彻底移除（6 条）");
{
  t("home.html 无 processingCancel 按钮", !/processingCancel/.test(HOME_HTML));
  t("upload-progress.js 无 processingCancelBtn", !/processingCancelBtn/.test(PROGRESS_JS));
  t("upload-progress.js 无 CANCEL_REVEAL_MS", !/CANCEL_REVEAL_MS/.test(PROGRESS_JS));
  t("upload-progress.js 无 processingCancelled", !/processingCancelled/.test(PROGRESS_JS));
  t("upload-sheet.js 不再有取消点击处理", !/processingCancelBtn|processingCancelled/.test(SHEET_JS));
  t("home-base.css 无 .processing-cancel-btn", !/processing-cancel-btn/.test(BASE_CSS));
}

/* ---------- 五、Tab 根页不显示返回箭头 ---------- */
console.log("\n五、Tab 根页不显示返回箭头（6 条）");
for (const [file, title] of [
  ["pages/history.html", "历史"],
  ["pages/dispatch.html", "线路"],
  ["pages/account.html", "我的"],
]) {
  const html = read(file);
  t(`${title}页无 app-back`, !/class="app-back"/.test(html));
  t(`${title}页顶栏标记 is-root`, /class="topbar is-root"/.test(html));
}

/* ---------- 六、原生返回入口（壳 → Web） ---------- */
console.log("\n六、原生返回入口 window.zpSystemBack（3 条）");
{
  // 壳在 WebView 无历史可退时调用这个入口；拆分 ui-unified.js 时曾整个丢失，
  // 表现为「登录页按返回毫无反应」。此处锁住入口存在且两条分支齐全。
  const entry = SRC.slice(SRC.indexOf("window.zpSystemBack="), SRC.indexOf("function zpBindPageBack(){"));
  t("back.js 暴露 zpSystemBack", SRC.includes("window.zpSystemBack="));
  t("无工作区（登录/引导页）走原生退出", /if\(!zpZone\)\{/.test(entry) && /exitApp\(\)/.test(entry));
  t("工作区页转交 zpBackButton", /return zpBackButton\(\);/.test(entry));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  }
}
