/**
 * 浮岛毛玻璃材质契约（2026-11-05 用户需求：参考 Shadowrocket 重做浮岛观感，
 * 「不能变现有颜色」「不改变底部按钮架构」）
 * ------------------------------------------------------------------
 * 运行：node tests/nav-glass-token.test.mjs
 *
 * 这次改造只允许动「材质」：圆角、投影、模糊、透明度。任何一处颜色偏移都算违约。
 * 本测试把「材质升级但配色不动」写成可执行的断言，防止后续顺手调色：
 *
 *   1) 玻璃底色的 RGB 必须**恒等于**该主题的 --zp-nav-bg 解析值
 *      （浅 #FFFFFF / 深 #292929），只允许 alpha 不同 —— 这就是「不变颜色」的字面含义；
 *   2) 导航文字 / 选中态 / 主色两套主题取值一个都不能变；
 *   3) 回退链必须是「先不透明底、后玻璃底」，旧 WebView 拿到的应等于改造前；
 *   4) backdrop-filter 必须真的在 .zp-nav 上（只有 alpha 没有模糊 = 半透明脏底）；
 *   5) 加号投影的主色扩散必须由 --zp-primary 预计算（RGB 相等），不许新起色相。
 *
 * 为什么不用颜色混合函数自动派生：安卓旧 WebView 不支持，
 * tests/theme-token-discipline 已把它列为兼容地板硬禁。所以颜色以 rgba 字面量
 * 固写在令牌层，由本测试守住它和底色/主色的一致性。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = readFileSync(fileURLToPath(new URL("../css/ui-base.css", import.meta.url)), "utf8");
const THEME = readFileSync(fileURLToPath(new URL("../css/ui-theme.css", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ---- 取值辅助：只在第一个 :root（浅色基底）与深色主题块里找，避免命中组件层 ---- */
function rootBlock(css) {
  const i = css.indexOf(":root{");
  const j = css.indexOf("}", i);
  return css.slice(i, j);
}
function darkBlock(css) {
  const i = css.indexOf(':root[data-zp-theme="dark"]');
  const j = css.indexOf("\n}", i);
  return css.slice(i, j);
}
const LIGHT = rootBlock(BASE);
const DARK = darkBlock(THEME);

const pickHex = (block, name) => {
  const m = block.match(new RegExp("--" + name + "\\s*:\\s*(#[0-9A-Fa-f]{6})"));
  return m ? m[1].toUpperCase() : null;
};
const pickRgba = (block, name) => {
  const m = block.match(new RegExp("--" + name + "\\s*:\\s*rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([\\d.]+)\\s*\\)"));
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: +m[4], raw: m[0] } : null;
};
const hexToRgb = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

/* ============ 一、玻璃底色 = 导航底色（只差 alpha） ============ */
console.log("一、玻璃底色必须是导航底色的同色半透明 (7 条)");
{
  const surface = pickHex(LIGHT, "zp-surface");
  const glass = pickRgba(LIGHT, "zp-nav-glass");
  t("浅色 --zp-surface 可解析", !!surface, String(surface));
  t("浅色 --zp-nav-glass 是 rgba 字面量（不依赖颜色混合函数）", !!glass, glass && glass.raw);
  const srgb = surface ? hexToRgb(surface) : null;
  t("浅色玻璃 RGB = 导航底色 RGB（#FFFFFF）",
    !!glass && !!srgb && glass.r === srgb.r && glass.g === srgb.g && glass.b === srgb.b,
    glass && srgb ? `${glass.r},${glass.g},${glass.b} vs ${srgb.r},${srgb.g},${srgb.b}` : "解析失败");
  t("浅色玻璃 alpha 在 .80~.92（透出内容但不糊成一片）",
    !!glass && glass.a >= 0.8 && glass.a <= 0.92, glass && String(glass.a));

  const block = pickHex(DARK, "zp-block");
  const dglass = pickRgba(DARK, "zp-nav-glass");
  t("深色 --zp-block 可解析", !!block, String(block));
  const brgb = block ? hexToRgb(block) : null;
  t("深色玻璃 RGB = 导航底色 RGB（#292929）",
    !!dglass && !!brgb && dglass.r === brgb.r && dglass.g === brgb.g && dglass.b === brgb.b,
    dglass && brgb ? `${dglass.r},${dglass.g},${dglass.b} vs ${brgb.r},${brgb.g},${brgb.b}` : "解析失败");
  t("深色玻璃 alpha 在 .72~.88（比浅色更透一档，才看得出是浮层）",
    !!dglass && dglass.a >= 0.72 && dglass.a <= 0.88, dglass && String(dglass.a));
}

