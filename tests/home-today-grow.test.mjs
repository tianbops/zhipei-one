/**
 * 首页「今日配送」高度行为契约（node tests/home-today-grow.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：今日配送板块「内容放开、随内容增多而增高；
 * 无内容（空态）保持 4 行高度、不撑满整页」（即「4 排列」）。
 *
 * 实现要点（易回归，必须锁死）：
 *   1) 基础段（@media 之外）：滚动容器可滚动承接内容、列表内容高度无 264 封顶；
 *      卡片与列表默认 flex:0 0 auto（不撑满整页）—— 首屏即此高度，
 *      数据到达后高度稳定，无刷新抖动；
 *   2) 空态高度由「列表内唯一的 .zp-empty--tight」在纯 CSS 定死 min-height:176px
 *      （= 44px × 4），文案贴顶、不撑满；高度不依赖 fit.js 异步加 .is-empty，
 *      否则数据到达后到定时器补类前的约 500ms 会出现「回缩又展开」（切回首页抖动）；
 *   3) 有内容时列表含真实门店行（骨架行带 aria-hidden，须排除），
 *      由 flex:0 0 auto 随门店数自然增高（基础段即此值，无需额外收回）；
 *   4) js/home/fit.js 按「非骨架的真实门店行」切换 .has-content、用 MutationObserver
 *      在 innerHTML 替换后即时复核，且不再因整页溢出回退 is-overflow。
 * 注意：基础规则与降级规则（@media 内）选择器同名，靠源码顺序层叠，
 *      故此处只断言【基础段】的取值，避免把降级 A 的 display:block 误读为基础。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../css/home-dashboard.css", import.meta.url)), "utf8");
const JS = readFileSync(fileURLToPath(new URL("../js/home/fit.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
function rule(src, sel) {
  const i = src.indexOf(sel + "{");
  if (i < 0) return null;
  const j = src.indexOf("\n}", i);
  return j < 0 ? null : src.slice(i, j + 2);
}
// 基础段：从「一屏定盘」注释到降级 A（@media max-height:759px）之前。
// 注意：文件更前面还有一个 @media(max-width:380px)，不能用作边界。
const baseStart = CSS.indexOf("首页纵向布局");
const aIdx = CSS.indexOf("@media (max-height:759px)");
const BASE = CSS.slice(baseStart, aIdx < 0 ? CSS.length : aIdx);

console.log("首页今日配送高度契约（基础段 6 条）");
{
  const scroller = rule(BASE, "main.home-app .zp-scroll");
  t("滚动容器基础段 display:flex（整页竖链）",
    !!scroller && /display:flex/.test(scroller), scroller);
  t("滚动容器基础段 overflow-y:auto（内容超出可滚动承接，非 overflow:hidden 锁死）",
    !!scroller && /overflow-y:auto/.test(scroller) && !/overflow:hidden;/.test(scroller), scroller);

  const card = rule(BASE, "main.home-app .task-card");
  t("卡片基础段 flex:0 0 auto（不撑满整页，空态保持自然/固定高度，无刷新抖动）",
    !!card && /flex:0 0 auto/.test(card), card);

  const list = rule(BASE, "main.home-app .today-store-list");
  t("列表基础段 flex:0 0 auto（内容自然增高，不强制填满）",
    !!list && /flex:0 0 auto/.test(list), list);
  t("列表基础段无 264 封顶（max-height:none，非 max-height:264px）",
    !!list && /max-height:none/.test(list) && !/max-height:264px/.test(list), list);
  t("列表基础段 overflow:visible（不再内部滚动）",
    !!list && /overflow:visible/.test(list), list);
}

console.log("\n空态 4 排列契约（3 条）");
{
  // 高度改由「内容结构」在纯 CSS 里定死：列表内唯一的 .zp-empty--tight 自带 176px。
  // 这样骨架首帧（4 行 = 176px）→ 数据到达空态 → 切回首页，全程同高，零抖动。
  const tight = rule(CSS, "main.home-app .today-store-list > .zp-empty--tight");
  t("空态高度由内容元素 CSS 定死 min-height:176px（= 44px × 4，不依赖 JS 加类）",
    !!tight && /min-height:176px/.test(tight), tight);
  const empty = rule(CSS, "main.home-app .today-store-list.is-empty");
  t("空态文案贴顶（align-items:flex-start，非垂直居中）",
    !!empty && /align-items:flex-start/.test(empty) && !/align-items:center/.test(empty), empty);
  t(".is-empty 只做对齐、不承载高度也不拉伸（不含 min-height / flex:1 1 auto，防「回缩又展开」回归）",
    !!empty && !/min-height:/.test(empty) && !/flex:1 1 auto/.test(empty), empty);
}

console.log("\nfit.js 契约（4 条）");
{
  t("fit.js 只维护空态对齐类 .is-empty（不再维护无消费者的 has-content / can-scroll）",
    /classList\.toggle\("is-empty"/.test(JS) &&
    !/classList\.toggle\("has-content"/.test(JS) && !/classList\.toggle\("can-scroll"/.test(JS));
  t("fit.js 不再回退 is-overflow / 不做高度测量（列表高度已由 CSS 内容驱动）",
    !/classList\.[a-z]+\("is-overflow"/.test(JS) && !/scrollHeight/.test(JS));
  t("fit.js 不再切换已废弃的 is-today-empty 根类（填空满逻辑已移除）",
    !/is-today-empty/.test(JS));
  t("fit.js 用 MutationObserver 监听列表 childList，数据到达即时复核（不留中间态）",
    /new MutationObserver\([\s\S]*?\)\.observe\(list,\s*\{\s*childList:\s*true\s*\}\)/.test(JS));
}

console.log("\n降级段不封顶契约（2 条）");
{
  /* 2026-11-05 用户录屏回归：浏览器地址栏占高时可视高度 < 760px，
     触发降级 A。旧规则在这里给列表加 max-height:264px 却没恢复 overflow，
     列表被裁 + 渐隐 + 滑不动 → 「web 端运单未展开，app 端正常」。
     现在降级段只切版面，列表高度在两种版面下都必须由内容决定。 */
  const aBlock = CSS.slice(aIdx < 0 ? 0 : aIdx, CSS.indexOf("降级 B"));
  t("降级 A（矮屏/横屏）不再给门店列表加 max-height 封顶",
    aIdx > 0 && !/today-store-list/.test(aBlock), aBlock);
  const bStart = CSS.indexOf("main.home-app.is-keyboard .zp-scroll");
  const B = CSS.slice(bStart, CSS.indexOf("空态（今日暂无配送门店）"));
  t("降级 B（键盘）同样不给列表加 max-height，且不再有 is-overflow 分支",
    bStart > 0 && !/today-store-list/.test(B) && !/is-overflow/.test(CSS), B);
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
