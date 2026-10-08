/**
 * 运单质量门 + 事件链 + 匹配可信度 · 端到端回归（1.1 核心增强）
 * 复用 _mini-redis.cjs 真实加载 process / diagnostic，验证：
 *   1. 正常运单：quality=OK、每门店 matchConfidence.level=HIGH、事件链含 WAYBILL_SAVED。
 *   2. 异常运单（待定占比高）：quality=REVIEW、flags 含 MATCH_LOW_CONFIDENCE / MATCH_NO_AUTO。
 *   3. diagnostic 端点返回 quality / requestId / events，运维可追溯。
 * 运行：node tests/integration-waybill-quality-events.cjs
 */
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const ROUTE = "route-qe1";
const UA = "uQA", tokA = "tok-QA";
const seed = (key, obj) => red._set("zp:" + key, JSON.stringify(obj));
const read = (key) => { const r = red._get("zp:" + key); return r ? JSON.parse(r) : null; };

const BASE = [
  { storeId: "S001", name: "华润万家(龙华店)", originalName: "华润万家龙华店", aliases: ["华润万家龙华"], routeOrder: 1 },
  { storeId: "S002", name: "沃尔玛(坂田店)", originalName: "沃尔玛坂田店", aliases: ["沃尔玛坂田"], routeOrder: 2 },
  { storeId: "S003", name: "永辉超市(宝安中心店)", originalName: "永辉超市宝安中心店", aliases: [], routeOrder: 3 },
  { storeId: "S004", name: "大润发(龙华店)", originalName: "大润发龙华店", aliases: ["大润发龙华"], routeOrder: 4 },
  { storeId: "S005", name: "顺丰速运(坂田营业点)", originalName: "顺丰速运坂田营业点", aliases: [], routeOrder: 5 },
  { storeId: "S006", name: "星巴克(深圳湾店)", originalName: "星巴克深圳湾店", aliases: [], routeOrder: 6 },
  { storeId: "S007", name: "家乐福(梅林店)", originalName: "家乐福梅林店", aliases: [], routeOrder: 7 },
  { storeId: "S008", name: "7-11便利店(福田店)", originalName: "7-11便利店福田店", aliases: ["711福田店"], routeOrder: 8 },
];

const RAW_GOOD = [
  "运输日期 2026-10-06",
  "车牌号 粤B12345",
  "总重量 0.46吨",
  "华润万家（龙华店）",
  "沃尔玛坂田店",
  "永辉超市宝安中心店",
  "大润发龙华店",
  "顺丰速运坂田营业点",
  "星巴克深圳湾店",
  "家乐福梅林店",
  "7-11便利店福田店",
].join("\n");

const RAW_BAD = [
  "运输日期 2026-10-06",
  "车牌号 粤B99999",
  "华润万家龙岗店",
  "沃尔玛坂田2号店",
  "星巴克深圳湾二店",
  "麦当劳",
  "肯德基",
  "必胜客",
].join("\n");

