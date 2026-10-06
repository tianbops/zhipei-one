/**
 * 运单质量门（纯函数）单元测试
 * 运行：node tests/unit-quality-gate.test.cjs
 * 覆盖 L2 提取 / L3 匹配 / L4 规划 合理性门，确认不硬阻断、不改动匹配阈值。
 */
const { evaluateQualityGates, countLines } = require("../functions/api/waybills/_quality-gate.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ---- countLines ---- */
t("countLines 统计行数", countLines("a\nb\n\nc") === 3);
t("countLines 空文本为 0", countLines("") === 0);

/* ---- L2 提取合理性：文本长但门店极少 ---- */
t("L2 行数多+门店少 → EXTRACT_LOW_CONFIDENCE",
  evaluateQualityGates({ lineCount: 12, extractCount: 1 }).flags.includes("EXTRACT_LOW_CONFIDENCE"));
t("L2 文本长+门店少 → EXTRACT_LOW_CONFIDENCE",
  evaluateQualityGates({ recognizedTextLen: 300, extractCount: 1 }).flags.includes("EXTRACT_LOW_CONFIDENCE"));
t("L2 短文本+少门店 不误报",
  !evaluateQualityGates({ lineCount: 2, extractCount: 1 }).flags.includes("EXTRACT_LOW_CONFIDENCE"));

/* ---- L3 匹配合理性：待定占比过高 / 无自动匹配 ---- */
t("L3 待定占比≥50% → MATCH_LOW_CONFIDENCE",
  evaluateQualityGates({ plannedCount: 24, pendingCount: 12 }).flags.includes("MATCH_LOW_CONFIDENCE"));
t("L3 待定占比低 不报警",
  !evaluateQualityGates({ plannedCount: 24, pendingCount: 1 }).flags.includes("MATCH_LOW_CONFIDENCE"));
t("L3 一条都没自动匹配 → MATCH_NO_AUTO",
  evaluateQualityGates({ extractCount: 6, autoMatchedCount: 0 }).flags.includes("MATCH_NO_AUTO"));
t("L3 有自动匹配 不报 MATCH_NO_AUTO",
  !evaluateQualityGates({ extractCount: 6, autoMatchedCount: 5 }).flags.includes("MATCH_NO_AUTO"));

/* ---- L4 规划合理性：匹配前→去重后异常大量丢失（非合理合并） ---- */
t("L4 异常大量丢失 → PLAN_DROP_ANOMALY",
  evaluateQualityGates({ dedupeBefore: 40, dedupeAfter: 17, merged: 0 }).flags.includes("PLAN_DROP_ANOMALY"));
t("L4 合理合并 不报警",
  !evaluateQualityGates({ dedupeBefore: 24, dedupeAfter: 18, merged: 6 }).flags.includes("PLAN_DROP_ANOMALY"));
t("L4 样本过小 不报警",
  !evaluateQualityGates({ dedupeBefore: 3, dedupeAfter: 1, merged: 0 }).flags.includes("PLAN_DROP_ANOMALY"));

/* ---- 综合：正常运单应为 OK ---- */
const ok = evaluateQualityGates({ lineCount: 10, extractCount: 24, plannedCount: 24, pendingCount: 1, autoMatchedCount: 23, dedupeBefore: 24, dedupeAfter: 24, merged: 0 });
t("正常运单 level=OK", ok.level === "OK" && ok.flags.length === 0, JSON.stringify(ok));

/* ---- 仅记录不硬阻断：函数永远返回 level 不抛错 ---- */
t("质量门永不抛错", (() => { try { evaluateQualityGates({}); return true; } catch { return false; } })());

console.log("运单质量门单元测试");
console.log("─".repeat(50));
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); console.log("─".repeat(50)); }
console.log("通过 " + pass + " / 失败 " + fail);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败项");
process.exit(fail ? 1 : 0);
