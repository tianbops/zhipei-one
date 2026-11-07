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
 *     门店行保留极淡行间细线 --zp-tint（Shadowrocket 节点列表同样有细线）。
 *  2) 抗抖动：让位块高度不再逐帧跟手写入 render()，而是抽成 commitSpacer()，
 *     仅在「松手二态吸附」(animate=true) 时提交；跟手阶段布局冻结、列表位置
 *     恒定。measure() 在浮层尺寸变化时按新 need 重提交，但跟手中跳过。
 *  3) Shadowrocket 二态吸附时长 .18s（视频 1–2 帧 ≈ 0.1–0.2s）。
 *  4) 只作用于 main.home-app，内页复用的 .task-card / .trend-card 不受影响。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const CSS = rd("../css/home-dashboard.css");
const FLOAT_JS = rd("../js/home/head-float.js");
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
  const row = rule(FLAT_SEG, "main.home-app .today-store-row");
  t("门店行保留极淡行间细线 --zp-tint（Shadowrocket 节点列表同款）",
    !!row && /border-bottom:1px solid var\(--zp-tint\)/.test(row));
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

console.log("\n三、抗抖动：跟手冻结布局 + 松手二态提交（7 条）");
{
  /* render() 内不得再逐帧写 spacer 高度 */
  const renderStart = FLOAT_JS.indexOf("function render(){");
  const renderEnd = FLOAT_JS.indexOf("function commitSpacer(){");
  const renderBody = renderStart >= 0 && renderEnd > renderStart
    ? FLOAT_JS.slice(renderStart, renderEnd) : "";
  t("render() 只更新浮层 transform + 底栏（不含 spacer 高度写入）",
    /function render\(\)\{/.test(renderBody) && !/spacer\.style\.height/.test(renderBody));
  t("让位块高度抽成 commitSpacer()", /function commitSpacer\(\)\{/.test(FLOAT_JS));
  t("commitSpacer 二态提交（p>=.5 → need / 否则 0）",
    /spacer\.style\.height=\(p>=\.5\?Math\.round\(need\):0\)\+"px"/.test(FLOAT_JS));
  t("setP 仅在吸附 animate=true 时提交让位（跟手冻结布局）",
    /if\(animate\)commitSpacer\(\)/.test(FLOAT_JS));
  t("measure 在浮层尺寸变化时重提交，但跟手中跳过",
    /if\(!dragging&&p>=\.5\)commitSpacer\(\)/.test(FLOAT_JS));
  t("抗抖动注释固化根因（逐帧顶动 180px / 列表位置恒定）",
    /顶动 180px/.test(FLOAT_JS) && /列表位置恒定/.test(FLOAT_JS));
  /* 手势本体不回归：方向吸附、touchcancel、原生滚动共存 */
  t("原生滚动 / 二态吸附 / touchcancel 机制保留",
    /accDy<0\?1:0/.test(FLOAT_JS) &&
    /addEventListener\("touchcancel",end/.test(FLOAT_JS) &&
    !/\.preventDefault\(/.test(FLOAT_JS));
}

console.log("\n四、Shadowrocket 二态吸附时长 + 产物同步（4 条）");
{
  t("浮层 transform 过渡收紧到 .18s（视频 1–2 帧二态吸附）",
    /\.zp-head-float\{[\s\S]*?transition:transform \.18s/.test(CSS));
  t("让位块 height 过渡同步 .18s",
    /\.zp-head-spacer\{[\s\S]*?transition:height \.18s/.test(CSS));
  t("bundle CSS 已同步（含去卡片化规则 + .18s 过渡）",
    BUNDLE_CSS.includes("main.home-app .task-card,\nmain.home-app .trend-card{") &&
    BUNDLE_CSS.includes("transition:transform .18s"));
  t("bundle JS 已同步（含 commitSpacer / 仅吸附提交）",
    BUNDLE_JS.includes("function commitSpacer(){") &&
    BUNDLE_JS.includes("if(animate)commitSpacer()") &&
    BUILD.includes('"js/home/head-float.js"'));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 首页去卡片化 + 抗抖动契约：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
