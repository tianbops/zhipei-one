/**
 * 运单运营统计 · 端到端回归（1.1 核心增强 · P1.5 延伸 / 1.3）
 * 复用 _mini-redis.cjs 真实加载 _stats.js，验证：
 *   1. 只读聚合正确：运单量 / stage 分布 / 确认率 / 质量门分布 /
 *      门店匹配置信分布 / 待定率 / OCR 低置信数 / 处理票据失败分布。
 *   2. 日期窗口：窗口外（>days）运单不计入。
 *   3. 作用域：routeId 限定不含其它线路；all=1 全量覆盖。
 * 运行：node tests/integration-waybill-stats.cjs
 */
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

function shDate(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - offsetDays);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}
const TODAY = shDate(0), OLD = shDate(29), OUT = shDate(40);
const R1 = "R1", R2 = "R2";
const IDX = r => "zp:route:" + r + ":waybills:";

function wb(id, routeId, date, { stage = "CONFIRMED", quality = "OK", stores = [], ocrLow = false, historyStatus = null } = {}) {
  const w = {
    schemaVersion: "2", id, routeId, routeName: "线路", date, vehicle: "粤B12345", totalWeight: 0.46,
    stores, summary: { original: stores.length, total: stores.length, matched: stores.length, pending: stores.filter(s => s.pending).length, correction: 0, merged: 0, newStores: 0 },
    stage, pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED"].concat(stage === "CONFIRMED" ? ["CONFIRMED"] : []),
    createdBy: "u1", createdAt: date + "T08:00:00.000Z",
    quality: quality ? { level: quality, flags: [] } : null,
    ocr: { provider: "PaddleOCR", lowConfidence: ocrLow || null }
  };
  if (historyStatus) w.historyStatus = historyStatus;
  return w;
}
const store = (level, pending = false) => ({ rawName: "门店", name: "门店", storeId: "S" + level, routeOrder: 1, pending, matchConfidence: { level, score: 0.9, signals: [] } });

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const mod = await import("../functions/api/waybills/_stats.js");
  const { computeStats } = mod;

  // 今日 R1
  red.command(["SET", "zp:waybill:A", JSON.stringify(wb("A", R1, TODAY, { stage: "CONFIRMED", quality: "OK", stores: [store("HIGH"), store("HIGH")] }))]);
  red.command(["SET", "zp:waybill:B", JSON.stringify(wb("B", R1, TODAY, { stage: "CONFIRMED", quality: "REVIEW", stores: [store("PENDING", true), store("HIGH")], ocrLow: true }))]);
  red.command(["SET", "zp:waybill:C", JSON.stringify(wb("C", R1, TODAY, { stage: "PLANNED", quality: "OK", stores: [store("MEDIUM"), store("MEDIUM")] }))]);
  red.command(["SET", "zp:waybill:D", JSON.stringify(wb("D", R1, TODAY, { stage: "SUPERSEDED", quality: null, stores: [store("HIGH")], historyStatus: "SUPERSEDED" }))]);
  // 旧日 R1
  red.command(["SET", "zp:waybill:E", JSON.stringify(wb("E", R1, OLD, { stage: "CONFIRMED", quality: "WARN", stores: [store("LOW")] }))]);
  // 窗口外 R1（不计入）
  red.command(["SET", "zp:waybill:Z", JSON.stringify(wb("Z", R1, OUT, { stage: "CONFIRMED", quality: "OK", stores: [store("HIGH")] }))]);
  // 另一线路（验证作用域）
  red.command(["SET", "zp:waybill:R2A", JSON.stringify(wb("R2A", R2, TODAY, { stage: "CONFIRMED", quality: "OK", stores: [store("HIGH")] }))]);

  red.command(["SADD", IDX(R1) + TODAY, "A", "B", "C", "D"]);
  red.command(["SADD", IDX(R1) + OLD, "E"]);
  red.command(["SADD", IDX(R1) + OUT, "Z"]);
  red.command(["SADD", IDX(R2) + TODAY, "R2A"]);

  // 处理票据（生产环境 beginProc 落库必带 routeId；统计按线路隔离依赖该字段）
  for (const [req, stage] of [["r1", "DONE"], ["r2", "TIMEOUT"], ["r3", "FAILED"], ["r4", "CANCELLED"], ["r5", "PROCESSING"]]) {
    red.command(["SET", "zp:waybill:proc:" + req, JSON.stringify({ requestId: req, routeId: R1, stage })]);
  }

  console.log("【1】R1 窗口内聚合");
  const s = await computeStats(env, { routeId: R1, days: 30 });
  check("窗口不含窗口外运单 Z（total=5）", s.waybills.total === 5, "total=" + s.waybills.total);
  check("stage 分布 CONFIRMED=3/PLANNED=1/SUPERSEDED=1（含旧日 E）",
    s.waybills.byStage.CONFIRMED === 3 && s.waybills.byStage.PLANNED === 1 && s.waybills.byStage.SUPERSEDED === 1);
  check("确认率 = 0.6", s.waybills.confirmedRate === 0.6, "rate=" + s.waybills.confirmedRate);
  check("质量门 REVIEW=1 / WARN=1", s.quality.REVIEW === 1 && s.quality.WARN === 1, JSON.stringify(s.quality));
  check("门店置信 HIGH=4/MEDIUM=2/LOW=1/PENDING=1",
    s.matchConfidence.HIGH === 4 && s.matchConfidence.MEDIUM === 2 && s.matchConfidence.LOW === 1 && s.matchConfidence.PENDING === 1,
    JSON.stringify(s.matchConfidence));
  check("待定：1 张运单含待定、待定门店 1/8、待定率 0.125",
    s.pending.waybillsWithPending === 1 && s.pending.totalStores === 8 && s.pending.pendingStores === 1 && s.pending.pendingRate === 0.125,
    JSON.stringify(s.pending));
  check("OCR 低置信运单数 = 1", s.ocr.lowConfidence === 1, "low=" + s.ocr.lowConfidence);

  console.log("【2】处理票据（OCR 可靠性）");
  check("处理票据 total=5", s.processing.total === 5, "total=" + s.processing.total);
  check("终态 DONE/TIMEOUT/FAILED/CANCELLED/PROCESSING 各 1",
    s.processing.byStage.DONE === 1 && s.processing.byStage.TIMEOUT === 1 && s.processing.byStage.FAILED === 1 &&
    s.processing.byStage.CANCELLED === 1 && s.processing.byStage.PROCESSING === 1);
  check("可恢复失败数 = 3（TIMEOUT+FAILED+CANCELLED）", s.processing.recoverableFailures === 3, "rf=" + s.processing.recoverableFailures);

  console.log("【3】作用域");
  const allScan = await computeStats(env, { all: true, days: 30 });
  check("all=1 含 R2，total=6", allScan.waybills.total === 6, "total=" + allScan.waybills.total);
  const scoped = await computeStats(env, { routeId: R1, days: 30 });
  check("routeId=R1 不含 R2（total=5）", scoped.waybills.total === 5);

  console.log("【4】日期窗口边界");
  const narrow = await computeStats(env, { routeId: R1, days: 1 });
  check("days=1 仅今日（total=4，不含旧日 E）", narrow.waybills.total === 4, "total=" + narrow.waybills.total);
  check("窗口起止正确", narrow.window.days === 1 && narrow.window.end === TODAY);

  console.log("\n──────────────────────────────────────────────────");
  console.log("运营统计 回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试异常：", e); process.exit(1); });