/* ============ 二、配色零改动 ============ */
console.log("\n二、导航配色与主色取值零改动 (5 条)");
{
  t("浅色文字 #666666 未变", pickHex(LIGHT, "zp-nav-text") === "#666666");
  t("浅色选中文字 #000000 未变", pickHex(LIGHT, "zp-nav-text-active") === "#000000");
  t("浅色按压底 #F3F3F3 未变", pickHex(LIGHT, "zp-nav-active-bg") === "#F3F3F3");
  t("深色文字 #A3A3A3 / 选中 #FFFFFF 未变",
    pickHex(DARK, "zp-nav-text") === "#A3A3A3" && pickHex(DARK, "zp-nav-text-active") === "#FFFFFF");
  t("主色两主题同值 #2C6CE2（换主题不换蓝）",
    pickHex(LIGHT, "zp-primary") === "#2C6CE2" && pickHex(DARK, "zp-primary") === "#2C6CE2");
}

/* ============ 三、组件层：回退链与真模糊 ============ */
console.log("\n三、组件层回退链与 backdrop-filter (4 条)");
{
  const nav = BASE.slice(BASE.indexOf(".zp-nav{"), BASE.indexOf(".zp-nav-item{"));
  t("先声明不透明底 var(--zp-nav-bg)（旧 WebView 回退 = 改造前）",
    /background:var\(--zp-nav-bg\)/.test(nav));
  t("随后声明 var(--zp-nav-glass)（支持 alpha 的浏览器才用玻璃）",
    /background:var\(--zp-nav-glass\)/.test(nav));
  t("回退在前、玻璃在后（顺序不能反，否则回退覆盖玻璃）",
    nav.indexOf("background:var(--zp-nav-bg)") < nav.indexOf("background:var(--zp-nav-glass)"));
  t("backdrop-filter 真的在 .zp-nav 上且含 blur（只有 alpha 没模糊 = 脏底）",
    /backdrop-filter:blur\(\d+px\)/.test(nav) && /-webkit-backdrop-filter:blur\(\d+px\)/.test(nav),
    (nav.match(/backdrop-filter:[^;]+/) || [])[0]);
}

/* ============ 四、加号投影不引入新色相 ============ */
console.log("\n四、加号投影的主色扩散 (2 条)");
{
  const glow = pickRgba(LIGHT, "zp-nav-plus-shadow");
  const primary = hexToRgb(pickHex(LIGHT, "zp-primary"));
  const inShadow = LIGHT.match(/--zp-nav-plus-shadow:[\s\S]*?;/)[0];
  const hit = [...inShadow.matchAll(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)/g)]
    .map((m) => ({ r: +m[1], g: +m[2], b: +m[3] }))
    .find((c) => Math.abs(c.r - primary.r) + Math.abs(c.g - primary.g) + Math.abs(c.b - primary.b) < 6);
  t("加号投影里有一层 RGB ≈ --zp-primary(#2C6CE2) 的主色扩散", !!hit, JSON.stringify(hit));
  t("浅/深两套都定义了 --zp-nav-plus-shadow（深色单独压白高光）",
    /--zp-nav-plus-shadow:/.test(LIGHT) && /--zp-nav-plus-shadow:/.test(DARK));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { for (const f of failures) console.log("  - " + f); process.exit(1); }
