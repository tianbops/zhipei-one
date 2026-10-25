#!/usr/bin/env node
/**
 * run-tests-parallel.mjs —— 用 Node 原生 test runner 并行执行现有测试集
 *
 * 背景（改造前的实测依据）：
 *   1) package.json 的 test:node 是 75 个 `node tests/xxx` 的 && 串行链 —— 前提成立，确实无并行。
 *   2) 但直接改写成 `node --test tests/` 不可行：
 *      - 在本项目 Node(v22.13.1) 上 runner 会把 "tests" 当模块去 require，报 MODULE_NOT_FOUND；
 *      - 且 runner 的自动发现只认 *.test.* / *-test.* / *_test.* / test-*.js 等模式，
 *        本项目大量 integration-*.cjs / unit-*.cjs 会被**静默漏跑**（覆盖率凭肉眼不可见地下降）。
 *
 * 方案：从 package.json 的 test:node 反解出「与串行链逐字相同」的文件清单，一次性交给
 *       `node --test --test-concurrency=N <files...>` 并行执行。
 *       覆盖率按构造等价（清单同源），只换执行方式，不像 Renaming 方案那样动测试文件。
 *
 * 用法：
 *   node scripts/run-tests-parallel.mjs                    # 默认并发 CPU 数
 *   node scripts/run-tests-parallel.mjs --concurrency=8
 *   node scripts/run-tests-parallel.mjs admin              # 只跑路径含 admin 的文件
 *
 * 退出码：透传 node --test 的退出码。
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import os from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  let concurrency = Math.max(2, Math.min(8, os.cpus().length));
  const filters = [];
  for (const a of argv.slice(2)) {
    if (a.startsWith("--concurrency=")) {
      const n = Number(a.split("=")[1]);
      if (Number.isInteger(n) && n > 0) concurrency = n;
    } else if (a !== "--") {
      filters.push(a);
    }
  }
  return { concurrency, filters };
}

/** 从 package.json 的 test:node 反解测试文件清单（保持与串行链同源） */
function collectTestFiles() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const cmd = pkg.scripts?.["test:node"];
  if (!cmd) throw new Error("package.json 缺少 scripts.test:node，无法反解清单");
  return cmd
    .split("&&")
    .map(s => s.trim())
    .map(s => s.match(/^node\s+(tests\/[^\s]+)$/))
    .filter(Boolean)
    .map(m => m[1]);
}

const { concurrency, filters } = parseArgs(process.argv);
let files = collectTestFiles();

if (filters.length) files = files.filter(f => filters.some(k => f.includes(k)));

const missing = files.filter(f => !existsSync(resolve(ROOT, f)));
if (missing.length) {
  console.error("✗ 以下测试文件不存在（清单与磁盘不一致）：");
  missing.forEach(f => console.error("  - " + f));
  process.exit(1);
}

console.log(`==> 并行执行 ${files.length} 个测试文件｜并发 ${concurrency}${filters.length ? `｜过滤 ${filters.join(",")}` : ""}`);

const res = spawnSync(
  process.execPath,
  ["--test", `--test-concurrency=${concurrency}`, ...files],
  { cwd: ROOT, stdio: "inherit" }
);
process.exit(res.status ?? 1);
