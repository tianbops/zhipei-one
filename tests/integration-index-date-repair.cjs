// 1.1 数据一致性回归：空/非法日期索引桶（OCR 未识别日期）→ 运单在历史与诊断中「凭空消失」
// ------------------------------------------------------------------
// 背景：process.js 历史上把 OCR 未识别的日期写成 null → indexKey 落在
// zp:route:<routeId>:waybills:（空日期桶）。历史查询按 YYYY-MM-DD 枚举、诊断列表按日期
// 格式过滤，两处都取不到这张单，且旧的一致性扫描对此**完全无感**（不报任何问题）。
// 本用例固化：能检出 → 能自动迁移到正确日期桶 → 重扫干净。
// 运行：node tests/integration-index-date-repair.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const R = "route-null-date";
const EMPTY_IDX = "zp:route:" + R + ":waybills:";      // 空日期桶（历史遗留形态）
const TARGET = "2026-09-23";
const TARGET_IDX = "zp:route:" + R + ":waybills:" + TARGET;

function wb(id, overrides = {}) {
  return Object.assign({
    schemaVersion: "2", id, routeId: R, routeName: "测试线路",
    date: TARGET, vehicle: "DK7692", totalWeight: 1.35,
    stores: [{ rawName: "华润万家", name: "华润万家", storeId: "S001", routeOrder: 1 }],
    summary: { original: 1, total: 1, matched: 1, pending: 0, correction: 0, merged: 0, newStores: 0 },
    stage: "CONFIRMED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
    createdBy: "u1", createdAt: "2026-09-23T08:00:00.000Z", businessFingerprint: "FP-" + id
  }, overrides);
}

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const { scanConsistency, repairConsistency } = await import("../functions/api/waybills/_consistency.js");

  // ① 主记录有合法 date，但被塞进空日期桶（OCR 未识别时的历史遗留）
  red.command(["SET", "zp:waybill:n1", JSON.stringify(wb("n1"))]);
  // ② 主记录 date 也缺失 → 应由 createdAt（Asia/Shanghai）推导出 2026-09-23
  red.command(["SET", "zp:waybill:n2", JSON.stringify(wb("n2", { date: "" }))]);
  // 两者都落在空日期桶里
  red.command(["SADD", EMPTY_IDX, "n1", "n2"]);
  // 对照：正常日期桶里的单不受影响
  red.command(["SET", "zp:waybill:ok1", JSON.stringify(wb("ok1"))]);
  red.command(["SADD", TARGET_IDX, "ok1"]);

  console.log("【1】一致性扫描检出空日期桶");
  const report = await scanConsistency(env, { routeId: R });
  const bad = report.issues.filter(i => i.type === "MALFORMED_INDEX_DATE");
  check("检出 MALFORMED_INDEX_DATE 共 2 条（n1/n2）", bad.length === 2, "got=" + bad.length);
  check("n1 目标日期取主记录 date=" + TARGET, bad.some(i => i.waybillId === "n1" && i.targetDate === TARGET));
  check("n2 目标日期由 createdAt 推导为 " + TARGET, bad.some(i => i.waybillId === "n2" && i.targetDate === TARGET),
    JSON.stringify(bad.map(i => [i.waybillId, i.targetDate])));
  check("该项为自动可修复（severity=auto 且带 fix）", bad.every(i => i.severity === "auto" && Array.isArray(i.fix) && Array.isArray(i.fix[0])));
  check("n2 主记录日期非法 → 另报 WAYBILL_DATE_INVALID（人工项）", report.issues.filter(i => i.type === "WAYBILL_DATE_INVALID" && i.waybillId === "n2").length === 1);
  check("正常日期桶未误报", !report.issues.some(i => i.waybillId === "ok1"));
  check("不产生会自我抵消的 MISSING_INDEX_ENTRY", report.issues.filter(i => i.type === "MISSING_INDEX_ENTRY").length === 0,
    JSON.stringify(report.summary.counts));

  console.log("【2】安全修复：迁移到正确日期桶 + 移出非法桶");
  const res = await repairConsistency(env, report.issues);
  check("两项均修复成功", res.repairedCount === 2, "repaired=" + res.repairedCount);
  const targetMembers = red.command(["SMEMBERS", TARGET_IDX]) || [];
  const emptyMembers = red.command(["SMEMBERS", EMPTY_IDX]) || [];
  check("n1/n2 已迁入 " + TARGET + " 桶", targetMembers.includes("n1") && targetMembers.includes("n2"), JSON.stringify(targetMembers));
  check("空日期桶已清空（不被 MISSING 修复重新塞回）", emptyMembers.length === 0, JSON.stringify(emptyMembers));
  check("主记录未被删除", !!red.command(["GET", "zp:waybill:n1"]) && !!red.command(["GET", "zp:waybill:n2"]));

  console.log("【3】重扫干净（不重复报警、不产生新问题）");
  const again = await scanConsistency(env, { routeId: R });
  check("重扫无 MALFORMED_INDEX_DATE", again.issues.filter(i => i.type === "MALFORMED_INDEX_DATE").length === 0);
  check("重扫无 MISSING_INDEX_ENTRY（索引已对齐）", again.issues.filter(i => i.type === "MISSING_INDEX_ENTRY").length === 0,
    JSON.stringify(again.summary.counts));
  check("仅剩 n2 的 WAYBILL_DATE_INVALID 人工项（日期确需人工补）",
    again.issues.length === 1 && again.issues[0].type === "WAYBILL_DATE_INVALID" && again.issues[0].waybillId === "n2",
    JSON.stringify(again.summary.counts));

  console.log("\nINDEX_DATE_REPAIR 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
