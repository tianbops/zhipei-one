/**
 * 运单数据一致性自检 / 安全修复 · 端到端回归（1.1 核心增强 · P1.5）
 * 复用 _mini-redis.cjs 真实加载 _consistency.js，验证：
 *   1. 只读扫描能识别 8 类不一致（孤儿索引 / 缺失索引 / SUPERSEDED 留索引 / 孤儿去重键 /
 *      孤儿指纹键 / 孤儿事件链 / 重复指纹 / 处理票据孤儿 / 结构异常主记录）。
 *   2. 安全修复仅应用自动项（SREM 孤儿/SUPERSEDED、SADD 缺失索引、DEL 悬空键），
 *      绝不删除主记录、绝不处理 MANUAL/INFO 项。
 *   3. 修复后重扫：autoRepairable = 0；MANUAL/INFO 项保留。
 * 运行：node tests/integration-waybill-consistency.cjs
 */
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const ROUTE = "R1";
const DATE = "2026-10-06";
const IDX = "zp:route:" + ROUTE + ":waybills:" + DATE;

function wb(id, overrides = {}) {
  return Object.assign({
    schemaVersion: "2", id, routeId: ROUTE, routeName: "测试线路",
    date: DATE, vehicle: "粤B12345", totalWeight: 0.46,
    stores: [{ rawName: "华润万家", name: "华润万家", storeId: "S001", routeOrder: 1 }],
    summary: { original: 1, total: 1, matched: 1, pending: 0, correction: 0, merged: 0, newStores: 0 },
    stage: "CONFIRMED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
    createdBy: "u1", createdAt: "2026-10-06T08:00:00.000Z", businessFingerprint: "FP-" + id
  }, overrides);
}

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const mod = await import("../functions/api/waybills/_consistency.js");
  const { scanConsistency, repairConsistency } = mod;

  // ---- 种植：健康 + 各类不一致 ----
  red.command(["SET", "zp:waybill:w1", JSON.stringify(wb("w1", { businessFingerprint: "FP-A" }))]);
  red.command(["SET", "zp:waybill:w2", JSON.stringify(wb("w2", { businessFingerprint: "FP-B" }))]); // 故意不进索引
  red.command(["SET", "zp:waybill:w3", JSON.stringify(wb("w3", { stage: "SUPERSEDED", historyStatus: "SUPERSEDED", businessFingerprint: "FP-C" }))]); // 进索引但已作废
  red.command(["SET", "zp:waybill:w4", JSON.stringify(wb("w4", { businessFingerprint: "FP-A" }))]); // 与 w1 同指纹（重复）
  red.command(["SET", "zp:waybill:w5", JSON.stringify({ id: "w5", routeId: ROUTE, date: DATE, stores: [] })]); // 结构异常（无 schemaVersion/summary）
  // 索引：含 w1/w3/ghost1/w4；缺少 w2
  red.command(["SADD", IDX, "w1", "w3", "ghost1", "w4"]);
  // 悬空去重 / 指纹键
  red.command(["SET", "zp:waybill:dedupe:BAD", "ghost2"]);
  red.command(["SET", "zp:waybill:fingerprint:BAD", "ghost3"]);
  // 孤儿事件链（w9 主记录不存在）
  red.command(["RPUSH", "zp:waybill:w9:events", JSON.stringify({ t: "2026-10-06T08:00:00.000Z", event: "WAYBILL_CREATED" })]);
  // 处理票据孤儿（info）
  red.command(["SET", "zp:waybill:proc:reqX", JSON.stringify({ stage: "PROCESSING" })]);
  // w1 正常事件链（不应被判孤儿）
  red.command(["RPUSH", "zp:waybill:w1:events", JSON.stringify({ t: "2026-10-06T08:00:00.000Z", event: "WAYBILL_CREATED" })]);

  console.log("【1】只读扫描识别各类不一致");
  const report = await scanConsistency(env, { routeId: ROUTE });
  const types = report.issues.map(i => i.type);
  const byType = t => report.issues.filter(i => i.type === t);
  check("扫描到孤儿索引条目 ORPHAN_INDEX_ENTRY", byType("ORPHAN_INDEX_ENTRY").length === 1, "ghost1");
  check("扫描到缺失索引条目 MISSING_INDEX_ENTRY", byType("MISSING_INDEX_ENTRY").length === 1, "w2");
  check("扫描到 SUPERSEDED 留索引 SUPERSEDED_IN_INDEX", byType("SUPERSEDED_IN_INDEX").length === 1, "w3");
  check("扫描到孤儿去重键 ORPHAN_DEDUPE_KEY", byType("ORPHAN_DEDUPE_KEY").length === 1);
  check("扫描到孤儿指纹键 ORPHAN_FINGERPRINT_KEY", byType("ORPHAN_FINGERPRINT_KEY").length === 1);
  check("扫描到孤儿事件链 ORPHAN_EVENT_LIST", byType("ORPHAN_EVENT_LIST").length === 1, "w9");
  check("扫描到重复指纹 DUPLICATE_FINGERPRINT", byType("DUPLICATE_FINGERPRINT").length === 1, "FP-A:w1,w4");
  check("扫描到处理票据孤儿 PROC_TICKET_ORPHAN（info）", byType("PROC_TICKET_ORPHAN").length === 1, "reqX");
  check("扫描到结构异常主记录 MALFORMED_WAYBILL", byType("MALFORMED_WAYBILL").length === 1, "w5");
  check("w1 正常事件链未误判为孤儿", !types.includes("ORPHAN_EVENT_LIST") || byType("ORPHAN_EVENT_LIST").every(i => i.waybillId !== "w1"));
  check("扫描计数汇总正确（total=9, auto=6）", report.summary.total === 9 && report.summary.autoRepairable === 6, JSON.stringify(report.summary.counts));
  check("自动项均携带 fix 指令", report.issues.filter(i => i.fix).length === 6);
  check("MANUAL/INFO 项 fix 为 null", report.issues.filter(i => !i.fix).every(i => i.fix === null));

  console.log("【2】安全修复：仅动悬空引用 / 补回缺失索引，不动主记录");
  const before = red.command(["SMEMBERS", IDX]).slice().sort();
  const result = await repairConsistency(env, report.issues);
  check("修复成功 6 项自动问题", result.repairedCount === 6, "repaired=" + result.repairedCount);
  check("跳过 3 项 MANUAL/INFO", result.skippedCount === 3, "skipped=" + result.skippedCount);
  check("修复含 SREM 孤儿索引", result.repaired.some(r => r.type === "ORPHAN_INDEX_ENTRY"));
  check("修复含 SADD 缺失索引", result.repaired.some(r => r.type === "MISSING_INDEX_ENTRY"));
  check("修复含 DEL 悬空去重/指纹/事件键",
    result.repaired.some(r => r.type === "ORPHAN_DEDUPE_KEY") &&
    result.repaired.some(r => r.type === "ORPHAN_FINGERPRINT_KEY") &&
    result.repaired.some(r => r.type === "ORPHAN_EVENT_LIST"));

  // 索引实际状态：ghost1/w3 移除，w2 补回 → [w1,w2,w4]
  const after = red.command(["SMEMBERS", IDX]).slice().sort();
  check("索引已剔除 ghost1 与 w3（SUPERSEDED）", !after.includes("ghost1") && !after.includes("w3"), JSON.stringify(after));
  check("索引已补回 w2", after.includes("w2"));
  check("索引保留 w1/w4", after.includes("w1") && after.includes("w4"));
  // 悬空键被删
  check("孤儿去重键已删除", red.command(["GET", "zp:waybill:dedupe:BAD"]) === null);
  check("孤儿指纹键已删除", red.command(["GET", "zp:waybill:fingerprint:BAD"]) === null);
  check("孤儿事件链已删除", red.command(["LLEN", "zp:waybill:w9:events"]) === 0);
  // 主记录完好
  check("主记录未被修复删除（w1/w2/w3/w4/w5 仍在）",
    ["w1", "w2", "w3", "w4", "w5"].every(id => red.command(["GET", "zp:waybill:" + id]) !== null));

  console.log("【3】修复后重扫：autoRepairable=0，MANUAL/INFO 保留");
  const report2 = await scanConsistency(env, { routeId: ROUTE });
  check("重扫无自动可修复项", report2.summary.autoRepairable === 0, "auto=" + report2.summary.autoRepairable);
  check("重扫保留 DUPLICATE_FINGERPRINT（manual）", report2.issues.some(i => i.type === "DUPLICATE_FINGERPRINT"));
  check("重扫保留 MALFORMED_WAYBILL（manual）", report2.issues.some(i => i.type === "MALFORMED_WAYBILL"));
  check("重扫保留 PROC_TICKET_ORPHAN（info）", report2.issues.some(i => i.type === "PROC_TICKET_ORPHAN"));
  check("重扫总数降为 3（仅 manual+info）", report2.summary.total === 3, "total=" + report2.summary.total);

  console.log("【4】all=1 全量扫描作用域");
  // 另一线路的干净运单，验证 all 能覆盖、routeId 限定不会误报
  red.command(["SET", "zp:waybill:wA", JSON.stringify(wb("wA", { routeId: "R2", id: "wA", businessFingerprint: "FP-A" }))]);
  red.command(["SADD", "zp:route:R2:waybills:" + DATE, "wA"]);
  const scoped = await scanConsistency(env, { routeId: ROUTE });
  const allScan = await scanConsistency(env, { all: true });
  check("routeId 限定不误报其它线路", !scoped.issues.some(i => i.routeId === "R2" && i.waybillId === "wA"));
  check("all=1 能扫到 R2 的运单", allScan.scanned.waybills >= 6, "waybills=" + allScan.scanned.waybills);

  console.log("\n──────────────────────────────────────────────────");
  console.log("数据一致性 回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试异常：", e); process.exit(1); });
