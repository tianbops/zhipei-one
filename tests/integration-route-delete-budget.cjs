// 1.1 可靠性：线路删除路径子请求预算 + 完整清理回归
// ------------------------------------------------------------------
// 背景（2026-10-07 收口）：cleanupRouteWaybills 旧实现为
//   SCAN 全部 `zp:waybill:*` → 逐键 GET 过滤 routeId → 再对每张运单 SCAN 子键，
//   成本 O(全线路运单总数)。删除运单多的线路会越过 Workers 子请求上限 → Error 1101。
// 本用例断言（在 MiniRedis 上统计一次删除产生的 Redis REST 调用次数）：
//   1. 删除一条含多张运单的线路，子请求数在预算内（远低于平台约 50 上限）；
//   2. 该线路的全部运单键（主键 / 事件 / 处理票据 / 指纹 / 去重 / 日期桶）都被清掉；
//   3. 运单量过大的线路，删除被**明确拒绝**（结构化 JSON），绝不静默触发 1101。
// 运行：node tests/integration-route-delete-budget.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let dailyWaybillKey = null;

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

// makeUpstash 已接管 global.fetch；再包一层计数，每个 fetch = 1 次子请求
const BASE_BUDGET = 20;
let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const set = (k, o) => red.command(["SET", "zp:" + k, typeof o === "string" ? o : JSON.stringify(o)]);
const exists = async k => { const v = await red.command(["GET", "zp:" + k]); return v !== null && v !== undefined; };

const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

async function seedWaybill(route, i) {
  const date = DATES[i % DATES.length];
  const id = "W" + route + "-" + i;
  const rec = {
    schemaVersion: "2", id, routeId: route, routeName: "删除预算线路", date,
    vehicle: "粤B" + String(i).padStart(4, "0"), totalWeight: 0.1, stores: [{ storeId: "S" + i, name: "门店" + i, routeOrder: i, pending: false }],
    businessFingerprint: "fp-" + id, requestId: "req-" + id,
    summary: { original: 1, total: 1, matched: 1, pending: 0, correction: 0, merged: 0, newStores: 0 },
    stage: "CONFIRMED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
    createdBy: "uDel", createdAt: date + "T08:00:00.000Z", quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null }
  };
  await set("waybill:" + id, rec);
  await red.command(["SADD", "zp:route:" + route + ":waybills:" + date, id]);
  await red.command(["RPUSH", "zp:waybill:" + id + ":events", JSON.stringify({ t: date + "T08:00:00.000Z", event: "WAYBILL_CREATED" })]);
  await set("waybill:fingerprint:" + rec.businessFingerprint, id);
  await set("waybill:proc:" + rec.requestId, JSON.stringify({ requestId: rec.requestId, waybillId: id }));
  const sig = await dailyWaybillKey(rec);
  await set("waybill:dedupe:" + sig, id);
  return { id, date, fp: rec.businessFingerprint, req: rec.requestId, dedupeSig: sig };
}

