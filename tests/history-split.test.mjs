/**
 * history.js 模块化守卫（node tests/history-split.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-1g 的拆分结果：functions/api/history.js（392 行）按职责切分为
 *   _history-range.js    日期/范围工具（含 13 个月滚动窗口语义）
 *   _history-read.js     读取族（readWaybills/readDateWaybillsBatch/
 *                        readDayAggregates/readDates/enrichFactory，共享 Budget）
 *   _history-delete.js   删除族（回收站软删除，顺序契约可重试）
 *   history.js           入口：historyGet/historyDelete + re-export 原公开面
 * 守卫固守：
 *   1) 三模块存在、非空；
 *   2) 入口 re-export 的公开面 == 拆分前（10 命名 export + onRequestGet/Delete）；
 *   3) 入口与各模块的 import 均能在目标模块找到 export（无断链、无重复声明）；
 *   4) 运行时：historyRange/validDate 纯函数行为 + 路由处理函数在位。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const API = `${root}functions/api/`;
const ENTRY = API + "history.js";
const MODULES = {
  range: API + "_history-range.js",
  read: API + "_history-read.js",
  delete: API + "_history-delete.js",
};

// 拆分前公开面：history-export.js / history-lookup.js 依赖 + 路由入口
const PUBLIC_NAMED = [
  "clean", "historyRange", "validDate", "inRange", "monthInRange",
  "readWaybills", "readDateWaybillsBatch", "readDayAggregates", "readDates", "enrichFactory",
];

// 1) 三模块存在 + 非空
for (const [name, p] of Object.entries(MODULES)) {
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `模块为空：${name}`);
}

// 2) 入口公开面完整
const entry = readFileSync(ENTRY, "utf8");
for (const n of PUBLIC_NAMED) {
  assert.match(entry, new RegExp(`export \\{[^}]*\\b${n}\\b`), `入口未转发 export：${n}`);
}
assert.match(entry, /export const onRequestGet = guard\(historyGet/, "入口缺少 onRequestGet");
assert.match(entry, /export const onRequestDelete = guard\(historyDelete/, "入口缺少 onRequestDelete");

// 3) import 不断链 + 无重复 import 同名（防 SyntaxError: Identifier already declared）
const files = { entry, ...Object.fromEntries(Object.entries(MODULES).map(([k, p]) => [k, readFileSync(p, "utf8")])) };
const seen = new Map();
for (const [label, src] of Object.entries(files)) {
  const importRe = /import \{([^}]+)\} from "(\.[^"]+)";/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const key = label + "::" + n;
      assert.ok(!seen.has(key), `${label} 重复 import：${n}（会触发 Identifier already declared）`);
      seen.set(key, true);
      // 目标模块（本拆分层内）必须提供该 export
      const target = m[2].replace(/^\.\//, "").replace(/^\.\.\//, "");
      const local = { "_history-range.js": MODULES.range, "_history-read.js": MODULES.read, "_history-delete.js": MODULES.delete }[target];
      if (local) {
        assert.match(readFileSync(local, "utf8"),
          new RegExp(`^export (?:const|let|var|async function|function) ${n}\\b`, "m"),
          `${label} import 的 ${n} 在 ${target} 中无对应 export（断链）`);
      }
    }
  }
}

// 4) 运行时：纯函数行为 + 路由处理在位
const mod = await import(pathToFileURL(ENTRY).href);
assert.strictEqual(typeof mod.onRequestGet, "function");
assert.strictEqual(typeof mod.onRequestDelete, "function");
// historyRange：13 个月滚动窗口，止于次月末（语义不可篡改）
const r = mod.historyRange("2026-10-22", undefined);
assert.strictEqual(r.months, 13);
assert.strictEqual(r.end, "2026-11-30");
assert.match(r.start, /^\d{4}-\d{2}-01$/);
// validDate / inRange / monthInRange 行为
assert.strictEqual(mod.validDate("2026-02-30"), false, "2 月 30 日必须判无效");
assert.strictEqual(mod.validDate("2026-10-22"), true);
assert.strictEqual(mod.inRange("2026-10-22", r), true);
assert.strictEqual(mod.monthInRange("2026-11", r), true);
// clean 语义
assert.strictEqual(mod.clean("  x  "), "x");

console.log("✅ history 四拆守卫通过（3 模块 / 公开面完整 / import 无断链无重复 / 行为正确）");
