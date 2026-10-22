/**
 * 运单状态机 / 失败恢复 · 端到端回归（1.1 核心增强 · P1 #18）
 * 复用 _mini-redis.cjs 真实加载 process / diagnostic / _waybill-proc，验证：
 *   1. 成功保存 → 处理票据转 DONE 并关联 waybillId（运维可按 requestId 追溯）。
 *   2. 提取为空（EXTRACT_EMPTY）→ FAILED + RESUBMIT + 可恢复提示 + 票据 FAILED。
 *   3. 中途切线路（DISPATCH_ROUTE_CHANGED）→ FAILED + REPROCESS（可恢复）。
 *   4. diagnostic 按 requestId 回看处理票据（成功 DONE / 不存在 404）。
 *   5. OCR 超时（OCR_TIMEOUT）→ TIMEOUT + RETRY_OCR + 票据 TIMEOUT（长任务不再永久“正在识别…”）。
 * 运行：node tests/integration-waybill-state-machine.cjs
 */
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const ROUTE = "route-sm1";
const UA = "uSM", tokA = "tok-SM";
const seed = (key, obj) => red._set("zp:" + key, JSON.stringify(obj));
const read = (key) => { const r = red._get("zp:" + key); return r ? JSON.parse(r) : null; };

const BASE = [
  { storeId: "S001", name: "华润万家(龙华店)", originalName: "华润万家龙华店", aliases: ["华润万家龙华"], routeOrder: 1 },
  { storeId: "S002", name: "沃尔玛(坂田店)", originalName: "沃尔玛坂田店", aliases: ["沃尔玛坂田"], routeOrder: 2 },
  { storeId: "S003", name: "永辉超市(宝安中心店)", originalName: "永辉超市宝安中心店", aliases: [], routeOrder: 3 },
];
const RAW_GOOD = [
  "运输日期 2026-10-06", "车牌号 粤B12345", "总重量 0.46吨",
  "华润万家（龙华店）", "沃尔玛坂田店", "永辉超市宝安中心店",
].join("\n");
const RAW_NOSTORE = ["运输日期 2026-10-06", "车牌号 粤B99999", "总重量 0.46吨"].join("\n");

