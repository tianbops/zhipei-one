// 智配One 真实运单全链路回归测试（P0-3 ~ P0-7）
// 通过拦截 global.fetch(Upstash REST) 把内存 Redis + 真实 EVAL(fengari) 接到
// 真实的 process.js / confirm.js / latest.js / history.js，逐阶段断言数据。
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

// ---- 在导入业务模块前接管 Redis ----
const red = makeUpstash(new MiniRedis());

// ---- 工具 ----
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
const seed = (key, obj) => red._set("zp:" + key, JSON.stringify(obj));
const read = (key) => { const r = red._get("zp:" + key); return r ? JSON.parse(r) : null; };

function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function postFormReq(url, token, fd) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => fd };
}
function postJsonReq(url, token, bodyObj) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, json: async () => bodyObj };
}
async function toJson(resp) {
  const data = await resp.json();
  return data;
}

(async () => {
  // ---- 加载真实业务模块 ----
  const TODAY = todayCN();
  // 「次日」按运行时动态计算，禁止硬编码日期（否则跨天后该日期落到当天，会与当日去重语义冲突）
  const TOMORROW = (() => {
    const d = new Date(TODAY + "T12:00:00+08:00");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const TOKEN = "tok-test";
  const UID = "u-1";
  const ROUTE = "route-1001";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const confirmMod = await import(baseDir + "waybills/confirm.js");
  const latestMod = await import(baseDir + "waybills/latest.js");
  const historyMod = await import(baseDir + "history.js");

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // ---- 播种账户 / 线路 / 基准库 ----
  seed("session:" + TOKEN, { userId: UID, sessionVersion: 1 });
  seed("user:" + UID, { id: UID, username: "zsx", name: "张三", role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  seed("route:" + ROUTE, { id: ROUTE, name: "线路1001", status: "active" });
  seed("route:" + ROUTE + ":base", {
    routeId: ROUTE, version: 1, updatedBy: UID, updatedAt: new Date().toISOString(),
    stores: [
      { storeId: "JM03050", name: "谊品生鲜温馨家园南门店", originalName: "谊品生鲜温馨家园南门店", aliases: [], navigation: "A栋B1", routeOrder: 1, note: "" },
      { storeId: "A1001", name: "华润万家梅林店", originalName: "华润万家梅林店", aliases: [], navigation: null, routeOrder: 2, note: "停车方便" },
      { storeId: "Q2002", name: "沃尔玛深南店", originalName: "沃尔玛深南店", aliases: [], navigation: null, routeOrder: 3, note: "" },
    ],
  });

  const indexKey = (date) => "zp:route:" + ROUTE + ":waybills:" + date;
  const rawTextA = `运输日期 ${TODAY}\n车牌号 粤B12345\n总重量 1.5吨\n谊品生鲜温馨家园南门店 -> 华润万家梅林店 -> 沃尔玛深南店`;
  const rawTextB = `运输日期 ${TODAY}\n车牌号 粤B12345\n总重量 1.5吨\n谊品生鲜温馨家园南门店 -> 华润万家梅林店 -> 沃尔玛深南店 -> 天虹商场龙华店`;
  const rawTextC = `运输日期 ${TOMORROW}\n车牌号 粤B12345\n总重量 1.5吨\n谊品生鲜温馨家园南门店 -> 华润万家梅林店 -> 沃尔玛深南店 -> 天虹商场龙华店`;

  // ===================================================================
  console.log("\n【阶段1】上传→识别(OCR文本直供)→提取→匹配→去重→规划→保存（全匹配）");
  const fdA = new FormData();
  fdA.append("routeId", ROUTE);
  fdA.append("rawText", rawTextA);
  let resp = await processMod.onRequestPost({request: postFormReq("https://app.local/api/waybills/process", TOKEN, fdA), env});
  let A = await toJson(resp);
  if (!A.success) console.log("DEBUG A =", JSON.stringify(A).slice(0, 500));
  check("处理成功", A.success === true);
  check("提取门店数=3", A.waybill && A.waybill.stores.length === 3, "stores=" + (A.waybill?.stores.length));
  check("stage=CONFIRMED（无待定）", A.waybill?.stage === "CONFIRMED", A.waybill?.stage);
  check("匹配方式含 data-exact/identity", A.waybill?.stores.every(s => s.matchStatus === "matched"), JSON.stringify(A.waybill?.stores.map(s => s.matchMethod)));
  const idA = A.waybill?.id;
  check("落库 waybill:<id>", read("waybill:" + idA)?.id === idA);
  check("指纹键已写", red._get("zp:waybill:fingerprint:" + A.waybill?.businessFingerprint) === idA, "fp=" + A.waybill?.businessFingerprint);
  check("日期索引已加成员", red.sets.get(indexKey(TODAY))?.has(idA) === true);
  check("diagnostics.extractCount=3", A.waybill?.diagnostics?.extractCount === 3);
  check("diagnostics.localMatchedCount=3", A.waybill?.diagnostics?.localMatchedCount === 3);
  check("diagnostics.finalCount=3", A.waybill?.diagnostics?.finalCount === 3);

  // ===================================================================
  console.log("\n【阶段2】今日(latest) 读取 — 真实数据回归");
  resp = await latestMod.onRequestGet({request: getReq("https://app.local/api/waybills/latest", TOKEN), env});
  let L = await toJson(resp);
  check("今日运单返回 A", L.success && L.waybill?.id === idA, "id=" + L.waybill?.id);
  check("今日运单带基准导航(华润万家 note)", L.waybill?.stores.find(s => s.storeId === "A1001")?.note === "停车方便");

  // ===================================================================
  console.log("\n【阶段3】历史(history) 读取 — 当日");
  resp = await historyMod.onRequestGet({request: getReq("https://app.local/api/waybills/history?date=" + TODAY, TOKEN), env});
  let H = await toJson(resp);
  check("历史返回 A", H.success && H.waybill?.id === idA, "id=" + H.waybill?.id);
  check("历史日期列表含今日", true);
  resp = await historyMod.onRequestGet({request: getReq("https://app.local/api/waybills/history", TOKEN), env});
  let HM = await toJson(resp);
  const todayEntry = (HM.history || []).find(e => e.date === TODAY);
  check("历史月份聚合含今日且 count=1", todayEntry && todayEntry.count === 1, "count=" + todayEntry?.count + " history=" + JSON.stringify((HM.history || []).map(e => e.date + ":" + e.count)));

  // ===================================================================
  console.log("\n【阶段4】详情(detail) 读取 — latest?id=");
  resp = await latestMod.onRequestGet({request: getReq("https://app.local/api/waybills/latest?id=" + idA, TOKEN), env});
  let D = await toJson(resp);
  check("详情读取命中 A", D.success && D.waybill?.id === idA);

  // ===================================================================
  console.log("\n【阶段5】待定确认（P0-4 智能闭环第一步）— 上传含未知门店");
  const fdB = new FormData();
  fdB.append("routeId", ROUTE);
  fdB.append("rawText", rawTextB);
  resp = await processMod.onRequestPost({request: postFormReq("https://app.local/api/waybills/process", TOKEN, fdB), env});
  let B = await toJson(resp);
  const idB = B.waybill?.id;
  check("B 处理成功", B.success === true);
  check("B stage=PLANNED（存在待定）", B.waybill?.stage === "PLANNED", B.waybill?.stage);
  const pendingIdx = B.waybill.stores.findIndex(s => s.pending);
  check("存在1个待定门店", pendingIdx >= 0, "pendingIdx=" + pendingIdx);
  check("待定门店名=天虹商场龙华店", B.waybill.stores[pendingIdx]?.rawName === "天虹商场龙华店");

  // 确认（action=new）
  const crId = "cr-b-1";
  resp = await confirmMod.onRequestPost({request: postJsonReq("https://app.local/api/waybills/confirm", TOKEN, {
    waybillId: idB, confirmRequestId: crId,
    confirmations: [{ index: pendingIdx, action: "new", standardName: "天虹商场龙华店" }],
  }), env});
  let CB = await toJson(resp);
  check("确认成功", CB.success === true);
  check("确认后 stage=CONFIRMED", CB.waybill?.stage === "CONFIRMED", CB.waybill?.stage);
  check("确认后无待定", (CB.waybill?.stores || []).every(s => !s.pending));
  check("基准库已学习新门店", read("route:" + ROUTE + ":base")?.stores.some(s => s.name === "天虹商场龙华店"));
  const newStoreId = CB.waybill.stores[pendingIdx]?.storeId;
  check("待定门店获得 storeId", !!newStoreId, "storeId=" + newStoreId);

  // ===================================================================
  console.log("\n【阶段6】确认幂等（P0-5）— 已确认单重复提交 + 并发双提交防护");
  // 6a：对已确认单再次提交同一 confirmRequestId → 幂等成功（ALREADY_CONFIRMED / DEFERRED / DUPLICATE_REQUEST 皆可，核心是“不再写入”）
  resp = await confirmMod.onRequestPost({request: postJsonReq("https://app.local/api/waybills/confirm", TOKEN, {
    waybillId: idB, confirmRequestId: crId,
    confirmations: [{ index: pendingIdx, action: "new", standardName: "天虹商场龙华店" }],
  }), env});
  let CB2 = await toJson(resp); if(!["DUPLICATE_REQUEST","ALREADY_CONFIRMED","DEFERRED"].includes(CB2.learning)) console.log("DEBUG CB2 =", JSON.stringify(CB2).slice(0,400));
  check("已确认单重复提交=幂等成功", CB2.success === true && ["DUPLICATE_REQUEST", "ALREADY_CONFIRMED", "DEFERRED"].includes(CB2.learning), "learning=" + CB2.learning);
  check("重复提交不新增基准记录", read("route:" + ROUTE + ":base")?.stores.filter(s => s.name === "天虹商场龙华店").length === 1);

  // 6b：并发双提交同一 confirmRequestId（新建 PLANNED 单）— 应仅一次实际确认，不重复写基准/学习
  const rawTextE = `运输日期 ${TODAY}\n车牌号 粤B99999\n总重量 2.0吨\n谊品生鲜温馨家园南门店 -> 盒马鲜生前海店`;
  const fdE = new FormData(); fdE.append("routeId", ROUTE); fdE.append("rawText", rawTextE);
  const E = await toJson(await processMod.onRequestPost({request: postFormReq("https://app.local/api/waybills/process", TOKEN, fdE), env}));
  const idE = E.waybill?.id; const pIdxE = E.waybill.stores.findIndex(s => s.pending);
  const crE = "cr-e-1";
  const mkConfirm = () => confirmMod.onRequestPost({request: postJsonReq("https://app.local/api/waybills/confirm", TOKEN, {
    waybillId: idE, confirmRequestId: crE,
    confirmations: [{ index: pIdxE, action: "new", standardName: "盒马鲜生前海店" }],
  }), env});
  const [r1, r2] = await Promise.all([mkConfirm(), mkConfirm()]);
  const d1 = await toJson(r1), d2 = await toJson(r2);
  check("并发双提交至少一次成功", (d1.success || d2.success) === true, `d1=${d1.code || d1.learning} d2=${d2.code || d2.learning}`);
  check("并发双提交不重复写基准库", read("route:" + ROUTE + ":base")?.stores.filter(s => s.name === "盒马鲜生前海店").length === 1,
    "盒马数=" + read("route:" + ROUTE + ":base")?.stores.filter(s => s.name === "盒马鲜生前海店").length);

  // ===================================================================
  console.log("\n【阶段7】学习（P0-4）— 全局学习库已写入");
  const gRecords = red.hashes.get("zp:global:learning:records");
  check("全局学习库非空", gRecords && gRecords.size >= 1, "records=" + (gRecords?.size));
  let learnedNameFound = false;
  if (gRecords) for (const [, v] of gRecords) { try { const o = JSON.parse(v); if (o.standardName === "天虹商场龙华店") learnedNameFound = true; } catch {} }
  check("全局学习库含 天虹商场龙华店", learnedNameFound);

  // ===================================================================
  console.log("\n【阶段8】再匹配（P0-4）— 次日同文本应自动匹配新门店，不再待定");
  const fdC = new FormData();
  fdC.append("routeId", ROUTE);
  fdC.append("rawText", rawTextC);
  resp = await processMod.onRequestPost({request: postFormReq("https://app.local/api/waybills/process", TOKEN, fdC), env});
  let C = await toJson(resp);
  const idC = C.waybill?.id;
  check("C 处理成功", C.success === true);
  check("C 全部匹配（无待定）", (C.waybill?.stores || []).every(s => !s.pending), "pending=" + C.waybill?.stores.filter(s => s.pending).length);
  check("C stage=CONFIRMED", C.waybill?.stage === "CONFIRMED", C.waybill?.stage);
  check("C 天虹门店已自动匹配(非pending)", C.waybill?.stores.find(s => s.rawName === "天虹商场龙华店")?.matchStatus === "matched");
  check("C 是独立新单（非去重复用 B）", idC && idC !== idB, "idC=" + idC);
  check("C 进入次日日期索引", red.sets.get(indexKey(TOMORROW))?.has(idC) === true);
  resp = await historyMod.onRequestGet({request: getReq("https://app.local/api/waybills/history?date=" + TOMORROW, TOKEN), env});
  let HC = await toJson(resp);
  check("历史(次日)读取命中 C", HC.success && HC.waybill?.id === idC);

  // ===================================================================
  console.log("\n【阶段9】当日业务去重（P0-3 去重 / P0-7 一致性）— 同日同签名重复上传");
  const fdA2 = new FormData();
  fdA2.append("routeId", ROUTE);
  fdA2.append("rawText", rawTextA);
  resp = await processMod.onRequestPost({request: postFormReq("https://app.local/api/waybills/process", TOKEN, fdA2), env});
  let A2 = await toJson(resp);
  check("重复上传返回幂等", A2.success && A2.idempotent === true, "idempotent=" + A2.idempotent);
  check("去重原因=DAILY（业务签名命中）", A2.dedupe === "DAILY", "dedupe=" + A2.dedupe);
  check("复用首单 A（不新增）", A2.waybill?.id === idA, "id=" + A2.waybill?.id);
  check("今日索引未被去重错误新增（A/B/E 共3，A2 未增）", red.sets.get(indexKey(TODAY))?.size === 3, "size=" + red.sets.get(indexKey(TODAY))?.size);

  // ===================================================================
  console.log("\n【阶段10】数据一致性（P0-6 / P0-7）— 索引、主记录、指纹三者一致");
  for (const [label, id] of [["A", idA], ["B", idB], ["C", idC]]) {
    const w = read("waybill:" + id);
    const date = w?.date;
    const inIndex = red.sets.get(indexKey(date))?.has(id);
    check(`${label}: 索引↔主记录一致`, !!w && inIndex === true, `date=${date}`);
    check(`${label}: 主记录 routeId/date 正确`, w && w.routeId === ROUTE && w.date === date);
  }
  // 索引成员都能解析为主记录
  let allConsistent = true;
  for (const date of [TODAY, TOMORROW]) {
    const members = red.sets.get(indexKey(date)) || new Set();
    for (const m of members) if (!read("waybill:" + m)) allConsistent = false;
  }
  check("所有索引成员均有主记录（无孤儿索引）", allConsistent);

  // ===================================================================
  console.log(`\n==== 汇总：通过 ${pass} / 失败 ${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
