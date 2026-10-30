/**
 * 首页趋势卡底排：汇总三项与峰值提示不得重叠（tests/home-trend-row.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30，用户反馈「年度统计下方，文字重叠」）：
 *   汇总从「单 / t」两项变成「单 / 家 / t」三项后，年度视图那一行是
 *     左：96单  1802家  120.479t
 *     右：年度峰值 11月 · 63单　最忙 10月30日 · 1单
 *   加起来超过卡片内宽。旧写法 `.trend-summary{min-width:0}` +
 *   `.trend-hint{flex:none}` 的表现是：hint 一点不肯缩，summary 被压到只剩
 *   一百来像素，三项被挤成两三行，文字直接叠在提示上。
 *   之后按用户要求去掉了「最忙 X月X日 · N单」，390px 上重回单行；本文件守的是
 *   **放不下时仍要能换行**这条底线（320px 窄屏、以及以后再加内容时）。
 *
 * 这一层守的是**结构性写法的方向**（空间不足要换行、不要在原地硬挤）：
 *   - 间距/行高这类细节靠 tests/e2e-stats-scope.cjs 在真浏览器里量文字矩形；
 *   - 但 e2e 需要本机 chromium，不进 npm test，日常提交跑不到。
 *   所以这里再做一道能随 `npm run test:serial` 跑的静态护栏：
 *   谁把 flex-wrap 删了、把 hint 改回 flex:none，立刻红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* 取某个选择器的声明块（只取第一处，覆盖写法即可）。
 * 必须先剥注释：本文件的说明文字里就写着旧写法 `.trend-hint{flex:none}`，
 * 不剥的话 indexOf 会先命中注释，得出「hint 还是 flex:none」的假红。 */
function rule(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const i = clean.indexOf(selector + "{");
  if (i < 0) return "";
  return clean.slice(i + selector.length + 1, clean.indexOf("}", i));
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const src = read("css/home-trend.css");
/* bundle 原样保留源文件注释，同样要剥。 */
const bundle = strip(read("css/home.bundle.css"));

/* ---------- 1. 源样式：允许换行 ---------- */
const row = rule(src, ".trend-bottom-row");
t("源：.trend-bottom-row 允许换行（flex-wrap:wrap）", /flex-wrap:wrap/.test(row), row);
t("源：行间距用 row-gap 表达（gap 含双值）", /gap:\s*\d+px\s+\d+px/.test(row), row);

const hint = rule(src, ".trend-hint");
t("源：.trend-hint 不再写 flex:none（那是重叠的直接原因）", !/flex:none/.test(hint), hint);
t("源：.trend-hint 可收缩（flex:0 1 auto）", /flex:0 1 auto/.test(hint), hint);
t("源：.trend-hint 有 min-width:0（允许在自身内部折行）", /min-width:0/.test(hint), hint);

const summary = rule(src, ".trend-summary");
t("源：.trend-summary 也允许换行（极窄屏三项才不会被压成一列）", /flex-wrap:wrap/.test(summary), summary);

/* ---------- 2. 构建产物已同步 ----------
 * 首页走的是 css/home.bundle.css；只改源不 build，线上永远是旧样式。 */
t("bundle：已包含换行写法（改完记得跑 build-home-bundle）",
  /\.trend-bottom-row\{[^}]*flex-wrap:wrap/.test(bundle) || /trend-bottom-row\{[^}]*flex-wrap:wrap/.test(bundle));
t("bundle：hint 未回退成 flex:none",
  !/\.trend-hint\{[^}]*flex:none/.test(bundle));

/* ---------- 3. 结构前提：这三个块必须还在同一行容器里 ----------
 * 若有人把 hint 挪到别的容器（例如塞进卡片外），上面的 flex 规则就失效，
 * 但静态测试仍会绿——所以顺带确认 DOM 结构。 */
const home = read("home.html");
t("home.html：汇总与提示同在 .trend-bottom-row 内",
  /class="trend-bottom-row"[\s\S]{0,600}?id="trendHint"/.test(home));
t("home.html：汇总三项齐全（单 / 家 / 吨）",
  /id="trendWaybills"/.test(home) && /id="trendStores"/.test(home) && /id="trendWeight"/.test(home));

console.log(`首页趋势卡底排：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("\n失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
