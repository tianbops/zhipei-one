#!/usr/bin/env node
/**
 * run-tests-parallel.mjs —— 用 Node 原生 test runner 并行执行现有测试集
 *
 * 角色（2026-10-30 起，审计报告 N-7）：本脚本就是 `npm run test:node`。
 *
 * 为什么必须换掉原来的串行链：
 *   `test:node` 原本是 97 段 `node tests/xxx` 的 && 串行链 —— 单点失败会
 *   **静默跳过其后全部测试**。已实证：2026-10-29 home-bundle-fresh 一处失败，
 *   其后 30+ 个测试根本没跑，CI 只报"失败"不报"还有 30 个没跑"。
 *   这等于给回归开了后门：红一次没人管，后面所有检查都被掩盖。
 *
 * 做法（不变的约束）：
 *   1) 清单仍从 package.json 的 `test:serial`（原串行链，逐字保留）反解，
 *      与串行口径同源 —— 不改测试文件、不靠文件名约定自动发现；
 *   2) 不用 `node --test tests/`：本项目 Node(v22.13.1) 上 runner 会把目录当
 *      模块 require 报 MODULE_NOT_FOUND，且自动发现只认 *.test.* 等模式，
 *      integration-*.cjs / unit-*.cjs 会被静默漏跑。
 *   3) 一次性把清单交给 `node --test --test-concurrency=N <files...>`：
 *      全量跑完再汇总，任何一个失败都能在同一个输出里看见。
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

/** 从 package.json 的 test:serial 反解测试文件清单（唯一真值源，串行链逐字保留） */
function collectTestFiles() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const cmd = pkg.scripts?.["test:serial"];
  if (!cmd) throw new Error("package.json 缺少 scripts['test:serial']（串行链真值源），无法反解清单");

  const segments = cmd.split("&&").map(s => s.trim()).filter(Boolean);
  const files = [];
  const unparsed = [];
  for (const seg of segments) {
    // 只接受「node <tests|scripts>/<文件>」这一种形态。
    // 早先的实现只认 tests/，导致链尾 `node scripts/ui-token-guard.mjs`
    // 被静默丢弃 —— 与串行链的"静默跳过"是同一类毛病，故改为无法解析即报错。
    const m = seg.match(/^node\s+((?:tests|scripts)\/[\w./-]+)$/);
    if (m) files.push(m[1]);
    else unparsed.push(seg);
  }
  if (unparsed.length) {
    console.error("✗ test:serial 中存在无法解析的片段（会造成静默漏跑）：");
    unparsed.forEach(s => console.error("  - " + s));
    console.error("  允许的形态：node tests/<文件> 或 node scripts/<文件>，用 && 连接");
    process.exit(1);
  }
  const self = files.find(f => /run-tests-parallel\.mjs$/.test(f));
  if (self) {
    console.error("✗ test:serial 不得包含 " + self + "（会自我递归）");
    process.exit(1);
  }
  return files;
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
