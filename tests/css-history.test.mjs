/**
 * history CSS 组件化守卫（node tests/css-history.test.mjs）
 * --------------------------------------------------------------
 * 守护 P1-1f 的拆分结果：css/history.css（694 行）按连续顺序切分为
 *   history-shell → history-list → history-nav → history-overlays
 * 2026-10-29 UI 专项整治：history-light / history-overlay-light 两个「浅色覆盖」
 * 文件的补丁（约 60 条冷灰蓝字面量）全部删除，前者已空、后者只剩两条布局规则
 * 并已并入 history-overlays，故组件数由 6 降为 4，守卫同步收敛。
 * 守卫固守：
 *   1) 四组件文件均存在、非空；
 *   2) history.html 按序引用全部四组件（顺序即层叠顺序）；
 *   3) 每段的代表选择器都在拼接结果中（无段落丢失）；
 *   4) 四组件顺序拼接经 PostCSS 解析无语法错误。
 * 说明：原文件本身对同一选择器多次重定义（如 .history-state / .history-list 的 UI 2.3 重写），
 *      故跨文件同名选择器是预期的层叠覆盖，非错误；等价性由拆分脚本逐字节断言保证。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import postcss from "postcss";

const root = fileURLToPath(new URL("..", import.meta.url));
const NAMES = ["history-shell", "history-list", "history-nav", "history-overlays"];

// 1) 文件存在 + 非空
for (const n of NAMES) {
  const p = `${root}css/${n}.css`;
  assert.ok(existsSync(p), `缺少组件文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `组件为空：${n}`);
}

// 2) history.html 按序引用四组件
const html = readFileSync(`${root}pages/history.html`, "utf8");
const refs = [...html.matchAll(/\/css\/(history-[a-z-]+)\.css\?v=[0-9a-f]+/g)].map((m) => m[1]);
assert.deepStrictEqual(refs, NAMES,
  `history.html 的 history CSS 引用顺序必须是 ${NAMES.join("→")}（实际 ${refs.join("→")}）`);

// 3) 每段代表选择器齐全
const concat = NAMES.map((n) => readFileSync(`${root}css/${n}.css`, "utf8")).join("\n");
const reps = [
  // 2026-10-29 外壳收编：.history-shell 只作命名空间，尺寸由 main.zp-shell 声明；
  // 代表选择器改用它仍在承担的顶栏规则。
  ".history-shell .topbar{",               // shell：顶栏
  ".history-swipe-row{",                   // shell：滑动行
  ".history-delete{",                      // shell：滑动删除动作条
  ".history-picker{",                      // shell：日历选择器
  ".history-dialog{",                      // shell：确认弹窗
  ".history-count-highlight{",             // shell：同日多次派送高亮
  ".history-list{",                        // list：UI 2.3 成熟列表重写
  ".history-shell .app-back{",             // nav：返回键统一
  ".history-trash-item{",                  // overlays：回收站
  ".history-date-button{",                 // overlays：日期入口（原 overlay-light 合流）
  ".history-lookup-card{",                 // overlays：客户快查结果卡
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
assert.ok(parsed, "history 六组件顺序拼接必须是合法 CSS（拆分无语法裂痕）");

console.log("history CSS 组件化守卫：通过（4 组件 / 页面顺序 / 关键选择器齐全 / PostCSS 解析无误）");