function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function formReq(url, token, fields) {
  const m = new Map(Object.entries(fields));
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => ({ get: (k) => (m.has(k) ? m.get(k) : null) }) };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
  seed("route:" + ROUTE, { status: "active", name: "质量测试线路", driverUserId: UA, deliveryUserId: "uQB" });
  seed("route:" + ROUTE + ":base", { stores: BASE });
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tokA, { userId: UA, sessionVersion: 1 });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const diagMod = await import(baseDir + "waybills/diagnostic.js");

  console.log("【1】正常运单：质量门 + 可信度 + 事件链");
  const goodResp = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, rawText: RAW_GOOD, date: "2026-10-06", vehicle: "粤B12345" }), env });
  const good = await toJson(goodResp);
  check("正常运单保存成功", good.success === true, "stage=" + good.waybill?.stage);
  check("正常运单 quality.level=OK", good.quality?.level === "OK", JSON.stringify(good.quality));
  check("正常运单 requestId 已生成", typeof good.requestId === "string" && good.requestId.length > 0);
  const goodItems = good.waybill?.stores || [];
  check("正常运单全部自动匹配", goodItems.length === 8 && goodItems.every(s => !s.pending), "count=" + goodItems.length);
  check("每门店携带 matchConfidence", goodItems.every(s => s.matchConfidence && ["HIGH", "MEDIUM", "LOW"].includes(s.matchConfidence.level)));
  check("精确匹配为 HIGH 级", goodItems.every(s => s.matchConfidence.level === "HIGH"));

  const goodOrder = goodItems.map(s => [s.storeId, s.routeOrder]);
  check("规划顺序与线路基准顺序一致", JSON.stringify(goodOrder) === JSON.stringify(BASE.map(s => [s.storeId, s.routeOrder])), JSON.stringify(goodOrder));
  const savedGood = read(good.waybill?.id);
  check("Redis 主运单保存后保持规划顺序", JSON.stringify((savedGood?.stores || []).map(s => [s.storeId, s.routeOrder])) === JSON.stringify(goodOrder), JSON.stringify(savedGood?.stores));
  console.log("【2】异常运单（待定占比高）：质量门应报警但不阻断");
  const badResp = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, rawText: RAW_BAD, date: "2026-10-06", vehicle: "粤B99999" }), env });
  const bad = await toJson(badResp);
  check("异常运单仍保存成功（不硬阻断）", bad.success === true, "stage=" + bad.waybill?.stage);
  check("异常运单 quality.level=REVIEW", bad.quality?.level === "REVIEW", JSON.stringify(bad.quality));
  check("异常运单 flags 含 MATCH_LOW_CONFIDENCE", bad.quality?.flags.includes("MATCH_LOW_CONFIDENCE"));
  const badItems = bad.waybill?.stores || [];
  check("异常运单待定占比高", badItems.filter(s => s.pending).length / badItems.length >= 0.5, "pending=" + badItems.filter(s => s.pending).length + "/" + badItems.length);
  check("待定门店 matchConfidence.level=PENDING", badItems.filter(s => s.pending).every(s => s.matchConfidence?.level === "PENDING"));

  console.log("【3】diagnostic 端点：返回 quality / requestId / events");
  const diagResp = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic?routeId=" + ROUTE, tokA), env });
  const diag = await toJson(diagResp);
  check("diagnostic 返回成功", diag.success === true, "count=" + diag.count);
  check("diagnostic 含两条运单", (diag.waybills || []).length >= 2);
  const withEvents = (diag.waybills || []).find(w => (w.events || []).some(e => e.event === "WAYBILL_SAVED"));
  check("事件链含 WAYBILL_SAVED", Boolean(withEvents), withEvents ? "events=" + withEvents.events.length : "无");
  const withQuality = (diag.waybills || []).find(w => w.quality && w.requestId);
  check("diagnostic 暴露 quality + requestId", Boolean(withQuality));
  if (withEvents) {
    const types = withEvents.events.map(e => e.event);
    check("事件链覆盖完整生命周期", ["WAYBILL_CREATED", "EXTRACT_COMPLETED", "MATCH_COMPLETED", "DEDUPE_COMPLETED", "PLAN_COMPLETED", "WAYBILL_SAVED"].every(t => types.includes(t)), types.join(","));
  }

  console.log("【4】管理员可观测性：指定 routeId 即可诊断任意线路（此前 403）");
  const uAdmin = "uQAdmin", tokAdmin = "tok-QAdmin";
  seed("user:" + uAdmin, { id: uAdmin, role: "admin", boundRouteId: null, dispatchRouteId: null, sessionVersion: 1 });
  seed("session:" + tokAdmin, { userId: uAdmin, sessionVersion: 1 });
  const adminDiag = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic?routeId=" + ROUTE, tokAdmin), env });
  const adminJson = await toJson(adminDiag);
  check("管理员按 routeId 诊断成功（放开前被拒）", adminJson.success === true && (adminJson.waybills || []).length >= 2, "count=" + (adminJson.waybills || []).length);
  check("管理员诊断返回质量/事件", Boolean((adminJson.waybills || [])[0]?.quality) && Boolean((adminJson.waybills || [])[0]?.events));
  const noRoute = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic", tokAdmin), env });
  const noRouteJson = await toJson(noRoute);
  check("管理员未指定 routeId 被拒(400)", noRouteJson.success === false && noRouteJson.error.includes("routeId"));

  console.log("【5】学习隔离可操作闭环（isolate → QUARANTINED → 退出匹配 → restore → CANDIDATE）");
  const glMod = await import(baseDir + "_global-learning.js");
  // 直接落库一条 VERIFIED 记录 + 别名索引（绕过 learnGlobal 的 Lua 以兼容测试桩）。
  const seedStore = { storeId: "GX1", standardName: "测试店", originalName: "测试店", aliases: [], status: "VERIFIED", confirmations: 2 };
  red.command(["HSET", "zp:global:learning:records", "GX1", JSON.stringify(seedStore)]);
  red.command(["HSET", "zp:global:learning:aliases", "测试店", JSON.stringify(["GX1"])]);
  const before = await glMod.findGlobalMatches(env, [{ rawName: "测试店" }]);
  check("VERIFIED 记录可参与自动匹配", before[0] && before[0].globalMatchStatus === "matched", before[0] && before[0].globalMatchStatus);
  const iso = await glMod.isolateGlobalRecord(env, { storeId: "GX1", userId: uAdmin, reason: "误匹配" });
  check("isolate → QUARANTINED", iso.isolated === true && iso.record.status === "QUARANTINED");
  const afterIso = await glMod.findGlobalMatches(env, [{ rawName: "测试店" }]);
  check("隔离后退出自动匹配（保留审计，不动删除）", !(afterIso[0] && afterIso[0].globalMatchStatus === "matched"));
  const res = await glMod.restoreGlobalRecord(env, { storeId: "GX1", userId: uAdmin });
  check("restore → CANDIDATE（未删数据，保留审计链）", res.restored === true && res.record.status === "CANDIDATE");

  console.log("【6】线路切换上下文保护（processingRouteId 二次校验，P1 #17）");
  // 模拟"处理中切线路"：会话 dispatchRouteId 改为 OTHER，但提交时 processingRouteId 仍为 ROUTE。
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: "route-OTHER", routeDuty: "driver", sessionVersion: 1 });
  const switched = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, processingRouteId: ROUTE, rawText: RAW_GOOD, date: "2026-10-06", vehicle: "粤B12345" }), env });
  const switchedJson = await toJson(switched);
  check("切线路后提交被拒(DISPATCH_ROUTE_CHANGED,可恢复)", switchedJson.success === false && switchedJson.code === "DISPATCH_ROUTE_CHANGED", "code=" + (switchedJson.code || ""));
  // 恢复会话线路后 processingRouteId 与之匹配 → 成功（同线路保存）。
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  const okAgain = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, processingRouteId: ROUTE, rawText: RAW_GOOD, date: "2026-10-06", vehicle: "粤B12345" }), env });
  check("线路一致时 processingRouteId 提交成功", (await toJson(okAgain)).success === true);

  console.log("─".repeat(50));
  console.log("质量门/事件链/可信度 回归：通过 " + pass + " / 失败 " + fail);
  console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败项");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试运行异常：", e); process.exit(1); });
