/**
 * 首页顶部浮层「紧凑化 + 多单 tab 去时间」契约
 * （node tests/home-compact-head.test.mjs）
 * ------------------------------------------------------------------
 * 2026-11-07 需求：用户反馈浮层白卡片垂直留白偏大，要求「高度紧凑一点」；
 *   并要求「取消第X单，后面的时间显示」—— tab 只留「第1单 / 第2单」序号。
 *
 * 守护要点：
 *  1) tab 文本只有「第X单」：不拼接 hm、不残留 zpTodayHM 死代码；
 *     排序仍按 uploadedAt 升序（去时间不等于去排序，默认仍停最新一单）。
 *  2) 紧凑只作用于 .home-app .zp-head-bar / .zp-head-card 作用域，
 *     只收垂直 padding / 上间距 / 插画高度；
 *  3) 红线不动：字号、行高、左右边距、圆角、tab 44px 触控下限、
 *     门店列表行高、月度统计、让位块逻辑、.18s 二态吸附时长（经 --zp-island-* 令牌）；
 *  4) bundle 产物与源文件同步。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const CSS = rd("../css/home-dashboard.css");
const BASE_CSS = rd("../css/home-base.css");
const TODAY = rd("../js/home/today.js");
const BUNDLE_CSS = rd("../css/home.bundle.css");
const BUNDLE_JS = rd("../js/home.bundle.js");

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

console.log("一、多单 tab 只显示「第X单」，不显示时间（6 条）");
{
  t("tab 渲染文本只有「第X单」并直接闭合 button",
    /第'\+\(i\+1\)\+'单<\/button>/.test(TODAY));
  t("不再拼接时间变量 hm / 不再调用 zpTodayHM",
    !/\+hm|zpTodayHM\(/.test(TODAY));
  t("不残留 zpTodayHM 函数定义（死代码清理）",
    !/function zpTodayHM/.test(TODAY));
  t("去掉时间显示后，排序仍按 uploadedAt 升序",
    /uploadedAt\|\|a\.createdAt/.test(TODAY));
  t("只有 1 单时 tab 整行隐藏（与旧版一致）",
    /todayTabs\.hidden=list\.length<2/.test(TODAY));
  t("bundle JS 已同步 tab 文本（不含时间拼接）",
    BUNDLE_JS.includes("第'+(i+1)+'单</button>") && !/zpTodayHM/.test(BUNDLE_JS));
}

console.log("\n二、浮层紧凑化：只收垂直留白（7 条）");
{
  const bar = rule(CSS, ".home-app .zp-head-bar");
  const card = rule(CSS, ".home-app .zp-head-card");
  const main = rule(CSS, ".home-app .zp-head-card .task-main");
  const man = rule(CSS, ".home-app .zp-head-card .delivery-man");
  const tabs = rule(CSS, ".home-app .zp-head-card .today-tabs");
  t("横条上下 padding 已收紧到 6px（左右仍 14px）",
    !!bar && /padding:6px 14px/.test(bar));
  t("白卡片 padding 已收紧到 6px（上下对称，左右仍 14px）",
    !!card && /padding:6px 14px/.test(card));
  t("task-main 上间距 5→3", !!main && /margin-top:3px/.test(main));
  t("插画高度 46→36（等比缩放，仍在可辨识区间）",
    !!man && /height:36px/.test(man));
  t("tabs 上间距 6→4", !!tabs && /margin-top:4px/.test(tabs));
  t("紧凑规则全部限定在 .zp-head-card 作用域（不碰内页复用组件）",
    !!main && !!man && !!tabs &&
    /\.home-app \.zp-head-card \.task-main\{/.test(CSS) &&
    /\.home-app \.zp-head-card \.delivery-man\{/.test(CSS) &&
    /\.home-app \.zp-head-card \.today-tabs\{/.test(CSS));
  t("bundle CSS 已同步紧凑规则（含插画 36px 与 tabs 4px）",
    BUNDLE_CSS.includes(".home-app .zp-head-card .delivery-man{height:36px}") &&
    BUNDLE_CSS.includes(".home-app .zp-head-card .today-tabs{margin-top:4px}"));
}

console.log("\n三、可读性红线不动（7 条）");
{
  const tab = rule(CSS, ".today-tab");
  const row = rule(CSS, ".today-store-row");
  const float = rule(CSS, ".home-app .zp-head-float");
  const spacer = rule(CSS, ".home-app .zp-head-spacer");
  t("tab 44px 触控下限保留", !!tab && /min-height:44px/.test(tab));
  t("tab 左右 padding 12px 保留（不改左右边距）", !!tab && /padding:0 12px/.test(tab));
  t("tab 字号仍走全局令牌 --zp-fs-13", !!tab && /font-size:var\(--zp-fs-13\)/.test(tab));
  t("门店行 44px 行高与字号令牌不动", !!row && /min-height:44px/.test(row));
  t("圆角仍用 --zp-r-card 令牌（横条 / 白卡片不写死像素）",
    /border-radius:var\(--zp-r-card\)/.test(CSS) &&
    /border-bottom-left-radius:var\(--zp-r-card\)/.test(CSS));
  t("浮层过渡仍走 --zp-island-* 令牌、让位恒 0（紧凑不改二态弹收）",
    !!float && /transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(float) &&
    !!spacer && /height:0/.test(spacer));
  t("字号 / 行高基线仍由 home-base.css 令牌提供（未被紧凑规则覆写）",
    /\.today-summary strong\{font-size:var\(--zp-fs-20\);line-height:27px\}/.test(BASE_CSS) &&
    !/\.home-app \.zp-head-card[^\n]*font-size:/.test(CSS));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 首页浮层紧凑化 + tab 去时间契约：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
