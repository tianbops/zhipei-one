/**
 * _consistency.js 模块化守卫（node tests/consistency-split.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-1g：functions/api/waybills/_consistency.js（452 行）拆为
 *   _consistency-common.js  共享 helper（键前缀/日期口径/预算迭代上限/isReadable/inScopeOfId）
 *   _consistency-scan.js    只读扫描（scanConsistency）
 *   _consistency-repair.js  安全修复（repairConsistency）
 *   _consistency.js         入口：re-export 双函数 + default（diagnostic.js 契约不变）
 * 守卫固守：三模块存在非空 + 入口只做转发且契约完整 + import 无断链。
 * 行为等价由 4 个集成套件背书（consistency-budget / fingerprint-drift /
 * index-date-repair / waybill-consistency，共 81 项断言）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const WB = `${root}functions/api/waybills/`;
const ENTRY = WB + "_consistency.js";
const MODULES = {
  common: WB + "_consistency-common.js",
  scan: WB + "_consistency-scan.js",
  repair: WB + "_consistency-repair.js",
};

// 1) 三模块存在 + 非空
for (const [name, p] of Object.entries(MODULES)) {
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `模块为空：${name}`);
}

// 2) 入口只做转发 + 契约完整（diagnostic.js：scanConsistency / repairConsistency / default）
const entry = readFileSync(ENTRY, "utf8");
assert.match(entry, /export \{scanConsistency, repairConsistency\};/, "入口缺少双函数 export");
assert.match(entry, /export default \{scanConsistency, repairConsistency\};/, "入口 default 形状被改");
assert.doesNotMatch(entry, /^(export )?(const|let|var|function|class) \w/m,
  "入口只能是 re-export，不得再出现实现声明");
// scan/repair 实现确实在兄弟模块
assert.match(readFileSync(MODULES.scan, "utf8"), /export async function scanConsistency\(/);
assert.match(readFileSync(MODULES.repair, "utf8"), /export async function repairConsistency\(/);

// 3) import 无断链：scan 从 common import 的每个名字都有 export
const scan = readFileSync(MODULES.scan, "utf8");
const importRe = /import \{([^}]+)\} from "\.\/(_consistency-common)\.js";/g;
let m;
while ((m = importRe.exec(scan)) !== null) {
  const common = readFileSync(MODULES.common, "utf8");
  for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
    assert.match(common, new RegExp(`^export (?:const|let|var|function) ${n}\\b`, "m"),
      `scan import 的 ${n} 在 common 中无对应 export（断链）`);
  }
}

// 4) 运行时：双函数在位且 default 形状正确
const mod = await import(pathToFileURL(ENTRY).href);
assert.strictEqual(typeof mod.scanConsistency, "function");
assert.strictEqual(typeof mod.repairConsistency, "function");
assert.deepStrictEqual(Object.keys(mod.default).sort(), ["repairConsistency", "scanConsistency"]);

console.log("✅ consistency 四拆守卫通过（3 模块 / 入口只转发 / 契约完整 / import 无断链）");
