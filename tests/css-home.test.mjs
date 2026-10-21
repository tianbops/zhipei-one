/**
 * home CSS 组件化守卫（node tests/css-home.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-1f 的拆分结果：css/home.css（404 行）按连续顺序切分为
 *   home-base → home-trend → home-dashboard → home-light
 * 因 CSS 层叠只依赖「文档中出现顺序」，守卫固守：
 *   1) 四组件文件均存在、非空；
 *   2) home.html 按序引用全部四组件（顺序即层叠顺序）；
 *   3) 每段的代表选择器都在拼接结果中（无段落丢失）；
 *   4) 四组件顺序拼接经 PostCSS 解析无语法错误（拆分零裂痕）。
 * 注：跨文件出现同名选择器是预期现象（原文件本身对同一选择器多次重定义做层叠覆盖），
 *     故不把「跨文件重复」视为错误；等价性由拆分脚本的「逐字节拼接 == 原文件」保证。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import postcss from "postcss";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAMES = ["home-base", "home-trend", "home-dashboard", "home-light"];

// 1) 文件存在 + 非空
for (const n of NAMES) {
  const p = `${root}css/${n}.css`;
  assert.ok(existsSync(p), `缺少组件文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `组件为空：${n}`);
}

// 2) home.html 按序引用四组件
const html = readFileSync(`${root}home.html`, "utf8");
const refs = [...html.matchAll(/\/css\/(home-[a-z]+)\.css\?v=[0-9a-f]+/g)].map((m) => m[1]);
assert.deepStrictEqual(refs, NAMES,
  `home.html 的 home CSS 引用顺序必须是 ${NAMES.join("→")}（实际 ${refs.join("→")}）`);

// 3) 每段代表选择器齐全（覆盖 base / trend / dashboard / light）
const concat = NAMES.map((n) => readFileSync(`${root}css/${n}.css`, "utf8")).join("\n");
const reps = [
  ".home-app{",                 // base：App 壳
  ".task-card{",                // base：任务卡
  ".trend-card{",               // trend：配送趋势
  ".bottom-nav{",               // dashboard：底部导航
  "body.sheet-open .bottom-nav",// dashboard：上传弹层置顶
  ':root[data-zp-theme="light"] .bottom-nav{', // light：浅色导航
];
for (const sel of reps) {
  assert.ok(concat.includes(sel), `拆分后缺失代表选择器（段落丢失）：${sel}`);
}

// 4) 顺序拼接经 PostCSS 解析无语法错误
let parsed = false;
try {
  postcss.parse(concat);
  parsed = true;
} catch (e) {
  console.error("PostCSS 解析失败：", e.message);
}
assert.ok(parsed, "home 四组件顺序拼接必须是合法 CSS（拆分无语法裂痕）");

console.log("home CSS 组件化守卫：通过（4 组件 / 页面顺序 / 关键选择器齐全 / PostCSS 解析无误）");
