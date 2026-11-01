/**
 * process.js 模块化守卫（node tests/process-split.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-1g：functions/api/waybills/process.js（528 行）按职责拆分：
 *   _process-common.js    键构造 / Asia-Shanghai 日期兜底 / number
 *   _process-extract.js   OCR 文本解析（extract）
 *   _process-plan.js      身份名 / 分段 / 校验 / 去重 / 规划
 *   _process-persist.js   生命周期事件（recordWaybillLifecycle）
 *   process.js            入口：base + runProcessCore（含嵌套 saveWaybill；外层 runProcess 负责临时图片清理）+ onRequestPost
 * ⚠ saveWaybill 在原文件中即为 runProcess 体内的函数声明，深度闭包依赖
 *   runProcessCore 局部量（stopIfClientCancelled / failProcess / emit / requestId…），
 *   按「零改写」原则留在线程入口内——守卫钉死这一点，防后人把它「顺手」外移改写。
 * 行为等价由 10 个集成套件背书（confirm-learning-rematch / diagnostic-auth /
 *   fingerprint-drift / retry-save-expiry / waybill-delete-cleanup / isolation /
 *   lifecycle / multiuser / quality-events / state-machine）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const WB = `${root}functions/api/waybills/`;
const ENTRY = WB + "process.js";
const MODULES = {
  common: WB + "_process-common.js",
  extract: WB + "_process-extract.js",
  plan: WB + "_process-plan.js",
  persist: WB + "_process-persist.js",
};

// 1) 四模块存在 + 非空
for (const [name, p] of Object.entries(MODULES)) {
  assert.ok(existsSync(p), `缺少模块文件：${p}`);
  assert.ok(readFileSync(p, "utf8").trim().length > 0, `模块为空：${name}`);
}

const entry = readFileSync(ENTRY, "utf8");

// 1b) R2 临时暂存快路径：图片写入临时 R2 后，OCR 直接使用原始请求 File，
 //     避免每张图片再 GET 一次并复制完整二进制；请求结束仍由统一清理逻辑删除对象。
assert.match(entry, /await bucket\.put\(key,source,[\s\S]*?tempKeys\.push\(key\)/,
  "运单图片必须先写入 R2 临时存储");
assert.match(stagingBlock, /TEMP_STAGE_CONCURRENCY/,
  "R2 暂存必须使用有上限的并发批次");
assert.match(stagingBlock, /Promise\\.allSettled/,
  "R2 同批写入必须等待全部任务结束，避免失败时遗留未登记对象");
assert.match(stagingBlock, /const failed=settled\\.find/,
  "R2 暂存必须检查同批写入失败");
assert.match(stagingBlock, /if\\(failed\\)throw failed\\.reason/,
  "R2 暂存失败必须进入统一失败与临时对象清理流程");
assert.match(stagingBlock, /r2StageBytes\\+=result\\.value/,
  "R2 暂存字节数必须只累计成功写入的对象");
const stagingBlock = entry.match(/if\(!recognizedText&&files\.length\)\{\s*try\{([\s\S]*?)const ocrStarted=/)?.[1] || "";
assert.ok(stagingBlock, "R2 暂存区块必须存在");
assert.match(entry, /if\(!rawText&&files\.length\)[\s\S]*?WAYBILL_TEMP_LIMIT_EXCEEDED/, "图片大小预检必须在启动线路基准读取前执行");
assert.doesNotMatch(stagingBlock, /bucket\.get\(|arrayBuffer\(\)|stagedFiles/,
  "R2 暂存后不得立即回读图片并复制，OCR 应复用原始 File");
assert.match(stagingBlock, /R2 仍按要求临时暂存并在请求结束后删除/,
  "R2 临时存储策略必须保持并明确记录");

// 1c) OCR 性能诊断必须区分 R2 暂存与上游任务生命周期，且只记录耗时/状态元数据。
const ocrAdapter = readFileSync(WB + "ocr.js", "utf8");
assert.match(ocrAdapter, /ocrProviderState/, "OCR 适配层必须记录上游任务状态");
assert.match(ocrAdapter, /ocrProviderStartTime/, "OCR 适配层必须保留上游开始时间");
assert.match(ocrAdapter, /ocrProviderEndTime/, "OCR 适配层必须保留上游结束时间");
assert.match(entry, /r2StageMs/, "处理入口必须记录 R2 暂存耗时");
assert.match(entry, /r2StageBytes/, "处理入口必须记录 R2 暂存字节数");
assert.match(entry, /ocrProviderStates/, "成功结果必须保留逐图上游状态");
assert.match(entry, /ocrProviderObservedMs/, "成功结果必须保留上游观察时长");
assert.match(entry, /timing:\{r2StageMs,r2StageBytes/, "失败结果也必须保留 R2 暂存计时");

// 2) 入口公开面：只剩 onRequestPost（拆分前唯一公开出口）
const topExports = entry.split("\n").filter((l) => /^export /.test(l));
assert.strictEqual(topExports.length, 1, `入口应只剩 1 个顶层 export，实际：${topExports.length}`);
assert.match(topExports[0], /export async function onRequestPost\(/, "唯一 export 必须是 onRequestPost");

// 3) 零改写红线：saveWaybill 仍嵌套在 runProcess 体内（闭包耦合，不外移）
const runIdx = entry.indexOf("async function runProcessCore(");
const saveIdx = entry.indexOf("async function saveWaybill(");
assert.ok(runIdx > 0 && saveIdx > runIdx, "saveWaybill 必须仍位于 runProcessCore 体内（零改写红线）");
assert.ok(entry.includes("stopIfClientCancelled(\"SAVE\")"), "saveWaybill 的取消检查点应保持原样");

// 4) import 无断链：入口/plan 的 import 名字在目标模块有 export（声明或 re-export 均可）
const exportedNames = (p, seen = new Set()) => {
  if (seen.has(p)) return new Set();
  seen.add(p);
  const src = readFileSync(p, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/^export (?:const|let|var|async function|function|class) (\w+)/gm)) names.add(m[1]);
  // re-export 传递解析：export {a,b} from "./x.js";  /  export {default} from ...
  for (const m of src.matchAll(/^export \{([^}]*)\} from "(\.[^"]+)";/gm)) {
    const target = fileURLToPath(new URL(m[2], pathToFileURL(p)));
    const sub = exportedNames(target, seen);
    for (const raw of m[1].split(",")) {
      const n = raw.trim();
      if (!n) continue;
      if (n === "default") { names.add("default"); continue; }
      const as = n.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
};
const plan = readFileSync(MODULES.plan, "utf8");
const checks = [
  [entry, /import \{([^}]+)\} from "\.\/_process-common\.js";/g, MODULES.common],
  [entry, /import \{([^}]+)\} from "\.\/_process-extract\.js";/g, MODULES.extract],
  [entry, /import \{([^}]+)\} from "\.\/_process-plan\.js";/g, MODULES.plan],
  [entry, /import \{([^}]+)\} from "\.\/_process-persist\.js";/g, MODULES.persist],
  [plan, /import \{([^}]+)\} from "\.\/_store-match\.js";/g, WB + "_store-match.js"],
  [plan, /import \{([^}]+)\} from "\.\/_process-common\.js";/g, MODULES.common],
];
for (const [src, re, target] of checks) {
  let m;
  while ((m = re.exec(src)) !== null) {
    const names = exportedNames(target);
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      assert.ok(names.has(n), `import 的 ${n} 在 ${target.split("/").pop()} 中无对应 export（断链）`);
    }
  }
}

// 5) 无重复 import 同名（防 SyntaxError: Identifier already declared）
const perFile = new Map();
const scanDupes = (label, src) => {
  const re = /import \{([^}]+)\} from "([^"]+)";/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const key = label + "::" + n;
      assert.ok(!perFile.has(key), `${label} 重复 import：${n}`);
      perFile.set(key, true);
    }
  }
};
scanDupes("entry", entry);
for (const [label, p] of Object.entries(MODULES)) scanDupes(label, readFileSync(p, "utf8"));

// 6) 运行时：路由处理在位
const mod = await import(pathToFileURL(ENTRY).href);
assert.strictEqual(typeof mod.onRequestPost, "function");

console.log("✅ process 拆分守卫通过（4 模块 / 唯一公开面 onRequestPost / saveWaybill 零改写留入口 / import 无断链无重复）");
