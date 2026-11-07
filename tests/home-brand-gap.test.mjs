/**
 * 首页品牌区留白契约（node tests/home-brand-gap.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：用户反馈「顶部空间太紧，智配One 和下方文字保持适当距离」。
 * 真机 Chromium 390×844 实测（改动前）：
 *   .home-brand strong 底 y=48，span 顶 y=50 → 两行只隔 2px；
 *   span 底 y=66 → .task-card 顶 y=86 → 副标到卡片 20px。
 * 修复后：2px → 8px、20px → 26px，主标仍 y=24（没有反向贴住状态栏），
 *   字号 20/11 与行高 24/16 一律不动 —— 靠留白而不是放大字号拉开层级。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) span 的 margin-top 是 8px，不得退回 2px，也不得用 !important 硬压；
 *   2) 首页专属 .home-app .topbar{margin-bottom:12px} 只作用于首页；
 *   3) 全局 main > .topbar 的 6px 口径保持不变（内页零影响）；
 *   4) 源 CSS 与 css/home.bundle.css 同步、?v 引用一致（首页只加载 bundle）；
 *   5) 主标不得加 margin-top（否则在 50px 顶栏里会被垂直居中推上去贴状态栏）；
 *   6) topbar 下内边距 6px —— 2026-11-07 用户反馈「运单处理文字下方太紧」，
 *      ceiling 取 topbar.bottom 不吃 margin，只有 padding 能让浮层真正让开。
 *      实测副标行盒底=浮层顶 y=72（重合），补 6px 后间隙 6px、视觉约 9px。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const SRC = rd("../css/home-base.css");
const BUNDLE = rd("../css/home.bundle.css");
const SHELL = rd("../css/ui-shell.css");
const HTML = rd("../home.html");
const SW = rd("../sw.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const brandSpan = /\.home-brand\s+span\s*\{([^}]*)\}/g;
const spanBlocks = [...SRC.matchAll(brandSpan)].map((m) => m[1]);
const homeTopbar = (/\.home-app\s+\.topbar\s*\{([^}]*)\}/.exec(SRC) || [])[1] || "";
const globalTopbar = (/main\s*>\s*\.topbar\s*\{([^}]*)\}/.exec(SHELL) || [])[1] || "";

console.log("首页品牌区留白契约（13 条）");
{
  t("副标 margin-top:8px（主标↔副标拉开到 8px）",
    spanBlocks.some((b) => /margin-top:8px/.test(b)), spanBlocks.join(" | ").slice(0, 160));

  t("副标不再是 2px（旧值会让两行几乎黏在一起）",
    !spanBlocks.some((b) => /margin-top:2px/.test(b)));

  t("首页顶栏下边距 12px（副标→今日配送 14+12=26px）",
    /margin-bottom:12px/.test(homeTopbar), homeTopbar);

  t("首页顶栏下内边距 6px（副标→浮层横条留出呼吸位）",
    /padding-bottom:6px/.test(homeTopbar), homeTopbar);

  t("浮层让位只靠 padding，不得改成 margin（ceiling 不吃 margin）",
    /padding-bottom:6px/.test(homeTopbar) && /margin-bottom:12px/.test(homeTopbar));

  t("首页顶栏仍保持 flex 居中（间距调整不得破坏居中）",
    /display:flex/.test(homeTopbar) && /align-items:center/.test(homeTopbar));

  t("全局 main > .topbar 仍是 6px（内页零影响）",
    /margin-bottom:6px/.test(globalTopbar), globalTopbar.slice(0, 160));

  t("主标字号/行高不变（20px / 24px），不靠放大字号拉开",
    /\.home-brand\s+strong\s*\{[^}]*font-size:var\(--zp-fs-20\);line-height:24px/.test(SRC));

  t("副标字号/行高不变（11px / 16px）",
    spanBlocks.some((b) => /font-size:var\(--zp-fs-11\)/.test(b)) &&
    spanBlocks.some((b) => /line-height:16px/.test(b)));

  t("主标不带 margin-top（避免被 flex 居中推上去贴状态栏）",
    ![...SRC.matchAll(/\.home-brand\s+strong\s*\{([^}]*)\}/g)].some((m) => /margin-top/.test(m[1])));

  t("品牌区仍是上下两行 flex column（结构不变）",
    /\.home-brand\s*\{[^}]*flex-direction:column/.test(SRC));

  t("品牌区规则不使用 !important（项目禁止用优先级硬压）",
    ![...SRC.matchAll(/\.home-brand[^{]*\{([^}]*)\}/g)].some((m) => /!important/.test(m[1])));

  t("bundle 含新间距且与源同步（首页只加载 home.bundle.css）",
    /\.home-brand span\{margin-top:8px/.test(BUNDLE) &&
    /\.home-app \.topbar\{[^}]*margin-bottom:12px/.test(BUNDLE) &&
    /\.home-app \.topbar\{[^}]*padding-bottom:6px/.test(BUNDLE));

  const hv = (s) => (/home\.bundle\.css\?v=([0-9a-f]+)/.exec(s) || [])[1];
  t("home.html 与 sw.js 的 home.bundle.css?v 一致（缓存能刷新）",
    !!hv(HTML) && hv(HTML) === hv(SW), `html=${hv(HTML)} sw=${hv(SW)}`);
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
