/* 数据中心列表手势：右滑绝不删门店（2026-11-05 回归）
 * ------------------------------------------------------------------
 * 起因：右滑分支原本执行「把该行加进隐藏集合 + render()」，而隐藏类
 * 是 display:none —— 手指一划门店就没了，没有二次确认、没有撤销，
 * 且 PUT /api/base 提交的仍是完整 stores，保存后门店又回来。
 * 这里锁死修复后的三条契约：
 *   1) 手势只负责露出/收起动作条，绝不改数据；
 *   2) 删除只有「动作条按钮 + zpConfirm 确认」一条路；
 *   3) 提交的一直是完整 stores，不存在「视觉删除」这种中间态。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "pages/data.html"), "utf8");
const css = readFileSync(resolve(root, "css/data.css"), "utf8");

/* 1. 隐藏状态链彻底下线：变量、隐藏类、CSS 死规则都不许回来 */
assert.ok(!html.includes("hiddenIndexes"), "不得再出现 hiddenIndexes 隐藏集合");
assert.ok(!html.includes("data-store-hidden"), "不得再渲染 data-store-hidden 类");
assert.ok(!css.includes(".data-store-hidden"), "css/data.css 里的隐藏死规则应删除");

/* 2. 手势段：只碰 class，不碰数据 */
const swipe = html.slice(html.indexOf("function bindTouch()"), html.indexOf('$("stores").addEventListener("click"'));
assert.ok(swipe.length > 400, "应能截取到 bindTouch 手势段");
assert.ok(!/hiddenIndexes|data-store-hidden|display\s*:\s*none/.test(swipe), "手势段不得含任何隐藏/抹除行的逻辑");
assert.ok(!/stores\.splice|\brender\(\)/.test(swipe), "手势段不得删除数据或重建列表");
assert.ok(swipe.includes('t.locked===null'), "方向锁定：先到 6px 即定性 X/Y");
assert.ok(swipe.includes('locked!=="x"'), "方向锁定：纵向滚动不得触发左右滑判定");
assert.ok(swipe.includes('addEventListener("touchcancel"'), "手势被系统取消也要归位");
assert.ok(swipe.includes("closeSwipeRows()"), "右滑统一收起已展开的动作条");
assert.ok(swipe.includes('if(dx<0)row.classList.add("data-swipe-open")'), "左滑只露出编辑/删除动作条");
/* dx>0 那一侧不许再挂任何 else 分支去做数据变更 */
const tail = swipe.slice(swipe.indexOf("closeSwipeRows()"));
assert.ok(!/else\s*\{/.test(tail), "右滑不得再走另一条改数据的分支");

/* 3. 删除：按钮 → 二次确认 → 才 splice */
const click = html.slice(html.indexOf('$("stores").addEventListener("click"'), html.indexOf("bindTouch();"));
assert.ok(click.includes('askConfirm("删除门店"'), "删除必须弹二次确认");
assert.ok(click.includes("if(!ok)return"), "取消确认时不得删");
assert.ok(click.indexOf("askConfirm(") < click.indexOf("stores.splice("), "确认必须先于删除动作");

/* 4. 提交完整 stores：杜绝「界面上没了、库里还在」的中间态 */
assert.ok(
  /method:"PUT"[\s\S]{0,500}JSON\.stringify\(\{routeId,expectedVersion:baseVersion,stores\}\)/.test(html),
  "提交更新应始终提交完整 stores"
);

/* 5. 列表仍可正常纵向滚动（方向锁定不能把滚动吃掉） */
assert.ok(/\.data-store-row\{touch-action:pan-y/.test(css), "门店行应保留 touch-action:pan-y");

console.log("数据中心右滑不删门店 / 删除必须二次确认：静态契约通过");
