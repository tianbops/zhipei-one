/**
 * Persistent waybill failure archive and route/date lookup.
 */
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");
let pass = 0, fail = 0;
function check(name, ok, info) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (info ? " " + info : "")); }
}
(async () => {
  const red = new MiniRedis();
  makeUpstash(red);
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const { beginProc, failProc, cancelProc, listFailureRecords, getProc, finishProc } = await import("../functions/api/waybills/_waybill-proc.js");
  const requestId = "req-failure-archive-1";
  await beginProc(env, { requestId, routeId: "route-17", userId: "admin-test" });
  const order = {
    routeId: "route-17", date: "2026-05-21", uploadedAt: "2026-05-22T01:00:00.000Z", uploadedAtBeijing: "2026-05-22T09:00:00.000+08:00", vehicle: "渝DK7692",
    rawText: "must not be retained",
    stores: [{ name: "门店甲", storeId: "s1" }, { name: "门店甲", storeId: "s1" }],
    validation: { valid: false, errors: ["规划结果存在重复门店"] },
    diagnostics: { extractCount: 26, dedupeBefore: 8, dedupeAfter: 8, plannedCount: 8, finalItems: [{ name: "门店甲" }] },
    timing: { ocrMs: 4200 },
    ocr: { lineEvidence: [{ text: "门店甲" }], fieldEvidence: { stores: [] } }
  };
  await failProc(env, requestId, {
    stage: "FAILED", code: "WAYBILL_VALIDATION_DUPLICATE_STORE",
    message: "运单规划结果校验失败：规划结果存在重复门店",
    recoverable: true, action: "RESUBMIT", date: "2026-05-21", vehicle: "渝DK7692",
    validation: order.validation, order
  });
  const archived = await listFailureRecords(env, { routeId: "route-17", date: "2026-05-21" });
  check("失败记录可按运单日期查到", archived.count === 1 && archived.failures[0]?.requestId === requestId);
  check("失败记录保留车牌和业务错误码", archived.failures[0]?.vehicle === "渝DK7692" && archived.failures[0]?.code === "WAYBILL_VALIDATION_DUPLICATE_STORE");
  check("失败记录包含去重前后诊断", archived.failures[0]?.order?.diagnostics?.dedupeBefore === 8 && archived.failures[0]?.order?.diagnostics?.dedupeAfter === 8);
  check("失败归档不保存原始 OCR 全文", !("rawText" in (archived.failures[0]?.order || {})));
  const plate = await listFailureRecords(env, { routeId: "route-17", date: "2026-05-21", vehicle: "渝DK7692" });
  check("失败记录支持车牌筛选", plate.count === 1);
  const wrongPlate = await listFailureRecords(env, { routeId: "route-17", date: "2026-05-21", vehicle: "渝DK0000" });
  check("车牌筛选无匹配时返回空", wrongPlate.count === 0);
  const uploadDay = archived.failures[0]?.uploadDate;
  const byUpload = await listFailureRecords(env, { routeId: "route-17", date: uploadDay });
  check("上传日为北京时间 2026-05-22", uploadDay === "2026-05-22");
  check("按上传日查询不会命中业务日期不同的失败单", byUpload.count === 0);
  const normalId = "req-failure-archive-done";
  await beginProc(env, { requestId: normalId, routeId: "route-17", userId: "admin-test" });
  await finishProc(env, normalId, "waybill-1");
  const cancelId = "req-failure-archive-cancel";
  await beginProc(env, { requestId: cancelId, routeId: "route-17", userId: "admin-test" });
  await cancelProc(env, cancelId, { action: "REPROCESS", hint: "用户取消处理", detail: "OCR" });
  const recent = await listFailureRecords(env, { routeId: "route-17" });
  check("成功完成任务不会进入失败列表", recent.count === 2);
  check("用户取消任务也会归档", recent.failures.some(x => x.requestId === cancelId && x.stage === "CANCELLED"));
  check("实时处理票据仍保留原15分钟生命周期", (await getProc(env, requestId))?.stage === "FAILED");
  console.log("失败归档测试：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
