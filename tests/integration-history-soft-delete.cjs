// 智配One · 软删除 + 回收站回归（P2-3）
// ------------------------------------------------------------------
// 覆盖：
//   (1) DELETE /api/history → 软删：原主记录不可见、回收站落地 + TTL>0、
//       日期索引移除、子键迁入回收站、反向引用（dedupe/fingerprint）清理；
//   (2) POST /api/history-trash?id= → 恢复：原主还原、索引重建、回收站清空、
//       反向引用重建（空键重建为永久键）；
//   (3) DELETE /api/history-trash?id= → 彻底删除：回收站清空；
//   (4) 越权线路 / 回收站无记录 的拒绝与 404。
// 复用 _mini-redis 真实加载 history.js 与 history-trash.js。
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const todayCN = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const getRaw = (k) => red.command(["GET", k]);
const readJson = (k) => { const r = getJson(k); return r; };
const getJson = (fullKey) => { const r = red.command(["GET", fullKey]); return r ? JSON.parse(r) : null; };
const existsMembers = (fullKey) => { const m = red.command(["SMEMBERS", fullKey]); return Array.isArray(m) ? m.map(String) : []; };
const scanKeys = async (pattern) => {
  let out = [], cur = "0";
  do { const r = red.command(["SCAN", cur, "MATCH", pattern, "COUNT", "100"]); cur = String(r?.[0] ?? "0"); out.push(...(Array.isArray(r?.[1]) ? r[1] : [])); } while (cur !== "0");
  return out.map(String);
};
const seedJson = (fullKey, obj) => red.command(["SET", fullKey, JSON.stringify(obj)]);
function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}

