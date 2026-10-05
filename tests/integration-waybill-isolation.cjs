// 智配One 运单跨用户隔离回归（P1 核心门禁）
// 复用 _mini-redis.cjs 真实加载 process/latest/history/diagnostic，
// 构造两名用户共享同一正式线路（driver + delivery），各自写入当日运单，
// 断言：对方列表/详情/诊断不可见、对方删除被拒且不实际删、list[-1]=本人、本人正常。
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
const seed = (key, obj) => red._set("zp:" + key, JSON.stringify(obj));
const read = (key) => { const r = red._get("zp:" + key); return r ? JSON.parse(r) : null; };
function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function postFormReq(url, token, fd) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => fd };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const TODAY = todayCN();
  const ROUTE = "route-2001";
  const UA = "uA", UB = "uB", tokA = "tok-A", tokB = "tok-B";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const latestMod = await import(baseDir + "waybills/latest.js");
  const historyMod = await import(baseDir + "history.js");
  const diagMod = await import(baseDir + "waybills/diagnostic.js");

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // 两名用户共享同一正式线路（driver + delivery），dispatchRouteId/boundRouteId 均=ROUTE
  seed("session:" + tokA, { userId: UA, sessionVersion: 1 });
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tokB, { userId: UB, sessionVersion: 1 });
  seed("user:" + UB, { id: UB, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  seed("route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });
  seed("route:" + ROUTE + ":base", { routeId: ROUTE, version: 1, stores: [
    { storeId: "JM03050", name: "门店A", aliases: [], routeOrder: 1 },
    { storeId: "A1001", name: "门店B", aliases: [], routeOrder: 2 },
  ] });

  const rawA = `运输日期 ${TODAY}\n车牌号 粤B11111\n总重量 1.0吨\n门店A -> 门店B`;
  const rawB = `运输日期 ${TODAY}\n车牌号 粤B22222\n总重量 1.0吨\n门店A -> 门店B`;
  const fdA = new FormData(); fdA.append("routeId", ROUTE); fdA.append("rawText", rawA);
  const fdB = new FormData(); fdB.append("routeId", ROUTE); fdB.append("rawText", rawB);
  const idA = (await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokA, fdA), env }))).waybill?.id;
  const idB = (await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokB, fdB), env }))).waybill?.id;
  check("两人各自上传成功", !!idA && !!idB, "idA=" + idA + " idB=" + idB);
  check("A 的运单 createdBy=uA", read("waybill:" + idA)?.createdBy === UA);
  check("B 的运单 createdBy=uB", read("waybill:" + idB)?.createdBy === UB);

  // 断言1：对方今日列表不可见（且 list[-1]=本人）
  let L = await toJson(await latestMod.onRequestGet({ request: getReq("https://app.local/api/waybills/latest", tokB), env }));
  check("uB 今日运单是本人单(idB)", L.success && L.waybill && L.waybill.id === idB, "id=" + L.waybill?.id);
  check("uB 今日不含 uA 的运单", L.waybill?.id !== idA);

  // 断言2：凭对方 waybillId 读详情 = null
  let D = await toJson(await latestMod.onRequestGet({ request: getReq("https://app.local/api/waybills/latest?id=" + idA, tokB), env }));
  check("uB 凭 uA 的 id 读详情=null", D.success && D.waybill === null);

  // 断言3：对方删除被拒且不实际删
  let before = red._get("zp:waybill:" + idA);
  let Del = await toJson(await historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + idA, tokB), env }));
  let after = red._get("zp:waybill:" + idA);
  check("uB 删除 uA 运单被拒(success!=true)", Del.success !== true, "code=" + Del.code);
  check("uA 运单主记录未被删除", before && after === before);

  // 断言4：history 当日列表对方不可见（list[-1]=本人）
  let H = await toJson(await historyMod.onRequestGet({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY, tokB), env }));
  check("uB 历史当日 waybill 是本人单(idB)", H.success && H.waybill && H.waybill.id === idB, "id=" + H.waybill?.id);
  check("uB 历史当日 count=1（不含 uA）", H.count === 1, "count=" + H.count);

  // 断言5：diagnostic 同线不列出他人单
  let Diag = await toJson(await diagMod.onRequestGet({ request: getReq("https://app.local/api/waybills/diagnostic?date=" + TODAY, tokB), env }));
  const diagIds = (Diag.waybills || []).map(w => w.id);
  check("diagnostic 仅含 uB 自身运单", Diag.success && diagIds.length === 1 && diagIds[0] === idB, "ids=" + JSON.stringify(diagIds));

  // 正向基线：本人读写正常（防止隔离误伤）
  let own = await toJson(await latestMod.onRequestGet({ request: getReq("https://app.local/api/waybills/latest?id=" + idB, tokB), env }));
  check("uB 读自己运单正常", own.success && own.waybill?.id === idB);
  let ownDel = await toJson(await historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + idB, tokB), env }));
  check("uB 删除自己运单成功", ownDel.success === true, "code=" + ownDel.code);

  console.log(`\n==== 隔离回归：通过 ${pass} / 失败 ${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
