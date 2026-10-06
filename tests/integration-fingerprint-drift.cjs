// 业务指纹「漂移」回归 —— 直接复现 2026-10-07 线上巡检报告的 8 条悬空指纹键
// ------------------------------------------------------------------
// 线上报告摘要（route_scope=单线路，degraded=false）：
//   scanned: waybills 29 / fingerprintKeys 37 / dedupeKeys 9
//   issues:  ORPHAN_FINGERPRINT_KEY × 8（全部 auto，fix = DEL）
//
// 成因链条：
//   businessFingerprint = sha256(routeId, date, vehicle, totalWeight,
//                                stores[{storeId, name, routeOrder, pending}])
//   → 「pending」入指纹，而 confirm 补齐待定门店会把 pending 由 true 改 false、并补 storeId
//   → 确认后指纹**必然漂移**，commitScript 写入新键 zp:waybill:fingerprint:<fp2>
//   → 旧键 zp:waybill:fingerprint:<fp1> 仍指向本单，且再无人回收
//   → 日后删除该单时，history.js 只清理 record.businessFingerprint（当前的 fp2）
//   → fp1 键永久指向一个已删除的 id，就是那 8 条 ORPHAN_FINGERPRINT_KEY
//
// 而旧删除用例(integration-waybill-delete-cleanup)假设「一张单一个指纹键」且从不经过
// confirm.js，所以漂移路径完全没被覆盖 —— 这正是它逃逸的原因。
//
// 运行：node tests/integration-fingerprint-drift.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const todayCN = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(p.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const seed = (k, o) => red._set("zp:" + k, JSON.stringify(o));
const getReq = (url, t) => ({ url, headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + t : null) } });
const postFormReq = (url, t, fd) => ({ url, headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + t : null) }, formData: async () => fd });
const postJsonReq = (url, t, b) => ({ url, headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + t : null) }, json: async () => b });
const toJson = async r => await r.json();

/** 所有指向某个运单 id 的**业务指纹键**（形式 zp:waybill:fingerprint:<sha256> -> id） */
function fingerprintKeysPointingTo(id) {
  return [...red.strings.keys()].filter(k => k.startsWith("zp:waybill:fingerprint:") && String(red.strings.get(k)) === String(id));
}

(async () => {
  const TODAY = todayCN();
  const TOKEN = "tok-fp", UID = "u-fp", ROUTE = "route-fp";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const confirmMod = await import(baseDir + "waybills/confirm.js");
  const historyMod = await import(baseDir + "history.js");
  const { scanConsistency } = await import(baseDir + "waybills/_consistency.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  seed("session:" + TOKEN, { userId: UID, sessionVersion: 1 });
  seed("user:" + UID, { id: UID, username: "fp", name: "指纹测试", role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  seed("route:" + ROUTE, { id: ROUTE, name: "指纹线路", status: "active" });
  seed("route:" + ROUTE + ":base", {
    routeId: ROUTE, version: 1, updatedBy: UID, updatedAt: new Date().toISOString(),
    stores: [
      { storeId: "JM03050", name: "谊品生鲜温馨家园南门店", originalName: "谊品生鲜温馨家园南门店", aliases: [], navigation: null, routeOrder: 1, note: "" },
      { storeId: "A1001", name: "华润万家梅林店", originalName: "华润万家梅林店", aliases: [], navigation: null, routeOrder: 2, note: "" }
    ]
  });

  // ============ 【1】上传含未知门店 → PLANNED（存在 pending）============
  const rawText = `运输日期 ${TODAY}\n车牌号 粤B54321\n总重量 1.2吨\n谊品生鲜温馨家园南门店 -> 华润万家梅林店 -> 天虹商场龙华店`;
  const fd = new FormData();
  fd.append("routeId", ROUTE);
  fd.append("rawText", rawText);
  const P = await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", TOKEN, fd), env }));
  if (!P.success) console.log("DEBUG P =", JSON.stringify(P).slice(0, 400));
  check("上传处理成功", P.success === true);
  check("存在待定门店 → stage=PLANNED", P.waybill?.stage === "PLANNED", "stage=" + P.waybill?.stage);
  const id = P.waybill?.id;
  const fp1 = P.waybill?.businessFingerprint;
  check("已写入上市时指纹键", !!fp1 && String(red._get("zp:waybill:fingerprint:" + fp1)) === String(id), "fp1=" + String(fp1).slice(0, 12));

  // ============ 【2】确认补齐待定门店 → 指纹漂移 ============
  const pendingIdx = P.waybill.stores.findIndex(s => s.pending);
  check("定位到待定门店下标", pendingIdx >= 0, "idx=" + pendingIdx);
  const C = await toJson(await confirmMod.onRequestPost({
    request: postJsonReq("https://app.local/api/waybills/confirm", TOKEN, {
      waybillId: id, confirmRequestId: "cr-fp-1",
      confirmations: [{ index: pendingIdx, action: "new", standardName: "天虹商场龙华店" }]
    }), env
  }));
  if (!C.success) console.log("DEBUG C =", JSON.stringify(C).slice(0, 400));
  check("确认成功", C.success === true);
  check("确认后无待定门店", (C.waybill?.stores || []).every(s => !s.pending));
  const fp2 = C.waybill?.businessFingerprint;
  check("确认导致指纹漂移（fp2≠fp1）", !!fp2 && fp2 !== fp1, String(fp1).slice(0, 10) + " → " + String(fp2).slice(0, 10));

  console.log("【3】核心断言：漂移后本单**只能留下一个**指纹键");
  const owned = fingerprintKeysPointingTo(id);
  check("指向本单的指纹键恰好 1 个（漂移前的旧键已回收）", owned.length === 1, "keys=" + owned.length);
  check("保留的是确认后的新指纹键", owned.length === 1 && owned[0] === "zp:waybill:fingerprint:" + fp2);
  check("漂移前的旧指纹键已不存在", !red.strings.has("zp:waybill:fingerprint:" + fp1));

  // ============ 【4】删除本单 → 巡检不得报出悬空指纹键 ============
  const D = await toJson(await historyMod.onRequestDelete({
    request: getReq(`https://app.local/api/waybills/history?date=${TODAY}&waybillId=${id}&routeId=${ROUTE}`, TOKEN), env
  }));
  check("删除成功", D.success === true, "code=" + (D.code || "-"));
  check("主记录已删除", red._get("zp:waybill:" + id) === null);
  check("删除后无任何指向本单的指纹键残留", fingerprintKeysPointingTo(id).length === 0,
    "残留=" + fingerprintKeysPointingTo(id).map(k => k.slice(24, 34)).join(","));

  const rep = await scanConsistency(env, { routeId: ROUTE });
  const orphanFp = rep.issues.filter(i => i.type === "ORPHAN_FINGERPRINT_KEY");
  check("巡检不再报出悬空指纹键（线上那 8 条的成因已消除）", orphanFp.length === 0,
    JSON.stringify(rep.summary.counts));
  check("巡检结论完整可信", rep.degraded === false, "degraded=" + rep.degraded);

  console.log("\nFINGERPRINT_DRIFT 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
