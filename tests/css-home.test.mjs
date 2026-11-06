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

// 2) home.html 引用合并后的 home.bundle.css（P1-1f 四组件经 a4a26d96 聚合入 bundle，源文件仍各自存在）
const html = readFileSync(`${root}home.html`, "utf8");
assert.ok(html.includes("/css/home.bundle.css?v="),
  "home.html 的 home CSS 必须引用合并后的 /css/home.bundle.css");

// 3) 每段代表选择器齐全（覆盖 base / trend / dashboard / light）
const concat = NAMES.map((n) => readFileSync(`${root}css/${n}.css`, "utf8")).join("\n");
const reps = [
  ".home-app{",                 // base：App 壳
  ".task-card{",                // base：任务卡
  ".trend-card{",               // trend：配送趋势
  // 2026-10-29 底栏收编：底栏已从 home-dashboard.css 移入 css/ui-base.css（.zp-nav），
  // 首页与业务页共用同一份原语；此处不再断言该选择器，改由底栏专项断言覆盖。
  // 2026-10-29 UI 专项整治：light 段的纯颜色补丁（~50 条冷灰蓝字面量）已全部删除，
  // 该段现在只剩「明暗插图切换」这一条有实际职责的规则，代表选择器随之改为它。
  ':root[data-zp-theme="light"] .delivery-man{', // light：明暗插图切换
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

// 5) 2026-11-06 内容块=页面底（全局）：首页 bundle 里必须是最终值
//    首页不再单独覆盖，直接消费 ui-base / ui-theme 的令牌；这里做一次端到端确认，
//    防止「源文件改了但 bundle 没重建」或覆盖顺序被调乱后静默失效。
const bundleCss = readFileSync(`${root}css/home.bundle.css`, "utf8");
const baseCss = readFileSync(`${root}css/ui-base.css`, "utf8");
const themeCss = readFileSync(`${root}css/ui-theme.css`, "utf8");
assert.ok(/--zp-block:#FFFFFF/.test(baseCss), "浅色块色必须与页面底同色（#FFFFFF）");
/* 2026-11-06 三次调整：浅色与深色同一条规则 —— 内容块融进页面底、描边透明。
   上一版浅色留 #E4E4E4 会在满屏勾出表格感，深浅观感也对不上。 */
assert.ok(/--zp-card-edge:transparent/.test(baseCss), "浅色卡片描边必须也是 transparent（与深色一致，只靠间距与行线分组）");
assert.ok(/--zp-block-raised:#F3F3F3/.test(baseCss), "摘要块隆起色缺失：纯数字板块需要一块比白底深一档的底");
assert.ok(/--zp-block:#161616/.test(themeCss), "深色块色必须与页面底同色（#161616）");
assert.ok(/--zp-card-edge:transparent/.test(themeCss), "深色卡片描边必须透明（否则同色底上勾出空心框）");
assert.ok(/--zp-nav-bg:var\(--zp-surface\)/.test(themeCss), "深色浮岛必须取 --zp-surface，不能跟 --zp-block 一起融进背景");
assert.ok(/--zp-block-raised:#292929/.test(themeCss), "深色摘要块隆起色缺失（应对应浅色 #F3F3F3 的深色一档）");
assert.ok(bundleCss.includes("--zp-block:#161616") && bundleCss.includes("--zp-nav-bg:var(--zp-surface)"),
  "home.bundle.css 未包含最新令牌值，请运行 node scripts/build-home-bundle.mjs");
assert.ok(bundleCss.lastIndexOf("--zp-block:#FFFFFF") < bundleCss.indexOf("--zp-block:#161616"),
  "浅色块色必须定义在深色覆盖之前（同优先级后者胜）");

console.log("home CSS 组件化守卫：通过（4 组件 / 页面顺序 / 关键选择器齐全 / PostCSS 解析无误 / 块色=页面底令牌生效）");
