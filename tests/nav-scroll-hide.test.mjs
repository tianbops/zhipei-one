/**
 * 底部导航滚动自隐藏回归测试（2026-11-04 补）
 * ------------------------------------------------------------------
 * 运行：node tests/nav-scroll-hide.test.mjs
 *
 * 锁住两处实现，防止将来被「顺手回退」或「改成淡出」：
 *   · css/ui-base.css 的隐藏态样式（位移出屏、不减淡、保留横向 -50%、减动效关过渡）
 *   · js/ui/nav.js 的滚动自隐藏逻辑（捕获阶段监听、rAF 防抖、顶/底强制显示、
 *     累计位移阈值、只认占屏过半滚动区、inert）
 *
 * 风格与 nav-busy-guard.test.mjs 一致：直接读真实源码做正则 / 切片断言，
 * 改源码后本测试自动跟随。行为层面的真机验证由独立 Playwright 脚本承担
 * （tests/tools/visual 不在 test:serial 链路内，避免给无头环境加浏览器依赖）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../css/ui-base.css", import.meta.url)), "utf8");
const JS = readFileSync(fileURLToPath(new URL("../js/ui/nav.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
function slice(src, from, to) {
  const i = src.indexOf(from), j = src.indexOf(to);
  if (i < 0 || j < 0 || j <= i) throw new Error("源码切片失败：" + from);
  return src.slice(i, j);
}

/* ============ 一、CSS 隐藏态 ============ */
console.log("一、隐藏态样式（位移出屏、不减淡）(6 条)");
{
  const block = slice(CSS, "/* ===== 常驻底部导航原语", ".zp-nav-item{");
  t("底栏基础定位 fixed + 横向 -50%",
    /\.zp-nav\{[\s\S]*?position:fixed[\s\S]*?transform:translateX\(-50%\)/.test(block));
  t("隐藏态整体下移出屏（含 16px 余量）",
    /\.zp-nav\.is-nav-hidden\{[^}]*transform:translate\(-50%,calc\(100% \+ 16px\)\)/.test(block),
    "未见 translate(-50%,calc(100% + 16px))");
  t("隐藏态保留 -50% 横向分量（不能只位移 Y）",
    /\.is-nav-hidden\{[^}]*translate\(-50%,/.test(block));
  t("隐藏态 pointer-events:none（出屏后不挡点击）",
    /\.zp-nav\.is-nav-hidden\{[^}]*pointer-events:none/.test(block));
  t("底栏有 transform 过渡（收起/回来是滑动不是瞬移）",
    /\.zp-nav\{[^}]*transition:transform[^}]*\}/.test(block));
  t("减动效下关闭过渡（prefers-reduced-motion）",
    /@media\(prefers-reduced-motion:reduce\)\{\.zp-nav\{transition:none\}\}/.test(block));
}

/* ============ 二、JS 滚动自隐藏逻辑 ============ */
console.log("\n二、滚动自隐藏逻辑（捕获监听 / 顶底强显 / 累计阈值）(7 条)");
{
  const block = slice(JS, "底栏滚动自隐藏", "})();");
  t("scroll 用捕获阶段监听（scroll 不冒泡，冒泡阶段收不到）",
    /addEventListener\("scroll",navOnScroll,\{capture:true,passive:true\}/.test(block));
  t("用 requestAnimationFrame 防抖（不在每个 scroll 帧里改 DOM）",
    /requestAnimationFrame\(function\(\)\{/.test(block) && /navTicking/.test(block));
  t("顶部强制显示（距顶 NAV_SHOW_TOP 内永远不收）",
    /y<=NAV_SHOW_TOP\|\|max-y<=NAV_SHOW_BOTTOM/.test(block) && /NAV_SHOW_TOP=/.test(block));
  t("底部强制显示（接近底部时强制显示，否则末段留白）",
    /y<=NAV_SHOW_TOP\|\|max-y<=NAV_SHOW_BOTTOM/.test(block) && /NAV_SHOW_BOTTOM=/.test(block));
  t("累计位移阈值 NAV_HIDE_DELTA（惯性滚动单帧太短，必须累计）",
    /NAV_HIDE_DELTA/.test(block) && /navAcc>=NAV_HIDE_DELTA/.test(block) && /navAcc<=-NAV_HIDE_DELTA/.test(block));
  t("只认占屏过半的滚动区（内嵌小列表不触发）",
    /clientHeight>=window\.innerHeight\*0\.6/.test(block));
  t("隐藏态切换类名 + inert（位移出屏后退出 Tab 序）",
    /classList\.toggle\("is-nav-hidden",hide\)/.test(block) &&
    /setAttribute\("inert"/.test(block) && /removeAttribute\("inert"\)/.test(block));
}

/* ============ 三、反向契约：禁用淡出 ============ */
console.log("\n三、反向契约：隐藏是位移而非淡出（2 条）");
{
  // 半透明穿屏会显廉价，且描边/投影会先于本体消失留下脏边。隐藏态不得含 opacity。
  const hiddenRule = (CSS.match(/\.zp-nav\.is-nav-hidden\{[^}]*\}/g) || [])[0] || "";
  t("隐藏态不含 opacity（不淡出）", !/opacity/.test(hiddenRule), hiddenRule);
  t("隐藏态不含 visibility（只位移、不隐藏渲染）", !/visibility/.test(hiddenRule), hiddenRule);
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    failures.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  }
}
finish();
