/**
 * 门店匹配引擎模块化守卫（node tests/store-match-modules.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-1g 的拆分结果：functions/api/waybills/_store-match.js（579 行）
 * 按职责切分为三兄弟模块（均为 `_` 前缀，不参与 Pages Functions 路由）：
 *   _store-match-normalize.js    第 0/1 层：格式归一（clean/formatCompareKey/…）
 *   _store-match-similarity.js   第 2 层：基础相似度（editDistance/ngramSim/…）
 *   _store-match-engine.js       第 3/4/5 层：评分 + 守门 + 对外主入口
 * 入口 _store-match.js 只做 re-export，公开面与拆分前逐一对应。
 * 守卫固守：
 *   1) 三模块存在、非空；
 *   2) 入口 re-export 的公开面 == 拆分前公开面（10 个命名 export + default）；
 *   3) 引擎层的 import 均能在源模块中找到对应 export（无断链）；
 *   4) 运行时动态 import 入口：公开面类型正确 + 行为冒烟（匹配/守门/置信差）。
 * 注：字节级等价（各模块去头部 == 原文件行切片）由拆分脚本断言，
 *     本测试守「结构不回归 + 行为不回归」。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const WB = `${root}functions/api/waybills/`;
const ENTRY = WB + "_store-match.js";
const MODULES = {
  normalize: WB + "_store-match-normalize.js",
  similarity: WB + "_store-match-similarity.js",
  engine: WB + "_store-match-engine.js",
};

// 拆分前的公开面（与原文件 export 清单一致，process.js / store-learn.js / 测试依赖）
const PUBLIC_EXPORTS = [
  "clean", "formatCompareKey", "businessStoreCode", "normalizeForMatch",
  "editDistance", "scoreNames", "MATCH_CONFIG", "evaluate", "matchOne", "matchStores",
];

// 1) 三模块存在 + 非空
for (const [name, p] of Object.entries(MODULES)) {
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `模块为空：${name}`);
}

// 2) 入口 re-export 公开面完整（且不含实现细节泄漏）
const entry = readFileSync(ENTRY, "utf8");
for (const name of PUBLIC_EXPORTS) {
  assert.match(entry, new RegExp(`export \\{[^}]*\\b${name}\\b`),
    `入口未转发公开 export：${name}`);
}
assert.match(entry, /export \{default\} from "\.\/_store-match-engine\.js"/,
  "入口必须转发 default export");
assert.match(entry, /from "\.\/_store-match-normalize\.js"/, "入口应转发 normalize 模块");
assert.match(entry, /from "\.\/_store-match-similarity\.js"/, "入口应转发 similarity 模块");
// 入口不得再含实现（只做转发）——防止有人把逻辑搬回入口破坏拆分
assert.doesNotMatch(entry, /^(export )?(const|let|var|function|class) \w/m,
  "入口只能是 re-export，不得再出现实现声明");

// 3) 引擎层 import 的每个名字都能在源模块 export 清单中找到（无断链）
const engine = readFileSync(MODULES.engine, "utf8");
const importRe = /import \{([^}]+)\} from "\.\/(_store-match-\w+)\.js";/g;
let m;
while ((m = importRe.exec(engine)) !== null) {
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  const src = readFileSync(WB + m[2] + ".js", "utf8");
  for (const n of names) {
    assert.match(src, new RegExp(`^export (?:const|let|var|function|class) ${n}\\b`, "m"),
      `引擎层 import 的 ${n} 在 ${m[2]}.js 中无对应 export（断链）`);
  }
}

// 4) 运行时：公开面类型 + 行为冒烟
const mod = await import(pathToFileURL(ENTRY).href);
for (const name of PUBLIC_EXPORTS) {
  assert.ok(name in mod, `运行时缺少 export：${name}`);
}
assert.strictEqual(typeof mod.matchStores, "function");
assert.strictEqual(typeof mod.matchOne, "function");
assert.strictEqual(typeof mod.evaluate, "function");
assert.strictEqual(typeof mod.editDistance, "function");
assert.ok(mod.MATCH_CONFIG && typeof mod.MATCH_CONFIG.AUTO_MATCH === "number");
assert.strictEqual(typeof mod.default, "object");

// 行为冒烟 A：精确匹配走 data-exact
const stores = [{ storeId: "S1", name: "华润万家龙华店", routeOrder: 1 }];
const r = mod.matchStores([{ rawName: "华润万家 龙华店" }], stores);
assert.strictEqual(r[0].matchStatus, "matched", "格式差异应精确匹配");
assert.strictEqual(r[0].matchMethod, "data-exact");
assert.strictEqual(r[0].storeId, "S1");

// 行为冒烟 B：守门——乱序名不得自动匹配
const r2 = mod.matchOne("店龙华华润万家", stores);
assert.strictEqual(r2.status, "pending", "疑似乱序必须转待定（守门规则生效）");

// 行为冒烟 C：乱序分应被压低（evaluate 的 blocked 标记）
const ev = mod.evaluate("津天科万城店", "天津万科城店");
assert.strictEqual(ev.blocked, true, "字符集合高度重合但顺序不一致必须 blocked");

// 行为冒烟 D：confidence 字段齐全（process.js 落库依赖）
assert.ok(r[0].matchConfidence && typeof r[0].matchConfidence.level === "string");

console.log("✅ store-match 三模块守卫通过（公开面完整 / import 无断链 / 行为冒烟 4/4）");