function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function formReq(url, token, fields) {
  const m = new Map(Object.entries(fields));
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => ({ get: (k) => (m.has(k) ? m.get(k) : null), getAll: (k) => (m.has(k) ? [m.get(k)] : []) }) };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
  seed("route:" + ROUTE, { status: "active", name: "状态机测试线路", driverUserId: UA, deliveryUserId: "uSB" });
  seed("route:" + ROUTE + ":base", { stores: BASE });
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tokA, { userId: UA, sessionVersion: 1 });
  const uAdmin = "uSMAdmin", tokAdmin = "tok-SMAdmin";
  seed("user:" + uAdmin, { id: uAdmin, role: "admin", boundRouteId: null, dispatchRouteId: null, sessionVersion: 1 });
  seed("session:" + tokAdmin, { userId: uAdmin, sessionVersion: 1 });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const procMod = await import(baseDir + "waybills/_waybill-proc.js");

  console.log("【1】成功保存 → 处理票据 DONE + 关联 waybillId");
  const goodResp = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, rawText: RAW_GOOD, date: "2026-10-06", vehicle: "粤B12345" }), env });
  const good = await toJson(goodResp);
  check("正常运单保存成功", good.success === true, "stage=" + good.waybill?.stage);
  const goodRid = good.requestId;
  check("响应携带 requestId", typeof goodRid === "string" && goodRid.length > 0);
  const goodProc = await procMod.getProc(env, goodRid);
  check("处理票据转 DONE", goodProc && goodProc.stage === "DONE", goodProc && goodProc.stage);
  check("DONE 关联 waybillId", goodProc && goodProc.waybillId === good.waybill.id);

  console.log("【2】提取为空（EXTRACT_EMPTY）→ FAILED + RESUBMIT + 可恢复");
  const emptyResp = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, rawText: RAW_NOSTORE, date: "2026-10-06", vehicle: "粤B99999" }), env });
  const empty = await toJson(emptyResp);
  check("提取为空被拒(EXTRACT_EMPTY)", empty.success === false && empty.code === "EXTRACT_EMPTY", "code=" + (empty.code || ""));
  check("失败响应携带 requestId", typeof empty.requestId === "string");
  check("失败响应 recoverable=true", empty.recoverable === true);
  check("失败响应 action=RESUBMIT", empty.action === "RESUBMIT");
  check("失败响应含 hint", typeof empty.hint === "string" && empty.hint.length > 0);
  const emptyProc = await procMod.getProc(env, empty.requestId);
  check("处理票据转 FAILED", emptyProc && emptyProc.stage === "FAILED");

  console.log("【3】中途切线路（DISPATCH_ROUTE_CHANGED）→ FAILED + REPROCESS（可恢复）");
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: "route-OTHER", routeDuty: "driver", sessionVersion: 1 });
  const switched = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, processingRouteId: ROUTE, rawText: RAW_GOOD, date: "2026-10-06", vehicle: "粤B12345" }), env });
  const switchedJson = await toJson(switched);
  check("切线路被拒(DISPATCH_ROUTE_CHANGED)", switchedJson.success === false && switchedJson.code === "DISPATCH_ROUTE_CHANGED", "code=" + (switchedJson.code || ""));
  check("切线路失败 recoverable + REPROCESS", switchedJson.recoverable === true && switchedJson.action === "REPROCESS");
  const switchedProc = await procMod.getProc(env, switchedJson.requestId);
  check("处理票据转 FAILED", switchedProc && switchedProc.stage === "FAILED");
  seed("user:" + UA, { id: UA, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver", sessionVersion: 1 });

  console.log("【4】diagnostic 按 requestId 回看处理票据");
  const diagProc = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic?requestId=" + goodRid, tokAdmin), env });
  const diagProcJson = await toJson(diagProc);
  check("管理员按 requestId 取到 DONE 票据", diagProcJson.success === true && diagProcJson.procTicket && diagProcJson.procTicket.stage === "DONE", diagProcJson.procTicket && diagProcJson.procTicket.stage);
  check("票据含 waybillId", diagProcJson.procTicket && diagProcJson.procTicket.waybillId === good.waybill.id);
  const diagUnknown = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic?requestId=req-not-exist", tokAdmin), env });
  const diagUnknownJson = await toJson(diagUnknown);
  check("未知 requestId 返回 404", diagUnknownJson.success === false && diagUnknownJson.error.includes("过期"));

  console.log("【5】OCR 超时（OCR_TIMEOUT）→ TIMEOUT + RETRY_OCR（长任务不再永久“正在识别…”）");
  const OCR_HOST = "https://paddleocr.aistudio-app.com";
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(OCR_HOST)) {
      if (u.endsWith("/api/v2/ocr/jobs") && (!init || init.method === "POST")) {
        return new Response(JSON.stringify({ data: { jobId: "job-timeout-test" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: { state: "running" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  const realDateNow = Date.now;
  let fake = realDateNow();
  // P2-11 桩修正配套：MiniRedis 现已真实实现 SET..EX 过期语义（此前忽略 EX，票据永不过期）。
  // 业务超时判定是 PROC_TIMEOUT_MS=5 分钟，票据 TTL 是 PROC_TTL=15 分钟；
  // 旧假时钟「每次调用 +1000s(≈16.7min)」已远超 TTL，会让票据在断言前就被回收。
  // 现按 60s/次推进：足够跨过 5 分钟超时线，又远小于 15 分钟 TTL。
  global.Date.now = () => { fake += 60_000; return fake; };
  let ocrResult;
  try {
    const FileCtor = global.File || class { constructor() { this.name = "w.png"; } };
    const file = new FileCtor(["dummy"], "waybill.png", { type: "image/png" });
    const ocrResp = await processMod.onRequestPost({ request: formReq("https://t.zp/api/waybills/process", tokA, { routeId: ROUTE, file }), env });
    ocrResult = await toJson(ocrResp);
  } finally {
    global.fetch = realFetch;
    global.Date.now = realDateNow;
  }
  check("OCR 超时返回 OCR_TIMEOUT", ocrResult && ocrResult.success === false && ocrResult.code === "OCR_TIMEOUT", "code=" + (ocrResult && ocrResult.code || ""));
  check("OCR 超时 recoverable + RETRY_OCR", ocrResult && ocrResult.recoverable === true && ocrResult.action === "RETRY_OCR");
  check("OCR 超时响应含 requestId", ocrResult && typeof ocrResult.requestId === "string");
  const ocrProc = ocrResult ? await procMod.getProc(env, ocrResult.requestId) : null;
  check("处理票据转 TIMEOUT", ocrProc && ocrProc.stage === "TIMEOUT");
  check("OCR失败票据保留阶段计时", ocrProc && ocrProc.timing && typeof ocrProc.timing.ocrSubmitMs === "number" && typeof ocrProc.timing.ocrStatusWaitMs === "number");
  const diagOcr = await diagMod.onRequestGet({ request: getReq("https://t.zp/api/waybills/diagnostic?requestId=" + ocrResult.requestId, tokAdmin), env });
  const diagOcrJson = await toJson(diagOcr);
  check("requestId诊断可读取失败OCR计时", diagOcrJson.success === true && diagOcrJson.procTicket && diagOcrJson.procTicket.timing && typeof diagOcrJson.procTicket.timing.ocrStatusWaitMs === "number");

  console.log("─".repeat(50));
  console.log("状态机/失败恢复 回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试运行异常：", e); process.exit(1); });
