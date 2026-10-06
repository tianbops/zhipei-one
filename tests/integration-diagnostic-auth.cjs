// 智配One · 诊断接口权限收口 + RETRY_SAVE 语义 + 统计作用域/去重 回归（P0 #1 / P1 #4/#5/#6）
// ------------------------------------------------------------------
// 直接针对正式代码评审中发现的「测试通过但业务损坏」缺陷补真实业务回归：
//   P0-1  诊断接口 stats/consistency 普通用户线路权限绕过（数据越权）
//   P1-4  RETRY_SAVE 实际重跑整套（含 OCR）—— 应仅重保存、不复用 OCR
//   P1-5  统计 proc 票据无线路隔离（普通用户能看到其它线路处理终态）
//   P1-6  统计 waybillId 无去重（同一运单被多日索引重复计入）
// 复用 _mini-redis.cjs 真实加载 diagnostic.js / _stats.js / process.js。
// 运行：node tests/integration-diagnostic-auth.cjs
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
const TODAY = shDate(0), YESTERDAY = shDate(1);
const R17 = "route-17", R18 = "route-18";
const A = "uA", B = "uB", ADM = "uADM";
const tokA = "tok-A", tokB = "tok-B", tokADM = "tok-ADM";
const IDX = r => "zp:route:" + r + ":waybills:";

