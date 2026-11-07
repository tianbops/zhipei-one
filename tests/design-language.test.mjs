/**
 * 全局设计语言契约（node tests/design-language.test.mjs）
 * ------------------------------------------------------------------
 * 2026-11-08 合并前核查：把「说好的一套」变成可执行不变量，避免下次又分叉。
 *
 *  1) 令牌闭环：组件层 var(--zp-*) 引用的令牌必须在 :root 里定义过。
 *     历史事故：--zp-fw-normal / --zp-fs-10 被使用但从未定义，属性静默失效
 *     （字重掉回继承、字号掉回默认），肉眼几乎看不出来。
 *     例外：运行时变量（--zp-ceiling-h 由 JS 写）与带 fallback 的可选覆盖。
 *
 *  2) 列表行细线只用一支令牌：--zp-divider。
 *     首页 / 数据 / 历史 / 运单详情的「列表行」必须同色同重；
 *     容器描边仍可用 --zp-line / --zp-tint，语义不同不混用。
 *
 *  3) 已删除的结构不得回流：让位块（#zpHeadSpacer）、--zp-head-inset、
 *     .is-dragging、commitSpacer/need（旧手势模型）、.data-alias-*（别名 UI）、
 *     .order-menu（无人引用的分组选择器）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const rd = p => readFileSync(path.join(root, p), "utf8");
const CSS_FILES = readdirSync(path.join(root, "css"))
  .filter(f => f.endsWith(".css") && !f.includes("bundle"))
  .map(f => "css/" + f);
const HTML_FILES = [];
for (const d of [".", "pages"]) {
  for (const e of readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) HTML_FILES.push(d === "." ? e.name : d + "/" + e.name);
  }
}

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " | " + detail : "")); }
};

console.log("一、令牌闭环（引用即定义）");
{
  const defined = new Set();
  for (const f of CSS_FILES) {
    for (const m of rd(f).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  }
  /* 运行时变量：由 JS 写进 style，CSS 侧只读 */
  const RUNTIME = new Set(["--zp-ceiling-h"]);
  const bad = [];
  for (const f of [...CSS_FILES, ...HTML_FILES]) {
    const src = rd(f);
    for (const m of src.matchAll(/var\((--zp-[\w-]+)\s*(,)?/g)) {
      const name = m[1];
      if (defined.has(name) || RUNTIME.has(name)) continue;
      if (m[2]) continue;              /* 带 fallback 的可选覆盖，允许 */
      bad.push(f + " → " + name);
    }
  }
  t("所有 var(--zp-*) 都有定义（无 fallback 的才算）", bad.length === 0, bad.slice(0, 6).join(" | "));
}

console.log("\n二、列表行细线统一到 --zp-divider");
{
  const HOME = rd("css/home-dashboard.css");
  const ruleOf = (src, sel) => {
    const i = src.indexOf(sel + "{");
    return i < 0 ? "" : src.slice(i + sel.length + 1, src.indexOf("}", i));
  };
  const checks = [
    ["首页门店列表上边", ruleOf(HOME, ".today-store-list"), /border-top:1px solid var\(--zp-divider\)/],
    ["首页门店行下边", ruleOf(HOME, ".today-store-row"), /border-bottom:1px solid var\(--zp-divider\)/],
    ["首页统计区上边", ruleOf(HOME, ".today-metrics"), /border-top:1px solid var\(--zp-divider\)/],
    ["运单详情门店行", ruleOf(rd("css/order_detail.css"), ".order-store-item"), /border-bottom:1px solid var\(--zp-divider\)/],
    ["运单详情待处理行", ruleOf(rd("css/order_detail.css"), ".pending-box"), /border-bottom:1px solid var\(--zp-divider\)/],
    ["数据资料门店行", ruleOf(rd("css/data.css"), ".data-store-row"), /border-bottom:1px solid var\(--zp-divider\)/],
    ["历史列表行", ruleOf(rd("css/history-list.css"), ".history-swipe-row"), /border-bottom:1px solid var\(--zp-divider\)/],
  ];
  for (const [label, body, re] of checks) t(label + " = --zp-divider", !!body && re.test(body), body.slice(0, 80));
  t("首页列表区不再用 --zp-tint 画行线（tint 只做按压底 / 容器描边）",
    !/\.today-store-row\{[^}]*border-bottom:1px solid var\(--zp-tint\)/.test(HOME));
}

console.log("\n三、已删除的结构不得回流");
{
  const home = rd("home.html");
  const strip = src => src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const all = [home, rd("js/home/head-float.js"), rd("css/home-dashboard.css"), rd("css/data.css"), rd("css/ui-overlay.css")]
    .map(strip).join("\n");
  t("首页无让位块节点 / 类 / 变量（纯 overlay）",
    !/zpHeadSpacer|zp-head-spacer|--zp-head-inset/.test(all));
  t("无旧手势模型残留（.is-dragging / commitSpacer( / need 变量）",
    !/is-dragging|commitSpacer\(|\bneed\s*=/.test(all));
  t("无别名 UI 死样式（.data-alias-*）", !/data-alias/.test(all));
  t("无无人引用的 .order-menu 选择器", !/\.order-menu/.test(rd("css/ui-overlay.css")));
}

console.log("\n" + (fail ? "❌ 设计语言契约：通过 " + pass + " 项，失败 " + fail + " 项" : "✅ 设计语言契约：通过 " + pass + " 项，失败 0 项"));
process.exit(fail ? 1 : 0);
