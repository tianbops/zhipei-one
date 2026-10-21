/**
 * history 模块拆分守卫
 * ------------------------------------------------------------
 * js/history.js（原 129 行 IIFE）已拆分为 js/history/ 四模块：
 *   core → render → data → overlay
 * 因拆掉 IIFE 后顶层 const/let/function 落入全局词法环境，本测试固守：
 *   1) 四模块文件均存在、非空、且以 use strict 开头（core 双引号、其余单引号）；
 *   2) history.html 按序引用全部四模块，且位于 ui 模块之前；
 *   3) 四模块之间无重复的顶层声明（否则页面加载即 SyntaxError 白屏）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const MODS = ["core", "render", "data", "overlay"];

// 1) 文件存在 + 非空 + use strict 开头（兼容双/单引号）
for (const m of MODS) {
  const p = `${root}js/history/${m}.js`;
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  const t = readFileSync(p, "utf8");
  assert.ok(t.trim().length > 0, `模块为空：${m}`);
  const first = (t.split("\n").find((l) => l.trim().length) ?? "").trim();
  assert.ok(first === '"use strict";' || first === "'use strict';",
    `模块 ${m} 必须以 use strict 开头（实际首行：${JSON.stringify(first)}）`);
}

// 2) history.html 按序引用四模块，且位于 ui 模块之前
const html = readFileSync(`${root}pages/history.html`, "utf8");
const re = /\/js\/history\/([a-z]+)\.js\?v=/g;
const found = [];
let mm;
while ((mm = re.exec(html))) found.push(mm[1]);
assert.deepStrictEqual(found, MODS,
  `history.html 的 history 模块引用顺序必须是 ${MODS.join("→")}（实际 ${found.join("→")}）`);
const lastIdx = html.lastIndexOf(`/js/history/${MODS[MODS.length - 1]}.js`);
const uiIdx = html.indexOf("/js/ui/core.js");
assert.ok(lastIdx < uiIdx || uiIdx < 0, "history 模块必须位于 ui 模块之前");

// 3) 四模块顶层声明无重复（共享全局词法环境，撞名即白屏）
const TOP = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
const seen = new Map();
for (const m of MODS) {
  const t = readFileSync(`${root}js/history/${m}.js`, "utf8");
  for (const line of t.split("\n")) {
    const m2 = line.match(TOP);
    if (!m2) continue;
    const name = m2[1];
    assert.ok(!seen.has(name),
      `顶层声明重复（拆 IIFE 后落入全局词法环境会白屏）：${name}（先见于 ${seen.get(name)}，再现于 ${m}）`);
    seen.set(name, m);
  }
}

console.log("history 模块拆分守卫：通过（4 模块 / 页面顺序 / 无重复顶层声明）");