function wb(id, routeId, date, { stage = "CONFIRMED", quality = "OK", stores = [], ocrLow = false } = {}) {
  return {
    schemaVersion: "2", id, routeId, routeName: "线路", date, vehicle: "粤B17171", totalWeight: 0.46,
    stores, summary: { original: stores.length, total: stores.length, matched: stores.length, pending: stores.filter(s => s.pending).length, correction: 0, merged: 0, newStores: 0 },
    stage, pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED"].concat(stage === "CONFIRMED" ? ["CONFIRMED"] : []),
    createdBy: A, createdAt: date + "T08:00:00.000Z",
    quality: quality ? { level: quality, flags: [] } : null,
    ocr: { provider: "PaddleOCR", lowConfidence: ocrLow || null }
  };
}
const store = (level, pending = false) => ({ rawName: "门店", name: "门店", storeId: "S" + level, routeOrder: 1, pending, matchConfidence: { level, score: 0.9, signals: [] } });
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const read = (key) => { const r = red.command(["GET", "zp:" + key]); return r ? JSON.parse(r) : null; };
function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function postFormReq(url, token, fd) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => fd };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const baseDir = require("url").pathToFileURL(__dirname + "/../functions/api/").href;
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const processMod = await import(baseDir + "waybills/process.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
  const diagGet = (token, qs) => diagMod.onRequestGet({ request: getReq("https://app.local/api/waybills/diagnostic?" + qs, token), env });

  // 角色矩阵
  seed("user:" + A, { id: A, role: "user", boundRouteId: R17, dispatchRouteId: R17, routeDuty: "driver", sessionVersion: 1 });
  seed("session:tok-A", { userId: A, sessionVersion: 1 });
  seed("user:" + ADM, { id: ADM, role: "admin", sessionVersion: 1 });
  seed("session:tok-ADM", { userId: ADM, sessionVersion: 1 });
  // 用户 B：另一条线路（route-18）的普通用户，用于验证「借他人 resume 票据重保存」被拒。
  seed("user:" + B, { id: B, role: "user", boundRouteId: R18, dispatchRouteId: R18, routeDuty: "driver", sessionVersion: 1 });
  seed("session:tok-B", { userId: B, sessionVersion: 1 });
  seed("route:" + R17, { id: R17, name: "线路17", status: "active" });
  seed("route:" + R18, { id: R18, name: "线路18", status: "active" });

  // ===================================================================
  console.log("\n【P0-1】诊断接口权限收口：普通用户线路越权（stats / consistency）");
  // 用户 A 仅 R17 线路；R18 是其无权查看的线路。
  const aStats17 = await toJson(await diagGet(tokA, "stats=1&routeId=" + R17));
  check("用户A → 17号线路 stats ✅", aStats17.success === true && aStats17.scope === R17, "scope=" + (aStats17.scope));
  const aStats18 = await toJson(await diagGet(tokA, "stats=1&routeId=" + R18));
  check("用户A → 18号线路 stats 403（无权诊断该线路）", aStats18.success !== true && aStats18.error === "无权诊断该线路", "err=" + (aStats18.error));
  const aStatsAll = await toJson(await diagGet(tokA, "stats=1&all=1"));
  check("用户A → all=1 403（非管理员不可查询全量）", aStatsAll.success !== true && aStatsAll.error === "非管理员不可查询全量", "err=" + (aStatsAll.error));
  const aCons17 = await toJson(await diagGet(tokA, "check=consistency&routeId=" + R17));
  check("用户A → 17号线路 consistency ✅", aCons17.success === true && aCons17.scope === R17, "scope=" + (aCons17.scope));
  const aCons18 = await toJson(await diagGet(tokA, "check=consistency&routeId=" + R18));
  check("用户A → 18号线路 consistency 403", aCons18.success !== true && aCons18.error === "无权诊断该线路", "err=" + (aCons18.error));
  const admStats18 = await toJson(await diagGet(tokADM, "stats=1&routeId=" + R18));
  check("管理员 → 18号线路 stats ✅", admStats18.success === true && admStats18.scope === R18, "scope=" + (admStats18.scope));
  const admStatsAll = await toJson(await diagGet(tokADM, "stats=1&all=1"));
  check("管理员 → all=1 ✅", admStatsAll.success === true && admStatsAll.scope === "ALL", "scope=" + (admStatsAll.scope));

  // ===================================================================
  console.log("\n【P1-5 / P1-6】统计作用域贯穿处理票据 + waybillId 去重");
  // R17 运单：w17a 同时被错误地写入「今日」与「昨日」两个索引（多日重复索引），w17b 仅今日。
  seed("waybill:w17a", wb("w17a", R17, TODAY, { stage: "CONFIRMED", quality: "OK", stores: [store("HIGH"), store("HIGH")] }));
  seed("waybill:w17b", wb("w17b", R17, TODAY, { stage: "PLANNED", quality: "WARN", stores: [store("MEDIUM", true)] }));
  red.command(["SADD", IDX(R17) + TODAY, "w17a", "w17b"]);
  red.command(["SADD", IDX(R17) + YESTERDAY, "w17a"]); // 重复索引（数据损坏场景）
  // R18 运单（用户 A 无权，验证作用域不串）
  seed("waybill:w18a", wb("w18a", R18, TODAY, { stage: "CONFIRMED", quality: "OK", stores: [store("HIGH")] }));
  red.command(["SADD", IDX(R18) + TODAY, "w18a"]);
  // 处理票据：带 routeId，分别落在 R17 / R18（验证 P1-5 票据线路隔离）
  red.command(["SET", "zp:waybill:proc:pR17a", JSON.stringify({ requestId: "pR17a", routeId: R17, userId: A, stage: "FAILED", action: "RETRY_SAVE" })]);
  red.command(["SET", "zp:waybill:proc:pR17b", JSON.stringify({ requestId: "pR17b", routeId: R17, stage: "DONE" })]);
  red.command(["SET", "zp:waybill:proc:pR18a", JSON.stringify({ requestId: "pR18a", routeId: R18, stage: "FAILED" })]);

  const aStats = await toJson(await diagGet(tokA, "stats=1&routeId=" + R17));
  // 去重：w17a 被两日索引重复计入，修复后仅算 1 张 → total=2（w17a + w17b）
  check("P1-6 去重：w17a 跨两日索引仍只算 1 张（total=2）", aStats.success && aStats.waybills.total === 2, "total=" + (aStats.waybills && aStats.waybills.total) + " scanned=" + (aStats.scannedWaybills) + " entries=" + (aStats.indexEntriesScanned));
  check("P1-6 去重：scannedWaybills=2（去重后）", aStats.scannedWaybills === 2, "scanned=" + (aStats.scannedWaybills));
  check("P1-6 去重：indexEntriesScanned=3（w17a 两日 + w17b 今日）", aStats.indexEntriesScanned === 3, "entries=" + (aStats.indexEntriesScanned));
  // 作用域：R17 统计不含 R18 运单 w18a
  check("P1-5 作用域：R17 统计不含 R18 运单（不含 w18a）", aStats.success && aStats.waybills.total === 2);
  // 票据线路隔离：用户 A 仅见 R17 的 2 张终态票据，看不到 R18 的 pR18a
  check("P1-5 票据隔离：R17 统计 processing.total=2（仅 R17 票据）", aStats.processing && aStats.processing.total === 2, "proc=" + (aStats.processing && aStats.processing.total));
  check("P1-5 票据隔离：R17 统计不含 R18 的 FAILED 票据", aStats.processing && aStats.processing.byStage.FAILED === 1, "failed=" + (aStats.processing && aStats.processing.byStage.FAILED));

  const admAll = await toJson(await diagGet(tokADM, "stats=1&all=1"));
  check("P1-6 管理员全量去重：total=3（w17a/w17b/w18a 三张去重）", admAll.success && admAll.waybills.total === 3, "total=" + (admAll.waybills && admAll.waybills.total));
  check("P1-5 管理员全量含 R18 票据：processing.total=3", admAll.processing && admAll.processing.total === 3, "proc=" + (admAll.processing && admAll.processing.total));

  // ===================================================================
  console.log("\n【P1-4】RETRY_SAVE 仅重保存不重 OCR（复用 proc 票据 order，跳过识别/提取/匹配/去重/规划/校验）");
  // 构造一张「保存阶段失败」的 FAILED 票据，携带已构建完成的 order 快照。
  const resumeOrder = {
    schemaVersion: "2", id: "wb-resume-1", routeId: R17, routeName: "线路17", date: TODAY,
    vehicle: "粤B17171", totalWeight: 1.2,
    stores: [{ rawName: "门店R17A", name: "门店R17A", storeId: null, routeOrder: 1, pending: false, matchConfidence: { level: "HIGH" } }],
    rawText: "运输日期 " + TODAY + "\n车牌号 粤B17171\n总重量 1.2吨\n门店R17A",
    stage: "PLANNED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED"],
    summary: { original: 1, total: 1, matched: 1, pending: 0, correction: 0, merged: 0, newStores: 0 },
    createdBy: A, createdAt: new Date().toISOString(), quality: { level: "OK", flags: [] }
  };
  red.command(["SET", "zp:waybill:proc:resume-1", JSON.stringify({
    requestId: "resume-1", routeId: R17, userId: A, stage: "FAILED", recoverable: true, action: "RETRY_SAVE",
    hint: "运单保存失败，可重试保存", detail: null, order: resumeOrder, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  })]);

  // 监控 OCR 服务是否被调用（RETRY_SAVE 不应再触发任何 OCR 识别）。
  const OCR_HOST = "https://paddleocr.aistudio-app.com";
  let ocrCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(OCR_HOST)) { ocrCalls++; throw new Error("OCR 不应在 RETRY_SAVE 路径被调用"); }
    return realFetch(url, init);
  };
  let resumeR;
  try {
    const fd = new FormData();
    fd.append("routeId", R17);
    fd.append("rawText", "占位（RETRY_SAVE 不读取）");
    fd.append("resumeRequestId", "resume-1");
    resumeR = await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokA, fd), env }));
  } finally {
    global.fetch = realFetch;
  }
  check("RETRY_SAVE 复用 order 直接落库成功（success=true）", resumeR.success === true && resumeR.waybill && resumeR.waybill.id === "wb-resume-1", "code=" + (resumeR.code) + " id=" + (resumeR.waybill && resumeR.waybill.id));
  const savedWb = read("waybill:wb-resume-1");
  check("RETRY_SAVE 已写入主记录（schemaVersion=2）", savedWb && savedWb.schemaVersion === "2");
  const inIndex = (red.command(["SMEMBERS", IDX(R17) + TODAY]) || []).includes("wb-resume-1");
  check("RETRY_SAVE 已写入当日线路索引", inIndex === true);
  check("P1-4 关键：RETRY_SAVE 全程未调用 OCR 服务（ocrCalls=0）", ocrCalls === 0, "ocrCalls=" + ocrCalls);
  // 旧保存票据保持 FAILED（RETRY_SAVE 只新建一张处理票据并标记 DONE，不触碰原失败票据）
  const oldTicket = read("waybill:proc:resume-1");
  check("RETRY_SAVE 未改写原 FAILED 票据（仍为 FAILED 且保留 order）", oldTicket && oldTicket.stage === "FAILED" && !!oldTicket.order);
  // 越权保护：另一普通用户（B，route-18）不可借用户 A 的 resumeRequestId 重保存。
  // B 须带本人会话线路(R18)才能越过「线路切换」前置校验、真正抵达 resume 票据用户隔离判断。
  const bResume = await (async () => {
    const fd = new FormData();
    fd.append("routeId", R18); fd.append("rawText", "x"); fd.append("resumeRequestId", "resume-1");
    return await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokB, fd), env }));
  })();
  check("RETRY_SAVE 票据用户隔离：他人(B)借 A 的 resume 被拒（422 RESUME_INVALID）", bResume.success !== true && bResume.code === "RESUME_INVALID", "code=" + (bResume.code));

  // ===================================================================
  console.log("─".repeat(56));
  console.log("诊断权限 / RETRY_SAVE / 统计作用域去重 回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
