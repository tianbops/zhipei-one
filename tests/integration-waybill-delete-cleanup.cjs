// 智配One · 删除运单反向去重键清理回归（1.1 收尾-根因修复）
// ------------------------------------------------------------------
// 历史 bug：history.js 删除运单只清主记录 + 索引 + 子键（事件链），
// 漏清两个「反向去重键」：zp:waybill:dedupe:<日签名> 与 zp:waybill:fingerprint:<业务指纹>，
// 二者仍指向已删 id → 成为孤儿，重传同签名可能落入 WAYBILL_DEDUPE_LOOKUP_FAILED / 被 P1.5 扫为 ORPHAN_DEDUPE_KEY。
//
// 修复（history.js deleteWaybill）：删除主记录前先读记录恢复反向键，删除后仅当
// 键仍指向本单才清掉；已被覆盖/再上传改派给新单的键不动（条件删除，保护幂等/覆盖链）。
//
// 本测试用 _mini-redis 真实加载 history.js，断言：
//   (1) 删除最新运单 → 主记录/索引/事件链/日去重键/业务指纹键 全部归零；
//   (2) 删除一个被「覆盖」的旧单（指纹键/日去重键已改派给新单）→ 这两个键不误删；
//   (3) 删除后同内容重传 → 不被 stale 孤儿卡住，正常落库且去重键/指纹键指向新单。
//
// ⚠️ 已知覆盖盲区（2026-10-07 由线上巡检报告暴露）：本用例手工组装记录并**不经过 confirm.js**，
// 因此隐含假设「一张运单只有一个业务指纹键」——而 businessFingerprint 含门店 pending 标记，
// 确认补齐待定门店会让指纹漂移，旧键继续指向本单并成为遗留孤儿（线上实测 8 条）。
// 该漂移路径由 tests/integration-fingerprint-drift.cjs 专门覆盖，改动 fingerprint 逻辑时请一并运行。
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
// 注意：本测试统一用「完整键」访问 Redis（如 "zp:waybill:xxx"），故下方读取 helper 不再补前缀。
const getRaw = (fullKey) => red.command(["GET", fullKey]);
const readJson = (fullKey) => { const r = getRaw(fullKey); return r ? JSON.parse(r) : null; };
const existsMembers = (fullKey) => { const m = red.command(["SMEMBERS", fullKey]); return Array.isArray(m) ? m.map(String) : []; };
// 子键（如事件链 zp:waybill:<id>:* 是 LIST，不能用 SMEMBERS 读）→ 用 SCAN 枚举，与 deleteWaybill 实际清理逻辑一致
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
  const ROUTE = "route-2001";
  const M = "uM";
  const tokM = "tok-M";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const historyMod = await import(baseDir + "history.js");
  const processMod = await import(baseDir + "waybills/process.js");
  const identityMod = await import(baseDir + "_waybill-identity.js");
  const { dailyWaybillKey, businessFingerprint } = identityMod;

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // 维护者（绑定线路，canMaintainRoute=true，可删本线路任何运单）
  seedJson("zp:user:" + M, { id: M, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-M", { userId: M, sessionVersion: 1 });
  seedJson("zp:route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });
  seedJson("zp:route:" + ROUTE + ":base", { routeId: ROUTE, version: 1, stores: [
    { storeId: "JM03050", name: "门店A", aliases: [], routeOrder: 1 },
    { storeId: "A1001", name: "门店B", aliases: [], routeOrder: 2 },
  ] });

  const buildRecord = (id, createdBy) => ({
    schemaVersion: "2", id, routeId: ROUTE, routeName: "线路2001", date: TODAY, vehicle: "粤B11111", totalWeight: 1.0,
    stores: [
      { storeId: "JM03050", name: "门店A", routeOrder: 1, pending: false, rawName: "门店A" },
      { storeId: "A1001", name: "门店B", routeOrder: 2, pending: false, rawName: "门店B" },
    ],
    stage: "CONFIRMED",
    summary: { original: 2, total: 2, matched: 2, pending: 0, correction: 0, merged: 0, newStores: 0 },
    createdBy, createdAt: new Date().toISOString(), requestId: "r-" + id,
    pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
    quality: { level: "OK", flags: [] }, processingRouteId: ROUTE, routeIdAtProcessing: ROUTE,
  });

  const delById = (id) => historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + id + "&routeId=" + ROUTE, tokM), env });
  const toJson = async (resp) => await resp.json();
  const indexKey = "zp:route:" + ROUTE + ":waybills:" + TODAY;

  // ===================================================================
  console.log("\n【1】删除「最新运单」→ 主记录/索引/事件链/日去重键/业务指纹键 全部归零");
  const wA = buildRecord("wA", M);
  wA.businessFingerprint = await businessFingerprint(wA);
  const sigA = await dailyWaybillKey(wA);
  const dedupeKeyA = "zp:waybill:dedupe:" + sigA;
  const fpKeyA = "zp:waybill:fingerprint:" + wA.businessFingerprint;
  seedJson("zp:waybill:" + wA.id, wA);
  red.command(["SADD", indexKey, wA.id]);
  red.command(["SET", dedupeKeyA, wA.id]);
  red.command(["SET", fpKeyA, wA.id]);
  red.command(["RPUSH", "zp:waybill:" + wA.id + ":events", JSON.stringify({ event: "WAYBILL_CREATED" })]);

  check("前置：主记录/索引/日去重键/指纹键/事件链 均已落地",
    !!readJson("zp:waybill:" + wA.id) && existsMembers(indexKey).includes(wA.id) &&
    getRaw(dedupeKeyA) === wA.id && getRaw(fpKeyA) === wA.id &&
    (await scanKeys("zp:waybill:" + wA.id + ":*")).length === 1);

  const r1 = await toJson(await delById(wA.id));
  check("删除返回成功 deleted=1", r1.success === true && r1.deleted === 1, "code=" + (r1.code) + " deleted=" + (r1.deleted));
  check("主记录已删", readJson("zp:waybill:" + wA.id) === null);
  check("索引条目已移除", !existsMembers(indexKey).includes(wA.id));
  check("事件链子键已删(SCAN 无残留)", (await scanKeys("zp:waybill:" + wA.id + ":*")).length === 0);
  check("日去重键已清(不再指向已删 wA)", getRaw(dedupeKeyA) === null, "val=" + getRaw(dedupeKeyA));
  check("业务指纹键已清(不再指向已删 wA)", getRaw(fpKeyA) === null, "val=" + getRaw(fpKeyA));

  // ===================================================================
  console.log("\n【2】条件删除安全：删除「被覆盖的旧单」，指纹键/日去重键已改派给新单 → 不误删");
  // A2 是被覆盖的旧单；B 是覆盖后的新单。两者业务指纹/日签名相同，saveScript 让键指向 B（最新）。
  const wA2 = buildRecord("wA2", M);
  wA2.businessFingerprint = await businessFingerprint(wA2);
  const sigA2 = await dailyWaybillKey(wA2);
  const wB = buildRecord("wB", M);
  wB.businessFingerprint = wA2.businessFingerprint; // 同指纹，模拟覆盖链
  const dedupeKeyShared = "zp:waybill:dedupe:" + sigA2; // 同日签名
  const fpKeyShared = "zp:waybill:fingerprint:" + wA2.businessFingerprint;

  seedJson("zp:waybill:wA2", wA2);
  seedJson("zp:waybill:wB", wB);
  red.command(["SADD", indexKey, "wA2"]);
  red.command(["SADD", indexKey, "wB"]);
  // 模拟「B 覆盖 A」后，反向键指向最新单 B（生产由 saveScript 维护）
  red.command(["SET", dedupeKeyShared, "wB"]);
  red.command(["SET", fpKeyShared, "wB"]);

  check("前置：反向键指向最新单 wB", getRaw(dedupeKeyShared) === "wB" && getRaw(fpKeyShared) === "wB");

  const r2 = await toJson(await delById("wA2")); // 删除旧单 wA2
  check("删除旧单 wA2 成功", r2.success === true && r2.deleted === 1, "code=" + (r2.code));
  check("旧单 wA2 主记录已删", readJson("zp:waybill:wA2") === null);
  check("条件删除：指纹键仍指向 wB（未被误删）", getRaw(fpKeyShared) === "wB", "val=" + getRaw(fpKeyShared));
  check("条件删除：日去重键仍指向 wB（未被误删）", getRaw(dedupeKeyShared) === "wB", "val=" + getRaw(dedupeKeyShared));
  check("新单 wB 主记录仍在（覆盖链完整）", !!readJson("zp:waybill:wB"));

  // ===================================================================
  console.log("\n【3】删后同内容重传 → 不被 stale 孤儿卡住，正常落库且去重键/指纹键指向新单");
  // 删除 wB（此时反向键指向 wB）；再以完全相同内容重传，应新建且反向键指向新单。
  const r3 = await toJson(await delById("wB"));
  check("删除 wB 成功", r3.success === true && r3.deleted === 1, "code=" + (r3.code));
  check("删后反向键已随 wB 清理", getRaw(dedupeKeyShared) === null && getRaw(fpKeyShared) === null);

  const fd = new FormData();
  fd.append("routeId", ROUTE);
  fd.append("rawText", `运输日期 ${TODAY}\n车牌号 粤B11111\n总重量 1.0吨\n门店A -> 门店B`);
  const reR = await toJson(await processMod.onRequestPost({ request: { url: "https://app.local/api/waybills/process", headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + tokM : null) }, formData: async () => fd }, env }));
  check("删后同内容重传成功(未被 stale 孤儿卡住)", reR.success === true && !!reR.waybill?.id, "code=" + (reR.code) + " err=" + (reR.error));
  check("重传为新建(NEW, 非 DAILY/FINGERPRINT 误判)", reR.idempotent !== true, "idempotent=" + (reR.idempotent));
  const newId = reR.waybill?.id;
  if (newId) {
    const newRec = readJson("zp:waybill:" + newId);
    check("新单已落库", !!newRec);
    const newSig = await dailyWaybillKey(newRec);
    check("重传后日去重键指向新单", getRaw("zp:waybill:dedupe:" + newSig) === newId, "val=" + getRaw("zp:waybill:dedupe:" + newSig));
    check("重传后指纹键指向新单", getRaw("zp:waybill:fingerprint:" + newRec.businessFingerprint) === newId, "val=" + getRaw("zp:waybill:fingerprint:" + newRec.businessFingerprint));
  } else {
    check("新单已落库", false, "无 newId");
  }

  // ===================================================================
  console.log("─".repeat(56));
  console.log("删除反向去重键清理回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
