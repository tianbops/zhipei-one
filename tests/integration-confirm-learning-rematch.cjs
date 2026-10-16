/**
 * confirm -> route base/learning -> next waybill rematch regression.
 * Covers the core closure that was previously missing from the test suite:
 *   1) confirm merge writes the route identity/alias, next waybill rematches the same storeId;
 *   2) confirm new creates a stable storeId in the route base, next waybill rematches that storeId;
 *   3) a confirmed identity must not silently create a second store on the next upload.
 */
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
const ROUTE = "route-confirm-rematch";
const USER = "u-confirm";
const TOKEN = "tok-confirm";

const seed = (key, obj) => red._set("zp:" + key, JSON.stringify(obj));
const read = (key) => {
  const raw = red._get("zp:" + key);
  return raw ? JSON.parse(raw) : null;
};
const jsonReq = (url, token, payload) => ({
  url,
  headers: { get: (h) => String(h).toLowerCase() === "authorization" ? "Bearer " + token : null },
  json: async () => payload,
});

async function asJson(resp) { return await resp.json(); }
function check(name, cond, info = "") {
  if (!cond) throw new Error(name + (info ? ": " + info : ""));
  console.log("  ✅ " + name + (info ? "  " + info : ""));
}

(async () => {
  const env = {
    UPSTASH_REDIS_REST_URL: "https://upstash.local",
    UPSTASH_REDIS_REST_TOKEN: "x",
  };

  seed("route:" + ROUTE, {
    status: "active",
    name: "确认回归线路",
    driverUserId: USER,
    deliveryUserId: null,
  });
  seed("user:" + USER, {
    id: USER,
    role: "user",
    boundRouteId: ROUTE,
    dispatchRouteId: ROUTE,
    routeDuty: "driver",
    sessionVersion: 1,
  });
  seed("session:" + TOKEN, { userId: USER, sessionVersion: 1 });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const confirmMod = await import(baseDir + "waybills/confirm.js");
  const identityMod = await import(baseDir + "_waybill-identity.js");

  const base = {
    routeId: ROUTE,
    version: 1,
    stores: [{
      storeId: "S001",
      name: "基准门店甲",
      originalName: "基准门店甲",
      aliases: [],
      navigation: null,
      routeOrder: 1,
      note: "",
    }],
  };
  seed("route:" + ROUTE + ":base", base);

  console.log("【1】merge：确认待定门店 → 线路资料 → 下一张运单继续命中同一 storeId");
  const mergeWaybillId = "wb-confirm-merge";
  seed("waybill:" + mergeWaybillId, {
    id: mergeWaybillId,
    routeId: ROUTE,
    date: "2026-10-08",
    vehicle: "渝DK7001",
    createdBy: USER,
    stage: "PLANNED",
    stores: [{
      rawName: "基准门店甲别名",
      name: "基准门店甲别名",
      storeId: null,
      pending: true,
      matchStatus: "pending",
      routeOrder: 1,
    }],
    summary: { total: 1, pending: 1 },
  });

  const oldMergeDedupeKey = await identityMod.dailyWaybillKey({
    routeId: ROUTE, date: "2026-10-08", vehicle: "渝DK7001", totalWeight: null,
    stores: [{ name: "基准门店甲别名" }]
  });
  const mergeResp = await confirmMod.onRequestPost({
    request: jsonReq("https://t.zp/api/waybills/confirm", TOKEN, {
      waybillId: mergeWaybillId,
      confirmRequestId: "req-merge-1",
      confirmations: [{ index: 0, action: "merge", storeId: "S001" }],
    }),
    env,
  });
  const merge = await asJson(mergeResp);
  check("merge confirmation succeeds", merge.success === true, JSON.stringify(merge));
  check("merge assigns S001", merge.waybill?.stores?.[0]?.storeId === "S001");
  check("merge closes pending state", merge.waybill?.stage === "CONFIRMED" && merge.waybill?.summary?.pending === 0);
  check("merge preserves planned route order", JSON.stringify((merge.waybill?.stores||[]).map(s=>[s.storeId,s.routeOrder])) === JSON.stringify([["S001",1]]), JSON.stringify(merge.waybill?.stores));
  check("merge refreshes daily dedupe key", typeof merge.waybill?.dailyDedupeKey === "string" && merge.waybill.dailyDedupeKey.length > 0);
  const newMergeDedupeKey = await identityMod.dailyWaybillKey(merge.waybill);
  check("daily dedupe key matches confirmed identity", merge.waybill?.dailyDedupeKey === newMergeDedupeKey);
  check("old pending-name dedupe key is retired", read("waybill:dedupe:" + oldMergeDedupeKey) === null);
  check("new confirmed-name dedupe key points to merge waybill", red._get("zp:waybill:dedupe:" + newMergeDedupeKey) === mergeWaybillId);
  const baseAfterMerge = read("route:" + ROUTE + ":base");
  check("merge persists raw identity as alias", baseAfterMerge?.stores?.some(s =>
    s.storeId === "S001" && (s.aliases || []).includes("基准门店甲别名")
  ));

  const nextMerge = await processMod.onRequestPost({
    request: {
      url: "https://t.zp/api/waybills/process",
      headers: { get: (h) => String(h).toLowerCase() === "authorization" ? "Bearer " + TOKEN : null },
      formData: async () => ({
        get: (k) => ({
          routeId: ROUTE,
          processingRouteId: ROUTE,
          rawText: "基准门店甲别名",
          date: "2026-10-08",
          vehicle: "渝DK7002",
        }[k] ?? null),
      }),
    },
    env,
  });
  const nextMergeJson = await asJson(nextMerge);
  const mergeItem = nextMergeJson.waybill?.stores?.[0];
  check("next merge waybill saves", nextMergeJson.success === true, JSON.stringify(nextMergeJson));
  check("next merge waybill rematches S001", mergeItem?.storeId === "S001", JSON.stringify(mergeItem));
  check("next merge waybill is not pending", mergeItem?.pending === false);
  const repeatMerge = await processMod.onRequestPost({
    request: {
      url: "https://t.zp/api/waybills/process",
      headers: { get: (h) => String(h).toLowerCase() === "authorization" ? "Bearer " + TOKEN : null },
      formData: async () => ({
        get: (k) => ({
          routeId: ROUTE,
          processingRouteId: ROUTE,
          rawText: "基准门店甲",
          date: "2026-10-08",
          vehicle: "渝DK7001",
        }[k] ?? null),
      }),
    },
    env,
  });
  const repeatMergeJson = await asJson(repeatMerge);
  check("same confirmed business reuses original waybill", repeatMergeJson.success === true && repeatMergeJson.idempotent === true && repeatMergeJson.waybill?.id === mergeWaybillId, JSON.stringify(repeatMergeJson));

  console.log("【2】new：确认新增门店 → 固化 storeId → 下一张运单继续命中，不生成重复门店");
  const newWaybillId = "wb-confirm-new";
  seed("waybill:" + newWaybillId, {
    id: newWaybillId,
    routeId: ROUTE,
    date: "2026-10-08",
    vehicle: "渝DK7003",
    createdBy: USER,
    stage: "PLANNED",
    stores: [{
      rawName: "新增门店乙",
      name: "新增门店乙",
      storeId: null,
      pending: true,
      matchStatus: "pending",
      routeOrder: 2,
    }],
    summary: { total: 1, pending: 1 },
  });

  const newResp = await confirmMod.onRequestPost({
    request: jsonReq("https://t.zp/api/waybills/confirm", TOKEN, {
      waybillId: newWaybillId,
      confirmRequestId: "req-new-1",
      confirmations: [{ index: 0, action: "new", standardName: "新增门店乙" }],
    }),
    env,
  });
  const created = await asJson(newResp);
  check("new confirmation succeeds", created.success === true, JSON.stringify(created));
  const createdStoreId = created.waybill?.stores?.[0]?.storeId;
  check("new creates a stable storeId", typeof createdStoreId === "string" && createdStoreId.length > 0);
  check("new confirmation closes pending state", created.waybill?.stage === "CONFIRMED" && created.waybill?.summary?.pending === 0);

  const baseAfterNew = read("route:" + ROUTE + ":base");
  const newBaseStore = baseAfterNew?.stores?.find(s => s.storeId === createdStoreId);
  check("new persists the store in route base", Boolean(newBaseStore), JSON.stringify(newBaseStore));

  const nextNew = await processMod.onRequestPost({
    request: {
      url: "https://t.zp/api/waybills/process",
      headers: { get: (h) => String(h).toLowerCase() === "authorization" ? "Bearer " + TOKEN : null },
      formData: async () => ({
        get: (k) => ({
          routeId: ROUTE,
          processingRouteId: ROUTE,
          rawText: "新增门店乙",
          date: "2026-10-08",
          vehicle: "渝DK7004",
        }[k] ?? null),
      }),
    },
    env,
  });
  const nextNewJson = await asJson(nextNew);
  const newItem = nextNewJson.waybill?.stores?.[0];
  check("next new-store waybill saves", nextNewJson.success === true, JSON.stringify(nextNewJson));
  check("next new-store waybill rematches the same storeId", newItem?.storeId === createdStoreId, JSON.stringify(newItem));
  check("next new-store waybill is not pending", newItem?.pending === false);

  const matchingBaseStores = (read("route:" + ROUTE + ":base")?.stores || [])
    .filter(s => s.storeId === createdStoreId);
  check("new store exists only once in route base", matchingBaseStores.length === 1);

  console.log("confirm -> base/learning -> next rematch regression passed");
})().catch((e) => {
  console.error("回归失败：", e);
  process.exit(1);
});