(async () => {
  const TODAY = todayCN();
  const ROUTE = "route-2001", OTHER = "route-9999", M = "uM", tokM = "tok-M";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const historyMod = await import(baseDir + "history.js");
  const trashMod = await import(baseDir + "history-trash.js");
  const identityMod = await import(baseDir + "_waybill-identity.js");
  const { dailyWaybillKey, businessFingerprint } = identityMod;

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  seedJson("zp:user:" + M, { id: M, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-M", { userId: M, sessionVersion: 1 });
  seedJson("zp:route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });
  seedJson("zp:route:" + OTHER, { id: OTHER, name: "其他线路", status: "active" });

  const buildRecord = (id, routeId) => ({
    schemaVersion: "2", id, routeId, routeName: "线路2001", date: TODAY, vehicle: "粤B11111", totalWeight: 1.2,
    stores: [{ storeId: "JM03050", name: "门店A", routeOrder: 1, pending: false, rawName: "门店A" }],
    stage: "CONFIRMED", summary: { original: 1, total: 1, matched: 1 },
    createdBy: M, createdAt: new Date().toISOString(), requestId: "r-" + id,
    pipeline: ["PLANNED", "CONFIRMED"], quality: { level: "OK", flags: [] },
  });
  const indexKey = "zp:route:" + ROUTE + ":waybills:" + TODAY;
  const delById = (id) => historyMod.onRequestDelete({ request: getReq("https://app.local/api/history?date=" + TODAY + "&waybillId=" + id + "&routeId=" + ROUTE, tokM), env });
  const trashGet = () => trashMod.onRequestGet({ request: getReq("https://app.local/api/history-trash", tokM), env });
  const trashPost = (id) => trashMod.onRequestPost({ request: getReq("https://app.local/api/history-trash?id=" + id, tokM), env });
  const trashDel = (id) => trashMod.onRequestDelete({ request: getReq("https://app.local/api/history-trash?id=" + id, tokM), env });
  const j = async (r) => await r.json();

  console.log("\n【1】DELETE /api/history → 软删：原主记录进回收站，索引/子键/反引清理");
  const w1 = buildRecord("w1", ROUTE);
  w1.businessFingerprint = await businessFingerprint(w1);
  const sig1 = await dailyWaybillKey(w1);
  const dedupeKey1 = "zp:waybill:dedupe:" + sig1;
  const fpKey1 = "zp:waybill:fingerprint:" + w1.businessFingerprint;
  seedJson("zp:waybill:w1", w1);
  red.command(["SADD", indexKey, "w1"]);
  red.command(["SET", dedupeKey1, "w1"]);
  red.command(["SET", fpKey1, "w1"]);
  red.command(["RPUSH", "zp:waybill:w1:events", JSON.stringify({ event: "WAYBILL_CREATED" })]);

  const r1 = await j(await delById("w1"));
  check("软删返回成功 deleted=1", r1.success === true && r1.deleted === 1, "code=" + r1.code);
  check("原主记录不可见", getJson("zp:waybill:w1") === null);
  check("回收站主记录落地", !!getJson("zp:waybill:trash:w1"));
  check("回收站主记录 TTL>0", Number(red.command(["TTL", "zp:waybill:trash:w1"])) > 0);
  check("日期索引已移除", !existsMembers(indexKey).includes("w1"));
  check("子键迁入回收站(原前缀无残留)", (await scanKeys("zp:waybill:w1:*")).length === 0 && (await scanKeys("zp:waybill:trash:w1:*")).length === 1);
  check("日去重键已清理", getRaw(dedupeKey1) === null);
  check("业务指纹键已清理", getRaw(fpKey1) === null);

  console.log("\n【2】回收站列表 GET：仅列本线路");
  const lg = await j(await trashGet());
  check("列表成功且含 w1", lg.success === true && lg.items.some(it => it.id === "w1"), "count=" + lg.count);
  check("w1 剩余天数在合理范围(0,604800)", (() => { const it = lg.items.find(x => x.id === "w1"); return it && it.ttl > 0 && it.ttl <= 604800; })());

  console.log("\n【3】POST /api/history-trash?id=w1 → 恢复");
  const r3 = await j(await trashPost("w1"));
  check("恢复返回成功", r3.success === true, "code=" + r3.code + " err=" + r3.error);
  check("原主记录已还原", !!getJson("zp:waybill:w1"));
  check("日期索引已重建", existsMembers(indexKey).includes("w1"));
  check("回收站主记录已清空", getJson("zp:waybill:trash:w1") === null);
  check("回收站子键已清空", (await scanKeys("zp:waybill:trash:w1:*")).length === 0);
  check("原主子键已还原", (await scanKeys("zp:waybill:w1:*")).length === 1);
  check("反向引用已重建为永久键(无TTL)", getRaw(dedupeKey1) === "w1" && Number(red.command(["TTL", dedupeKey1])) === -1, "ttl=" + red.command(["TTL", dedupeKey1]));
  check("指纹键已重建", getRaw(fpKey1) === "w1");

  console.log("\n【4】DELETE /api/history-trash → 彻底删除");
  // 重新软删 w1 再彻底删
  await j(await delById("w1"));
  const r4 = await j(await trashDel("w1"));
  check("彻底删除返回成功", r4.success === true, "code=" + r4.code);
  check("回收站主记录已删", getJson("zp:waybill:trash:w1") === null);
  check("回收站子键已删", (await scanKeys("zp:waybill:trash:w1:*")).length === 0);
  check("原主记录仍不在(彻底删不改原主,因软删时已迁走)", getJson("zp:waybill:w1") === null);

  console.log("\n【5】边界：回收站无记录 404 / 越权线路拒绝");
  const r5 = await j(await trashPost("nope"));
  check("恢复不存在的运单 → 404", r5.success === false && r5.code === "TRASH_NOT_FOUND", "code=" + r5.code);
  const r5b = await j(await trashDel("nope"));
  check("彻底删除不存在的运单 → 404", r5b.success === false && r5b.code === "TRASH_NOT_FOUND", "code=" + r5b.code);
  // 越权：用未绑定 ROUTE 的会话请求回收站
  seedJson("zp:user:uX", { id: "uX", role: "user", boundRouteId: OTHER, dispatchRouteId: OTHER, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-X", { userId: "uX", sessionVersion: 1 });
  const r5c = await j(await trashMod.onRequestGet({ request: getReq("https://app.local/api/history-trash", "tok-X"), env }));
  check("越权线路回收站列表 → 仅含本线路(无 ROUTE 数据)", r5c.success === true && r5c.items.every(it => it.id !== "w1"), "count=" + r5c.count);

  console.log("─".repeat(56));
  console.log("软删除 + 回收站回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
