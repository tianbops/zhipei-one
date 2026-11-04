/**
 * 首页「今日配送」高度行为契约（node tests/home-today-grow.test.mjs）
 * ------------------------------------------------------------------
 * 守护 2026-11-04 的需求：今日配送板块「内容放开、随内容增多而增高；
 * 无内容时保持填满整页」。锁定两条易回归的实现：
 *   1) 基础规则（@media 之外）：滚动容器可滚动承接内容、列表内容高度无 264 封顶、
 *      卡片默认内容高度；空态由 .is-today-empty（卡片 flex:1）与
 *      .today-store-list.is-empty（列表 flex:1）共同填满整页。
 *   2) js/home/fit.js 不再因「整页内容溢出」回退 is-overflow（那是旧版
 *      「列表封顶 264 + 内部滚动」的元凶，会把内容态又打回封顶）。
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
const baseStart = CSS.indexOf("一屏定盘");
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
  t("卡片基础段默认内容高度 flex:0 0 auto（不强制填满；填满交给空态）",
    !!card && /flex:0 0 auto/.test(card), card);

  const list = rule(BASE, "main.home-app .today-store-list");
  t("列表基础段 flex:0 0 auto（内容自然增高，而非 flex:1 锁死填充）",
    !!list && /flex:0 0 auto/.test(list), list);
  t("列表基础段无 264 封顶（max-height:none，非 max-height:264px）",
    !!list && /max-height:none/.test(list) && !/max-height:264px/.test(list), list);
  t("列表基础段 overflow:visible（不再内部滚动）",
    !!list && /overflow:visible/.test(list), list);
}

console.log("\n空态填满契约（2 条）");
{
  t("根类 .is-today-empty 使卡片 flex:1 填满整页",
    /\.is-today-empty[^{]*\.task-card\{[^}]*flex:1 1 auto/.test(CSS));
  t("空态列表 .today-store-list.is-empty flex:1 填满卡片",
    /\.today-store-list\.is-empty\{[^}]*flex:1 1 auto/.test(CSS));
  t("空态文案贴顶（align-items:flex-start，非垂直居中；与空态参考图一致）",
    /\.today-store-list\.is-empty\{[^}]*align-items:flex-start/.test(CSS) &&
    !/\.today-store-list\.is-empty\{[^}]*align-items:center/.test(CSS));
}

console.log("\nfit.js 契约（2 条）");
{
  t("fit.js 切换根类 is-today-empty（区分空态/内容态）",
    /root\.classList\.toggle\("is-today-empty"/.test(JS));
  t("fit.js 不再因整页溢出回退 is-overflow（否则内容态又被封顶 264）",
    !/classList\.add\("is-overflow"\)/.test(JS) &&
    !/scroller\.scrollHeight - scroller\.clientHeight/.test(JS));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
