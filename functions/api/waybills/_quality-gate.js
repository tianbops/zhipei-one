/**
 * 智配One · 运单质量门（纯函数，无 Redis 依赖，可单测）
 * ------------------------------------------------------------------
 * 设计目标：在「结构校验 validateResult」之外，增加业务合理性门，
 * 让系统能识别「识别质量异常 / 匹配质量异常 / 规划数量异常」，
 * 而不是让用户误以为"系统正常完成"。
 *
 * 原则（与项目总控 1.1 定调一致）：
 *   - 仅做"记录 + 提示"，不擅自硬阻断保存（否则违反"失败后还能继续"）。
 *   - 真实字段缺失（extractCount===0）仍由 process.js 的 EXTRACT_EMPTY 硬阻断。
 *   - 不改动任何匹配阈值（AUTO_MATCH / MIN_CONFIDENCE_GAP 不变）。
 *
 * 四级质量门：
 *   L1 数据完整性  → 已由 validateResult 承担（日期/车辆/门店/顺序）。
 *   L2 提取合理性  → OCR 文本很长但提取门店极少 → EXTRACT_LOW_CONFIDENCE。
 *   L3 匹配合理性  → 待定占比过高 / 无一条自动匹配 → MATCH_LOW_CONFIDENCE / MATCH_NO_AUTO。
 *   L4 规划合理性  → 匹配前→去重后异常大量丢失（非合理合并）→ PLAN_DROP_ANOMALY。
 */

/** 粗略统计 OCR 文本行数（用于 L2 判断"文本很多但门店很少"）。 */
export function countLines(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map(x => x.trim())
    .filter(Boolean).length;
}

/**
 * 评估运单流水线各阶段质量。
 * @param {object} m
 *   recognizedTextLen  识别文本长度
 *   lineCount          OCR 文本行数（可由 countLines 得到）
 *   rawExtractCount    OCR/识别阶段提取到的门店数（route-base 切分前）
 *   extractCount       最终参与匹配的门店数（route-base 切分后）
 *   plannedCount       规划后门店总数
 *   pendingCount       规划后待定门店数
 *   autoMatchedCount   自动匹配（非待定）门店数
 *   dedupeBefore       去重前门店数（matched.length）
 *   dedupeAfter        去重后门店数（d.items.length）
 *   merged             去重合并数（d.merged）
 * @returns {{level:"OK"|"WARN"|"REVIEW", flags:string[], warnings:string[]}}
 */
export function evaluateQualityGates({
  recognizedTextLen = 0,
  lineCount = 0,
  rawExtractCount = 0,
  extractCount = 0,
  plannedCount = 0,
  pendingCount = 0,
  autoMatchedCount = 0,
  dedupeBefore = 0,
  dedupeAfter = 0,
  merged = 0,
} = {}) {
  const flags = [];

  // L2 提取合理性：文本明显很长（信息量大）却几乎没提取到门店。
  // 用"行数"与"文本长度"双信号，避免短文本误报。
  if (lineCount >= 8 && extractCount <= 2) flags.push("EXTRACT_LOW_CONFIDENCE");
  else if (recognizedTextLen >= 240 && extractCount <= 1) flags.push("EXTRACT_LOW_CONFIDENCE");

  // L3 匹配合理性：待定占比过高，或一条都没自动匹配。
  if (plannedCount > 0 && pendingCount / plannedCount >= 0.5) flags.push("MATCH_LOW_CONFIDENCE");
  if (extractCount > 0 && autoMatchedCount === 0) flags.push("MATCH_NO_AUTO");

  // L4 规划合理性：匹配前→去重后出现异常大量丢失（超出合理合并范围）。
  // dropped 含合理合并 merged；unexplained = dropped - merged 才是"说不清的丢失"。
  if (dedupeBefore > 4) {
    const dropped = dedupeBefore - dedupeAfter;
    const unexplained = dropped - merged;
    if (unexplained > 0 && unexplained / dedupeBefore >= 0.5) flags.push("PLAN_DROP_ANOMALY");
  }

  const level = flags.length ? "REVIEW" : "OK";
  return { level, flags, warnings: flags.slice() };
}

export default { evaluateQualityGates, countLines };
