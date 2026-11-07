/**
 * 首页「门店列表 / 月度统计去卡片化 + 列表抗抖动」契约
 * （node tests/home-flat-list.test.mjs）
 * ------------------------------------------------------------------
 * 2026-11-07 需求：门店列表去除边框、直接铺满、改为页面底色；月度统计同样
 * 处理；优化门店列表滑动抖动；滑动参数参照 Shadowrocket 视频逐帧实测。
 *
 * 守护要点：
 *  1) 去卡片化：两块改 --zp-bg 页面底色、去 border / 圆角 / 阴影 / 左右内缩；
 *     只用「去内缩」铺满内容区，不用负 margin 通栏（.zp-scroll 是
 *     overflow-y:auto，负 margin 会被计算成 auto 的 overflow-x 裁切/横向滚动）；
 *     门店行保留极淡行间细线 --zp-divider（与历史 / 数据 / 运单详情同一支令牌）。
 *  2) 抗抖动：浮岛是纯 overlay，只做 transform，不写任何文档流高度；项目里
 *     没有让位块，列表的 scrollTop 与行位置在弹收全程一格不动。
 *  3) 弹收时长由 --zp-island-dur/.ease 统一表达（现 .14s 同曲线），
 *     与底栏同刻起停；滚动帧不逐帧写样式。
 *  4) 只作用于 main.home-app，内页复用的 .task-card / .trend-card 不受影响。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const CSS = rd("../css/home-dashboard.css");
const FLOAT_JS = rd("../js/home/head-float.js");
const HTML = rd("../home.html");
const BUNDLE_CSS = rd("../css/home.bundle.css");
const BUNDLE_JS = rd("../js/home.bundle.js");
const BUILD = rd("../scripts/build-home-bundle.mjs");

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
/* 去卡片化段：同一选择器在文件里出现多次（margin-top / flex / 去卡片化覆盖），
   必须只在本段内定位那条覆盖规则，避免取到更早的同名基础规则。 */
const FLAT_SEG = CSS.slice(CSS.indexOf('/* ===== 门店列表 / 月度统计「去卡片化」'));

console.log("一、去卡片化：页面底色 + 铺满 + 去边框（8 条）");
{
  /* 合并选择器规则：两块共用同一条去外框规则 */
  const flatIdx = CSS.indexOf("main.home-app .task-card,\nmain.home-app .trend-card{");
  const flat = flatIdx >= 0 ? CSS.slice(flatIdx, CSS.indexOf("\n}", flatIdx) + 2) : null;
  t("存在 task-card / trend-card 共用去卡片化规则", !!flat, flat);
  t("改页面底色 --zp-bg（非灰块 --zp-card / --zp-block）",
    !!flat && /background:var\(--zp-bg\)/.test(flat) && !/var\(--zp-card\)/.test(flat));
  t("去边框 border:0", !!flat && /border:0/.test(flat));
  t("去圆角 border-radius:0", !!flat && /border-radius:0/.test(flat));
  t("去阴影 box-shadow:none", !!flat && /box-shadow:none/.test(flat));
  t("不用负 margin 通栏（避免 overflow-x:auto 裁切）",
    !!flat && !/margin-(left|right):\s*-|calc\(-1/.test(flat));

  const card = rule(FLAT_SEG, "main.home-app .task-card");
  t("门店列表去掉左右内缩 padding-left/right:0（直接铺满内容区）",
    !!card && /padding-left:0/.test(card) && /padding-right:0/.test(card));
  const rowBase = rule(CSS, ".today-store-row");
  t("门店行保留极淡行间细线 --zp-divider（与历史 / 数据 / 运单详情同一支令牌）",
    !!rowBase && /border-bottom:1px solid var\(--zp-divider\)/.test(rowBase));
}

console.log("\n二、月度统计同样处理（2 条）");
{
  /* .trend-card 也出现在合并选择器「...task-card,\n...trend-card{」里且以 { 结尾，
     rule() 会先命中那条共用规则；这里直接精确匹配末尾单独的 padding 规则。 */
  t("月度统计去掉左右内缩",
    /main\.home-app \.trend-card\{\s*padding-left:0;\s*padding-right:0;/.test(FLAT_SEG));
  /* 两块都走 --zp-bg，深浅自适应零字面量（只在本段内检查） */
  t("去卡片化配色零字面量（无 #hex / rgb 硬编码，深浅走令牌）",
    FLAT_SEG.length > 100 && !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(FLAT_SEG));
}

console.log("\n三、列表稳定：浮层纯 overlay，不推动列表（7 条）");
{
  /* 2026-11-07 第二轮：让位彻底取消 —— 只要还写文档流高度，列表就会被推动 */
  t("head-float 不再计算让位高度 need", !/need/.test(FLOAT_JS));
  t("head-float 不再有 commitSpacer（无文档流写入点）", !/commitSpacer/.test(FLOAT_JS));
  t("head-float 从不写 spacer 高度", !/spacer\.style\.height/.test(FLOAT_JS));
  t("write() 只更新浮层 transform（无布局副作用）",
    /function write\(\)\{\s*float\.style\.transform=/.test(FLOAT_JS));
  t("measure() 只写天花板变量与 H，不碰 spacer（变量已移除）",
    /--zp-ceiling-h/.test(FLOAT_JS) && !/var spacer|spacer\./.test(FLOAT_JS));
  t("抗抖动根因注释保留（纯 overlay / 不碰文档流）",
    /纯 overlay/.test(FLOAT_JS) && /不写任何文档流高度|文档流位置/.test(FLOAT_JS));
  /* 滚动驱动：无 touch 监听 → 不存在 preventDefault，也不存在 touchcancel 截断 */
  t("彻底不接管 touch（无 touch 监听、无 preventDefault，原生滚动与惯性完整）",
    !/addEventListener\("touch/.test(FLOAT_JS) && !/\.preventDefault\(/.test(FLOAT_JS));
}

console.log("\n四、Shadowrocket 二态吸附时长 + 产物同步（4 条）");
{
  t("浮层吸附过渡经 --zp-island-* 令牌（与底栏同一套），滚动中由 .is-scrolling 关闭",
    /\.zp-head-float\{[\s\S]*?transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(CSS) &&
    /\.zp-head-float\.is-scrolling\{transition:none\}/.test(CSS));
  t("没有让位块样式残留（结构 / 样式都已删除，浮岛纯 overlay）",
    !/\.zp-head-spacer/.test(CSS) && !/zp-head-spacer/.test(HTML));
  t("bundle CSS 已同步（含去卡片化规则 + 统一过渡令牌）",
    BUNDLE_CSS.includes("main.home-app .task-card,\nmain.home-app .trend-card{") &&
    BUNDLE_CSS.includes("transition:transform var(--zp-island-dur) var(--zp-island-ease)"));
  t("bundle JS 已同步（不含 commitSpacer / 不写文档流高度）",
    !BUNDLE_JS.includes("function commitSpacer(){") &&
    !/spacer\.style\.height/.test(BUNDLE_JS) &&
    BUILD.includes('"js/home/head-float.js"'));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 首页去卡片化 + 抗抖动契约：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
