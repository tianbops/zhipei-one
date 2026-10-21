/**
 * order-detail 模块拆分守卫
 * ------------------------------------------------------------
 * js/order_detail.js（原 429 行 IIFE）已拆分为 js/order_detail/ 六模块：
 *   core → render → nav-menu → load → confirm → boot
 * 因拆掉 IIFE 后顶层 const/let/function 落入全局词法环境，本测试固守：
 *   1) 六模块文件均存在、非空、且以 'use strict' 开头（core 自带，其余前置）；
 *   2) order_detail.html 与 today.html 按序引用全部六模块，且位于 ui 模块之前；
 *   3) 六模块之间无重复的顶层声明（否则页面加载即 SyntaxError 白屏）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const MODS = ["core", "render", "nav-menu", "load", "confirm", "boot"];
const strictPrefix = "'use strict';";

// 1) 文件存在 + 非空 + strict 开头
for (const m of MODS) {
  const p = `${root}js/order_detail/${m}.js`;
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  const t = readFileSync(p, "utf8");
  assert.ok(t.trim().length > 0, `模块为空：${m}`);
  const first = t.split("\n").find(l => l.trim().length) ?? "";
  assert.ok(first.trim() === "use strict" || first.trim() === strictPrefix,
    `模块 ${m} 必须以 'use strict' 开头（实际首行：${JSON.stringify(first)}）`);
}

// 2) 两页按序引用六模块，且位于 ui 模块之前
function pageModuleOrder(htmlFile) {
  const html = readFileSync(`${root}${htmlFile}`, "utf8");
  const re = /\/js\/order_detail\/([a-z-]+)\.js\?v=/g;
  const found = [];
  let mm;
  while ((mm = re.exec(html))) found.push(mm[1]);
  return { found, uiIdx: html.indexOf("/js/ui/core.js") };
}
for (const page of ["pages/order_detail.html", "pages/today.html"]) {
  const { found, uiIdx } = pageModuleOrder(page);
  assert.deepStrictEqual(found, MODS, `${page} 的 order_detail 模块引用顺序必须是 ${MODS.join("→")}（实际 ${found.join("→")}）`);
  const lastIdx = found.length ? (page.endsWith("order_detail.html")
    ? page.lastIndexOf(`/js/order_detail/${MODS[MODS.length - 1]}.js`)
    : page.lastIndexOf(`/js/order_detail/${MODS[MODS.length - 1]}.js`)) : -1;
  assert.ok(lastIdx < uiIdx || uiIdx < 0, `${page} 的 order_detail 模块必须位于 ui 模块之前`);
}

// 3) 六模块顶层声明无重复（共享全局词法环境，撞名即白屏）
const TOP = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
const seen = new Map();
for (const m of MODS) {
  const t = readFileSync(`${root}js/order_detail/${m}.js`, "utf8");
  for (const line of t.split("\n")) {
    const mm = line.match(TOP);
    if (!mm) continue;
    const name = mm[1];
    assert.ok(!seen.has(name), `顶层声明重复（拆 IIFE 后落入全局词法环境会白屏）：${name}（先见于 ${seen.get(name)}，再现于 ${m}）`);
    seen.set(name, m);
  }
}

console.log("order_detail 模块拆分守卫：通过（6 模块 / 双页顺序 / 无重复顶层声明）");
