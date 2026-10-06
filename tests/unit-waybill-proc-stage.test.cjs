// 纯函数单测：孤儿 PROCESSING 访问时有效阶段（P1-2 · 1.0 收口）
// 语义（见 _waybill-proc.js effectiveStage）：0–3min PROCESSING / 3–5min STALLED / ≥5min TIMEOUT
// 仅验证视图重分类逻辑，不涉及 TTL（TTL 仍是 15min 垃圾回收时间，不承担业务状态）。
// 注意：_waybill-proc.js 为 ESM，必须用 dynamic import（require 会 ERR_REQUIRE_ESM）。
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const { effectiveStage, PROC_STALLED_MS, PROC_TIMEOUT_MS } = await import("../functions/api/waybills/_waybill-proc.js");
  const now = Date.now();
  const iso = ms => new Date(now - ms).toISOString();

  // 非 PROCESSING 阶段直接透传（终态不变）
  check("非 PROCESSING 阶段透传(DONE)", effectiveStage({ stage: "DONE", updatedAt: iso(10 * 60 * 1000) }) === "DONE");
  check("非 PROCESSING 阶段透传(FAILED)", effectiveStage({ stage: "FAILED", updatedAt: iso(10 * 60 * 1000) }) === "FAILED");
  check("非 PROCESSING 阶段透传(CANCELLED)", effectiveStage({ stage: "CANCELLED", updatedAt: iso(10 * 60 * 1000) }) === "CANCELLED");

  // PROCESSING 新鲜 → PROCESSING（仍在正常处理窗口）
  check("PROCESSING 1min → PROCESSING", effectiveStage({ stage: "PROCESSING", updatedAt: iso(1 * 60 * 1000) }) === "PROCESSING");
  check("PROCESSING 2min59s → PROCESSING", effectiveStage({ stage: "PROCESSING", updatedAt: iso(179 * 1000) }) === "PROCESSING");

  // 3–5min → STALLED（含边界 3min）
  check("PROCESSING 4min → STALLED", effectiveStage({ stage: "PROCESSING", updatedAt: iso(4 * 60 * 1000) }) === "STALLED");
  check("PROCESSING 正好3min → STALLED(边界)", effectiveStage({ stage: "PROCESSING", updatedAt: iso(PROC_STALLED_MS) }) === "STALLED");
  check("PROCESSING 4min59s → STALLED", effectiveStage({ stage: "PROCESSING", updatedAt: iso(299 * 1000) }) === "STALLED");

  // ≥5min → TIMEOUT（含边界 5min），孤儿任务闭环为终态
  check("PROCESSING 10min → TIMEOUT", effectiveStage({ stage: "PROCESSING", updatedAt: iso(10 * 60 * 1000) }) === "TIMEOUT");
  check("PROCESSING 正好5min → TIMEOUT(边界)", effectiveStage({ stage: "PROCESSING", updatedAt: iso(PROC_TIMEOUT_MS) }) === "TIMEOUT");

  // 无 updatedAt（仅测试种子；生产票据由 beginProc/failProc 必带 updatedAt）→ 视为新鲜 PROCESSING，不误判 TIMEOUT
  check("PROCESSING 无 updatedAt → 视为新鲜 PROCESSING", effectiveStage({ stage: "PROCESSING" }) === "PROCESSING");

  // null proc
  check("null proc → null", effectiveStage(null) === null);

  console.log("\nPROC_STAGE 单测：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
