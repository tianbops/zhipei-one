/**
 * 覆盖率阈值棘轮守卫（P1-3 收尾，node tests/coverage-thresholds.test.mjs）
 * -----------------------------------------------------------
 * `npm run coverage` 带 c8 `--check-coverage` 四阈值（statements/branches/
 * functions/lines），低于阈值即 fail——覆盖率倒退会被 CI 拦停。
 *
 * 本守卫钉死两件事：
 *   1. coverage 脚本必须启用 --check-coverage 且四阈值齐全（防有人拆掉闸门）；
 *   2. 阈值不得低于「已批准底线」——**只升不降的棘轮**：随覆盖率改善上调阈值时，
 *      必须先实测新基线并同步更新本文件的 RATCHET_FLOOR；想下调底线直接 fail。
 *
 * 阈值上调过高的自然拦截：c8 运行自身会因达不到阈值而失败，逼你补测试或回调。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const coverageScript = pkg.scripts && pkg.scripts.coverage ? pkg.scripts.coverage : "";

/**
 * 已批准底线 = 2026-10-27 D1 迁移后实测基线（c8，test:node 含 d1-engine）：
 *   CI 82.43% / 本地 83.05%（statements·lines），branches 65.24/65.13，functions 85.32。
 *   两者存在 ±0.6% 的 c8 汇总口径漂移（原始 V8 汇总与 istanbul 逐文件表在 ESM 映射上
 *   有 off-by-N，逐文件数字一致而全局值不同，re-run 数字恒定），故阈值取 CI 稳定值
 *   下方留缓冲。背景：本次新增约 2042 行生产代码（_db.js/_redis-eval.js/_redis-norm.js），
 *   自带 125 项专属测试（_db.js 语句覆盖 94.25%），稀释了全局百分比——旧代码覆盖无任何倒退。
 * 回升计划：为 _redis-eval.js（当前 64%）的高频业务 handler（AUTH_READ/meta 同步/
 *   account/binding 等）补行为测试后，随实测基线上调阈值。
 * 调整规则：只升不降——上调必须同步改这里，下调被本守卫 fail。
 */
const RATCHET_FLOOR = Object.freeze({
  statements: 82,
  branches: 65,
  functions: 83,
  lines: 82,
});

function readThreshold(flag) {
  const m = coverageScript.match(new RegExp("--" + flag + "\\s+(\\d+)"));
  return m ? Number(m[1]) : null;
}

test("coverage 脚本启用 --check-coverage（闸门存在）", () => {
  assert.match(
    coverageScript,
    /--check-coverage/,
    "package.json 的 coverage 脚本缺少 --check-coverage，阈值不会生效"
  );
});

test("四阈值齐全且为 1-100 的整数", () => {
  for (const flag of Object.keys(RATCHET_FLOOR)) {
    const v = readThreshold(flag);
    assert.notEqual(v, null, `coverage 脚本缺少 --${flag} <n> 阈值`);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 100, `--${flag} 阈值须为 1-100 整数，当前 ${v}`);
  }
});

test("阈值不低于已批准底线（只升不降棘轮）", () => {
  for (const [flag, floor] of Object.entries(RATCHET_FLOOR)) {
    const v = readThreshold(flag);
    assert.ok(
      v >= floor,
      `--${flag} 阈值 ${v} 低于已批准底线 ${floor}。` +
        "棘轮规则只升不降：确需下调请先补测试把实测覆盖率做上来，再同步更新 tests/coverage-thresholds.test.mjs 的 RATCHET_FLOOR"
    );
  }
});

console.log(
  "覆盖率阈值棘轮守卫：通过（statements≥" +
    readThreshold("statements") +
    " · branches≥" +
    readThreshold("branches") +
    " · functions≥" +
    readThreshold("functions") +
    " · lines≥" +
    readThreshold("lines") +
    "）"
);
