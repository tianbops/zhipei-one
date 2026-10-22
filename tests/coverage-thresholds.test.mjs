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
 * 已批准底线 = 2026-10-22 全量 test:node 实测基线（c8，见 outputs 记录）：
 *   statements/lines 84.49% · functions 84.85% · branches 66.33%
 * 取基线下方约 1.5 个百分点作为缓冲（吸收无覆盖影响的测试抖动）。
 * 调整规则：只升不降——上调必须同步改这里，下调被本守卫 fail。
 */
const RATCHET_FLOOR = Object.freeze({
  statements: 83,
  branches: 65,
  functions: 83,
  lines: 83,
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
