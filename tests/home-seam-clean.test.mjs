/**
 * 首页「tab 选中态去块改蓝字 + 隐藏态衔接无虚化」契约
 * （node tests/home-seam-clean.test.mjs）
 * ------------------------------------------------------------------
 * 2026-11-07 需求：用户反馈两点——
 *   1) 多单 tab「第一单/第二单」选中时带一个灰圆角块（看着像边框），
 *      要求取消选中块，改为「对应那一单用主题蓝色字体」；
 *   2) 品牌区与下方背景色看着不一致、衔接处有虚化，要求取消虚化。
 *
 * 根因（线上真机像素实测，见 head-float-verify/seam-dark.json）：
 *   html/body/shell/topbar/task 背景完全一致（深色均 rgb(22,22,22)）。
 *   隐藏态浮层底边正好落在品牌区下沿 y=72，白卡片的常驻 box-shadow
 *   向下溢出约 40px，把 y=72..112 压成 22→16→22 的渐变暗带 ——
 *   这就是「不一致 + 虚化」。去掉隐藏态阴影后该带恒为 22（纯底色）。
 *
 * 守护要点：
 *   1) 选中态 transparent 底 + --zp-accent 蓝字（全站激活态文字令牌），
 *      不用 --zp-primary（按钮底色，文字对比度契约禁止当文字色）；
 *   2) 白卡片默认 box-shadow:none，阴影只挂在 .is-open 上；
 *      is-open 由 head-float.js 的 setP() 按 p>=.5 切换，隐藏态无投影；
 *   3) 品牌区 / 外壳 / 列表背景同走 --zp-bg，不引入第二条色带；
 *   4) bundle 产物与源文件同步。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const CSS = rd("../css/home-dashboard.css");
const SHELL = rd("../css/ui-shell.css");
const HTML = rd("../home.html");
const FLOAT_JS = rd("../js/home/head-float.js");
const BUNDLE_CSS = rd("../css/home.bundle.css");
const BUNDLE_JS = rd("../js/home.bundle.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
/* 取单条规则体：本文件要查的既有单行规则（.today-tab.is-active / .is-open ...）
   也有多行规则，故以「第一个右花括号」收尾，不依赖 } 是否单独成行。 */
function rule(src, sel) {
  const i = src.indexOf(sel + "{");
  if (i < 0) return null;
  const j = src.indexOf("}", i);
  return j < 0 ? null : src.slice(i, j + 1);
}

console.log("一、多单 tab 选中态：去灰块、改主题蓝文字（6 条）");
{
  const act = rule(CSS, ".today-tab.is-active");
  const press = rule(CSS, ".today-tab:active");
  t("选中态规则存在", !!act);
  t("选中态背景透明（取消 --zp-tint 灰圆角块）",
    !!act && /background:transparent/.test(act) && !/background:var\(--zp-tint\)/.test(act));
  t("选中态文字取 --zp-accent（全站激活态文字令牌，深浅自适应）",
    !!act && /color:var\(--zp-accent\)/.test(act));
  t("选中态不把按钮底色 --zp-primary 当文字色",
    !!act && !/color:var\(--zp-primary\)/.test(act));
  t("选中态保持加粗、无字面量颜色",
    !!act && /font-weight:var\(--zp-fw-bold\)/.test(act) && !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(act));
  t("按下态只降透明度，不再叠一层灰块",
    !!press && /opacity:\.6/.test(press) && !/background:var\(--zp-tint\)/.test(press));
}

console.log("二、隐藏态衔接：无阴影、无虚化（7 条）");
{
  const card = rule(CSS, ".home-app .zp-head-card");
  const openCard = rule(CSS, ".home-app .zp-head-float.is-open .zp-head-card");
  t("白卡片基础规则默认 box-shadow:none（隐藏态不投影）",
    !!card && /box-shadow:none/.test(card));
  t("白卡片基础规则不再常驻 var(--zp-shadow-md)",
    !!card && !/box-shadow:var\(--zp-shadow-md\)/.test(card));
  t("阴影改挂在 .zp-head-float.is-open .zp-head-card 上",
    !!openCard && /box-shadow:var\(--zp-shadow-md\)/.test(openCard));
  t("is-open 规则特异性高于白卡片基础规则（选择器含 .is-open）",
    !!openCard && /\.zp-head-float\.is-open/.test(openCard));
  t("setP() 里切换 is-open 类",
    /classList\.toggle\("is-open"/.test(FLOAT_JS));
  t("is-open 阈值 p>=.5（与底栏反向 / 二态吸附同一套语义）",
    /classList\.toggle\("is-open",p>=\.5\)/.test(FLOAT_JS));
  t("初始 DOM 的浮层不带 is-open（隐藏态起步即无阴影）",
    /id="zpHeadFloat"/.test(HTML) && !/id="zpHeadFloat"[^>]*is-open/.test(HTML));
}

console.log("三、品牌区与下方同底色（4 条）");
{
  const ceiling = rule(CSS, "main.home-app > .topbar");
  const flatIdx = CSS.indexOf("/* ===== 门店列表 / 月度统计「去卡片化」");
  const FLAT_SEG = flatIdx >= 0 ? CSS.slice(flatIdx) : "";
  t("品牌区天花板取 --zp-bg 页面底色",
    !!ceiling && /background:var\(--zp-bg\)/.test(ceiling));
  t("门店列表 / 月度统计同取 --zp-bg（无第二层灰块底）",
    /main\.home-app \.task-card,[\s\S]{0,120}main\.home-app \.trend-card\{[\s\S]{0,220}background:var\(--zp-bg\)/.test(FLAT_SEG));
  t("外壳 main.zp-shell 取 --zp-bg（滚动区继承同色）",
    /main\.zp-shell\{[\s\S]*?background:var\(--zp-bg\)/.test(SHELL));
  const floatRule = rule(CSS, ".home-app .zp-head-float");
  t("浮层容器自身不引入背景色带（保持透明 overlay）",
    !!floatRule && /pointer-events:none/.test(floatRule) && !/background:/.test(floatRule));
}

console.log("四、bundle 产物同步（3 条）");
{
  t("bundle CSS 已同步选中态蓝字 / 透明底",
    BUNDLE_CSS.includes(".today-tab.is-active{background:transparent;color:var(--zp-accent)"));
  t("bundle CSS 已同步 is-open 才投影",
    BUNDLE_CSS.includes(".home-app .zp-head-float.is-open .zp-head-card{box-shadow:var(--zp-shadow-md)}"));
  t("bundle JS 已同步 is-open 切换",
    BUNDLE_JS.includes('classList.toggle("is-open",p>=.5)'));
}

console.log("\n" + pass + "/" + (pass + fail) + " 通过");
if (fail) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