(async () => {
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const routesMod = await import(baseDir + "routes.js");
  ({ dailyWaybillKey } = await import(baseDir + "_waybill-identity.js"));
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };

  // ---------- 场景 1：正常规模线路删除（应为 O(路线运单量) 常数级） ----------
  const R = "route-del-budget";
  const uDriver = "uDel-driver", uDelivery = "uDel-delivery", uAdm = "uDel-admin", tokAdm = "tokDel-admin";
  await set("user:" + uDriver, { id: uDriver, role: "user", boundRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  await set("user:" + uDelivery, { id: uDelivery, role: "user", boundRouteId: R, routeDuty: "delivery", sessionVersion: 1 });
  await set("user:" + uAdm, { id: uAdm, role: "admin", sessionVersion: 1 });
  await set("session:" + tokAdm, { userId: uAdm, sessionVersion: 1 });
  await set("routes:index", JSON.stringify([R]));
  await set("route:" + R, { id: R, name: "删除预算线路", status: "active", driverUserId: uDriver, deliveryUserId: uDelivery });
  await set("route-requests:index", JSON.stringify([]));

  const N = 40;
  const seeded = [];
  for (let i = 1; i <= N; i++) seeded.push(await seedWaybill(R, i));

  const delReq = (routeId) => ({
    url: "https://app.local/api/routes",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tokAdm : null) },
    json: async () => ({ action: "delete", routeId })
  });

  console.log("【1】删除含 " + N + " 张运单（跨 " + DATES.length + " 个日期桶）的线路：子请求在预算内且清理完整");
  subrequests = 0;
  const r1 = await routesMod.onRequestPost({ request: delReq(R), env });
  const j1 = await r1.json();
  check("删除返回成功", j1.success === true, "HTTP " + r1.status + " | " + JSON.stringify(j1).slice(0, 120));
  check("waybillDeleted 为键删除数（主键+事件+票据+指纹+去重+" + DATES.length + " 桶）", j1.waybillDeleted === N * 5 + DATES.length, "waybillDeleted=" + j1.waybillDeleted + " 期望=" + (N * 5 + DATES.length));
  check("子请求数 ≤ " + BASE_BUDGET + "（远低于 Workers 约 50 上限）", subrequests <= BASE_BUDGET, "subrequests=" + subrequests);

  // 主键 / 事件 / 处理票据 / 指纹 / 去重 / 日期桶 全部应消失
  let allGone = true, remain = [];
  for (const s of seeded) {
    if (await exists("waybill:" + s.id)) { allGone = false; remain.push("primary:" + s.id); }
    if (await exists("waybill:" + s.id + ":events")) { allGone = false; remain.push("events:" + s.id); }
    if (await exists("waybill:proc:" + s.req)) { allGone = false; remain.push("proc:" + s.req); }
    if (await exists("waybill:fingerprint:" + s.fp)) { allGone = false; remain.push("fp:" + s.fp); }
    if (await exists("waybill:dedupe:" + s.dedupeSig)) { allGone = false; remain.push("dedupe:" + s.dedupeSig); }
  }
  for (const d of DATES) if (await exists("route:" + R + ":waybills:" + d)) { allGone = false; remain.push("bucket:" + d); }
  check("全部 " + N + " 张运单的 6 类键 + " + DATES.length + " 个日期桶均被删除", allGone, remain.slice(0, 5).join(","));
  check("线路 base 键已清理", !(await exists("route:" + R + ":base")));

  // ---------- 场景 2：运单量过大的线路，删除被明确拒绝（不得 1101） ----------
  console.log("【2】运单量过大：删除被结构化拒绝，绝不静默触发 1101");
  const RB = "route-del-toobig";
  await set("user:" + "uB-driver", { id: "uB-driver", role: "user", boundRouteId: RB, routeDuty: "driver", sessionVersion: 1 });
  await set("user:" + "uB-delivery", { id: "uB-delivery", role: "user", boundRouteId: RB, routeDuty: "delivery", sessionVersion: 1 });
  await set("routes:index", JSON.stringify([R, RB]));
  await set("route:" + RB, { id: RB, name: "超大线路", status: "active", driverUserId: "uB-driver", deliveryUserId: "uB-delivery" });
  await set("route-requests:index", JSON.stringify([]));
  const BIG = 760; // 估算子请求 > 40（1 + 1 + 8 + 39 ≈ 49）
  for (let i = 1; i <= BIG; i++) {
    const id = "WB-" + i;
    await set("waybill:" + id, { id, routeId: RB, date: "2026-10-09", vehicle: "粤B0001", totalWeight: 0.1, stores: [], schemaVersion: "2" });
    await red.command(["SADD", "zp:route:" + RB + ":waybills:2026-10-09", id]);
  }
  const reqBig = delReq(RB);
  let threw = null, r2 = null;
  try { r2 = await routesMod.onRequestPost({ request: reqBig, env }); }
  catch (e) { threw = e; }
  const j2 = r2 ? await r2.json() : null;
  check("handler 未向外抛异常（不会变成 Cloudflare 错误页）", threw === null, threw ? String(threw.message) : "");
  check("返回结构化 JSON 且 success=false", !!j2 && j2.success === false, j2 ? JSON.stringify(j2).slice(0, 160) : "null");
  check("拒绝原因指向「线路运单量过大」", !!j2 && /线路运单量过大/.test(j2.detail || j2.error || ""), j2 && (j2.detail || j2.error));
  check("超大线路的运单主键未被误删（删除已中止）", await exists("waybill:WB-1") && await exists("waybill:WB-" + BIG));

  console.log("\nROUTE_DELETE_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
