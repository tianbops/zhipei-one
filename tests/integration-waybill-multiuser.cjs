// 智配One · 真实三用户端到端回归（P0 #5）
// ------------------------------------------------------------------
// 司机(D) + 配送员(E) 绑定线路 ROUTE（二人共同维护、互见互改）；
// 代班(S) 未绑定 ROUTE、由派单临时调度到 ROUTE（可见全部、仅可改自己创建的）；
// 外人(O) 绑定另一条线路 OTHER2（与 ROUTE 完全无关）；
// 管理员(ADM) 仅运维。
//
// 复用 _mini-redis.cjs 真实加载 process/latest/history/diagnostic/confirm/_waybill-proc/_waybill-acl，
// 驱动「全端点表面」的跨用户隔离 + 代班交接不丢数据 + 一致性/统计作用域 + 修复仅管理员。
// 这是 1.1 隔离语义（已 33 项单测覆盖）之上缺失的「真实多账号级闭环」。
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
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const read = (key) => { const r = red.command(["GET", "zp:" + key]); return r ? JSON.parse(r) : null; };
function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
function postFormReq(url, token, fd) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => fd };
}
function postJsonReq(url, token, bodyObj) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, json: async () => bodyObj };
}
function postReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, json: async () => ({}) };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const TODAY = todayCN();
  const ROUTE = "route-2001", OTHER2 = "route-9003";
  const D = "uD", E = "uE", S = "uS", O = "uO", ADM = "uADM";
  const tokD = "tok-D", tokE = "tok-E", tokS = "tok-S", tokO = "tok-O", tokADM = "tok-ADM";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const latestMod = await import(baseDir + "waybills/latest.js");
  const historyMod = await import(baseDir + "history.js");
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const confirmMod = await import(baseDir + "waybills/confirm.js");
  const aclMod = await import(baseDir + "_waybill-acl.js");

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // 角色矩阵
  const mkUser = (id, bound, dispatch, duty, role = "user") => {
    seed("user:" + id, { id, role, boundRouteId: bound, dispatchRouteId: dispatch, routeDuty: duty, sessionVersion: 1 });
    seed("session:tok-" + id.slice(1), { userId: id, sessionVersion: 1 });
  };
  mkUser(D, ROUTE, ROUTE, "driver");       // 绑定司机
  mkUser(E, ROUTE, ROUTE, "delivery");     // 绑定配送员
  mkUser(S, OTHER2, ROUTE, "driver");      // 代班：未绑定 ROUTE，派单到 ROUTE
  mkUser(O, OTHER2, OTHER2, "driver");     // 外人：另一条线路
  mkUser(ADM, null, null, null, "admin");  // 管理员
  seed("route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });
  seed("route:" + OTHER2, { id: OTHER2, name: "线路9003", status: "active" });
  seed("route:" + ROUTE + ":base", { routeId: ROUTE, version: 1, stores: [
    { storeId: "JM03050", name: "门店A", aliases: [], routeOrder: 1 },
    { storeId: "A1001", name: "门店B", aliases: [], routeOrder: 2 },
  ] });
  seed("route:" + OTHER2 + ":base", { routeId: OTHER2, version: 1, stores: [
    { storeId: "JM07070", name: "门店X", aliases: [], routeOrder: 1 },
  ] });

  const upload = async (token, routeId, plate, extra) => {
    const fd = new FormData();
    fd.append("routeId", routeId);
    fd.append("rawText", `运输日期 ${TODAY}\n车牌号 ${plate}\n总重量 1.0吨\n门店A -> 门店B${extra ? " -> " + extra : ""}`);
    return await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", token, fd), env }));
  };
  const uploadPending = async (token, routeId, plate, newStore) => {
    const fd = new FormData();
    fd.append("routeId", routeId);
    fd.append("rawText", `运输日期 ${TODAY}\n车牌号 ${plate}\n总重量 1.0吨\n门店A -> ${newStore}`);
    return await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", token, fd), env }));
  };
  const readLatest = (token, id, e = env) => latestMod.onRequestGet({ request: getReq("https://app.local/api/waybills/latest?id=" + id, token), env: e });
  const histGet = (token, date) => historyMod.onRequestGet({ request: getReq("https://app.local/api/waybills/history?date=" + date, token), env });
  const delById = (token, id, route = ROUTE) => historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + id + "&routeId=" + route, token), env });
  const delDay = (token) => historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY, token), env });
  const diagGet = (token, qs) => diagMod.onRequestGet({ request: getReq("https://app.local/api/waybills/diagnostic?" + qs, token), env });
  const confirmPost = (token, waybillId, crId, confs) => confirmMod.onRequestPost({ request: postJsonReq("https://app.local/api/waybills/confirm", token, { waybillId, confirmRequestId: crId, confirmations: confs }), env });

  const uD = { id: D, boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver" };
  const uE = { id: E, boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery" };
  const uS = { id: S, boundRouteId: OTHER2, dispatchRouteId: ROUTE, routeDuty: "driver" };
  const uO = { id: O, boundRouteId: OTHER2, dispatchRouteId: OTHER2, routeDuty: "driver" };
  const wE = { id: "wE", routeId: ROUTE, createdBy: E };
  const wS = { id: "wS", routeId: ROUTE, createdBy: S };

  // ===================================================================
  console.log("\n【0】集中式 ACL 权威直测（_waybill-acl 单一收口）");
  check("canReadWaybill: 绑定司机可见绑定运单", aclMod.canReadWaybill(uD, wE, env) === true);
  check("canReadWaybill: 代班(dispatch=ROUTE)可见该线路全部运单", aclMod.canReadWaybill(uS, wE, env) === true);
  check("canReadWaybill: 外人(OTHER2)不可见 ROUTE 运单", aclMod.canReadWaybill(uO, wE, env) === false);
  check("canWriteWaybill: 绑定配送员可改绑定运单", aclMod.canWriteWaybill(uE, wE, env) === true);
  check("canWriteWaybill: 代班仅可改自己创建的(他人×/自己√)", aclMod.canWriteWaybill(uS, wE, env) === false && aclMod.canWriteWaybill(uS, wS, env) === true);
  check("canWriteWaybill: 外人不可改 ROUTE 运单", aclMod.canWriteWaybill(uO, wE, env) === false);

  // ===================================================================
  console.log("\n【1】三成员 + 外人 各自上传（业务用户仅能处理本人/派单线路）");
  const rD = await upload(tokD, ROUTE, "粤B11111"); const wD = rD.waybill?.id;
  const rE = await upload(tokE, ROUTE, "粤B22222"); const wE_id = rE.waybill?.id;
  const rS = await upload(tokS, ROUTE, "粤B33333"); const wS_id = rS.waybill?.id;
  const rO = await upload(tokO, OTHER2, "粤B44444"); const wO_id = rO.waybill?.id;
  check("司机 D 上传成功", !!wD);
  check("配送员 E 上传成功", !!wE_id);
  check("代班 S 在 ROUTE 上传成功(dispatch=ROUTE)", !!wS_id);
  check("外人 O 在本人线路 OTHER2 上传成功", !!wO_id);

  // ===================================================================
  console.log("\n【2】读取隔离：可见范围按线路、非按用户一刀切");
  const dSee = await toJson(await diagGet(tokD, "date=" + TODAY));
  check("司机 D 诊断可见 ROUTE 全部(3: 司机/配送员/代班)", dSee.success && (dSee.waybills || []).length === 3, "n=" + (dSee.waybills || []).length);
  const oSeeR = await toJson(await readLatest(tokO, wE_id));
  check("外人 O 读不到 ROUTE 运单(返回 null)", oSeeR.success && oSeeR.waybill === null);
  const oSeeOwn = await toJson(await readLatest(tokO, wO_id));
  check("外人 O 能读本人 OTHER2 运单", oSeeOwn.success && oSeeOwn.waybill?.id === wO_id);
  const oDiag = await toJson(await diagGet(tokO, "date=" + TODAY));
  check("外人 O 诊断默认线路(OTHER2)不含 ROUTE 运单", oDiag.success && (oDiag.waybills || []).every(w => w.routeId === OTHER2));

  // ===================================================================
  console.log("\n【3】写入隔离：绑定二人互改；代班仅改自己；外人一律拒");
  const eDelD = await toJson(await delById(tokE, wD));
  check("绑定配送员 E 可删司机 D 的运单(互改)", eDelD.success === true);
  const sDelE = await toJson(await delById(tokS, wE_id));
  check("代班 S 删他人运单被拒(403 WAYBILL_FORBIDDEN)", sDelE.success !== true && sDelE.code === "WAYBILL_FORBIDDEN", "code=" + (sDelE.code));
  const sDelOwn = await toJson(await delById(tokS, wS_id));
  check("代班 S 删自己运单成功", sDelOwn.success === true);
  const oDelE = await toJson(await delById(tokO, wE_id, ROUTE));
  check("外人 O 删 ROUTE 运单被拒(线路级 403)", oDelE.success !== true && oDelE.error === "无权操作该线路历史", "code=" + (oDelE.code) + " err=" + (oDelE.error));

  // ===================================================================
  console.log("\n【4】代班交接 + confirm 隔离：代班留下的待定门店，绑定人可维护（数据不丢）");
  const rP = await uploadPending(tokS, ROUTE, "粤B55555", "新门店ZZZ"); const wP = rP.waybill?.id;
  check("代班 S 上传含待定门店运单成功", !!wP);
  const pStores = rP.waybill?.stores || [];
  const pIdx = pStores.map((s, i) => (s.pending ? i : null)).filter(i => i !== null);
  const eConf = await toJson(await confirmPost(tokE, wP, "cr-e-1", pIdx.map(i => ({ index: i, action: "new", standardName: pStores[i].rawName || pStores[i].name }))));
  check("绑定配送员 E 可维护代班 S 留下的待定门店(交接不丢数据)", eConf.success === true, "code=" + (eConf.code));
  const wPnow = read("waybill:" + wP);
  check("交接后该运单待定已消解(stage=CONFIRMED)", wPnow && wPnow.stage === "CONFIRMED");
  const oConf = await toJson(await confirmPost(tokO, wP, "cr-o-1", pIdx.map(i => ({ index: i, action: "new", standardName: "x" }))));
  check("外人 O 确认 ROUTE 运单被拒(403 BASE_MAINTENANCE_FORBIDDEN)", oConf.success !== true && oConf.code === "BASE_MAINTENANCE_FORBIDDEN", "code=" + (oConf.code));

  // ===================================================================
  console.log("\n【5】按日删除 PARTIAL：代班仅删自己创建的，他人单明确跳过（PARTIAL_DELETE）");
  // 当前 ROUTE 剩余：wE_id(绑定 E)、wP(代班 S 自己)；wD 已删、wS 已删
  const sDay = await toJson(await delDay(tokS));
  check("代班按日删除返回 PARTIAL_DELETE", sDay.success === true && sDay.code === "PARTIAL_DELETE", "code=" + (sDay.code));
  check("代班按日删除 deleted=1(自己 wP) / skipped=1(wE) / total=2", sDay.deleted === 1 && sDay.skipped === 1 && sDay.total === 2, "d=" + sDay.deleted + " s=" + sDay.skipped + " t=" + sDay.total);
  check("按日删除未误删绑定者运单 wE", !!read("waybill:" + wE_id));

  // ===================================================================
  console.log("\n【6】处理票据跨用户可见性（EXTRACT_EMPTY → FAILED，按线路共享）");
  const fdEmpty = new FormData();
  fdEmpty.append("routeId", ROUTE);
  fdEmpty.append("rawText", `运输日期 ${TODAY}\n车牌号 粤B66666\n总重量 0.46吨`);
  const emptyR = await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokS, fdEmpty), env }));
  check("代班上传无门店文本 → EXTRACT_EMPTY 失败(可恢复 RESUBMIT)", emptyR.success === false && emptyR.code === "EXTRACT_EMPTY" && emptyR.recoverable === true && emptyR.action === "RESUBMIT", "code=" + (emptyR.code));
  const rid1 = emptyR.requestId;
  const dTicket = await toJson(await diagGet(tokD, "requestId=" + rid1));
  check("绑定司机 D 可读代班的处理票据(共享线路)", dTicket.success === true && dTicket.procTicket?.stage === "FAILED", "stage=" + (dTicket.procTicket?.stage));
  const oTicket = await toJson(await diagGet(tokO, "requestId=" + rid1));
  check("外人 O 读不到代班处理票据(403)", oTicket.success !== true && oTicket.error === "无权查看该处理票据", "code=" + (oTicket.code) + " err=" + (oTicket.error));

  // ===================================================================
  console.log("\n【7】OCR 超时票据跨用户可见性（OCR_TIMEOUT → TIMEOUT，长任务不再永久“正在识别…”）");
  const OCR_HOST = "https://paddleocr.aistudio-app.com";
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(OCR_HOST)) {
      if (u.endsWith("/api/v2/ocr/jobs") && (!init || init.method === "POST")) {
        return new Response(JSON.stringify({ data: { jobId: "job-multiuser-timeout" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: { state: "running" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
  const realDateNow = Date.now;
  let fake = realDateNow();
  global.Date.now = () => { fake += 1_000_000; return fake; };
  let ocrR;
  try {
    const FileCtor = global.File || class { constructor() { this.name = "w.png"; } };
    const file = new FileCtor(["dummy"], "waybill.png", { type: "image/png" });
    const fdFile = new FormData();
    fdFile.append("routeId", ROUTE);
    fdFile.append("file", file);
    ocrR = await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokS, fdFile), env }));
  } finally {
    global.fetch = realFetch;
    global.Date.now = realDateNow;
  }
  check("OCR 超时返回 OCR_TIMEOUT", ocrR && ocrR.success === false && ocrR.code === "OCR_TIMEOUT", "code=" + (ocrR && ocrR.code || ""));
  check("OCR 超时 recoverable + RETRY_OCR", ocrR && ocrR.recoverable === true && ocrR.action === "RETRY_OCR");
  check("OCR 超时响应含 requestId", ocrR && typeof ocrR.requestId === "string");
  const dT2 = await toJson(await diagGet(tokD, "requestId=" + ocrR.requestId));
  check("绑定司机 D 可读代班 OCR 超时票据(TIMEOUT)", dT2.success === true && dT2.procTicket?.stage === "TIMEOUT", "stage=" + (dT2.procTicket?.stage));

  // ===================================================================
  console.log("\n【8】一致性自检作用域：业务用户仅看本人线路，不泄漏其它线路");
  // 植入 OTHER2 孤儿索引条目（悬空引用），制造跨线路脏数据
  red.command(["SADD", "zp:route:" + OTHER2 + ":waybills:" + TODAY, "ghost-2"]);
  const sCons = await toJson(await diagGet(tokS, "check=consistency"));
  check("代班 S 一致性自检成功(作用域=ROUTE)", sCons.success === true && sCons.scope === ROUTE);
  check("代班 S 一致性不泄漏 OTHER2 孤儿(作用域隔离)", (sCons.issues || []).every(i => i.routeId !== OTHER2 && i.waybillId !== "ghost-2" && !(i.key && i.key.includes(OTHER2))), "leak=" + (sCons.issues || []).filter(i => i.routeId === OTHER2 || i.waybillId === "ghost-2").length);
  const admCons = await toJson(await diagGet(tokADM, "check=consistency&all=1"));
  check("管理员全量一致性发现 OTHER2 孤儿(ORPHAN_INDEX_ENTRY)", admCons.success && (admCons.issues || []).some(i => i.type === "ORPHAN_INDEX_ENTRY" && i.routeId === OTHER2));

  // ===================================================================
  console.log("\n【9】运营统计作用域：业务用户仅聚合本人线路");
  // ROUTE 当前窗口运单：仅 wE_id（wD/wS 已删、wP 已被代班按日删、EXTRACT_EMPTY/OCR 超时均未落库）
  const sStats = await toJson(await diagGet(tokS, "stats=1"));
  // 合成 rawText 经 extract 产生 1 个 pending 门店，故唯一 ROUTE 运单(wE)为 PLANNED（真实 OCR 文本会匹配基准→CONFIRMED）。
  // 本回归关注跨用户作用域：total=1 且恰好一个 ROUTE 运单在窗口内，即作用域正确。
  check("代班 S 统计仅 ROUTE 聚合(窗口内恰 1 张 ROUTE 运单, 作用域隔离)", sStats.success && sStats.waybills.total === 1 && (sStats.waybills.byStage.PLANNED + sStats.waybills.byStage.CONFIRMED) === 1, "total=" + (sStats.waybills && sStats.waybills.total) + " byStage=" + JSON.stringify(sStats.waybills && sStats.waybills.byStage));
  const oStats = await toJson(await diagGet(tokO, "stats=1"));
  check("外人 O 统计仅 OTHER2 聚合(total=1, 本人 wO)", oStats.success && oStats.waybills.total === 1, "total=" + (oStats.waybills && oStats.waybills.total));
  const admStats = await toJson(await diagGet(tokADM, "stats=1&all=1"));
  check("管理员全量统计(total=2)", admStats.success && admStats.waybills.total === 2, "total=" + (admStats.waybills && admStats.waybills.total));

  // ===================================================================
  console.log("\n【10】紧急止血开关 WAYBILL_STRICT_OWNER=1：正式线路读取回退为仅本人可见");
  const envStrict = { ...env, WAYBILL_STRICT_OWNER: "1" };
  const rD2 = await upload(tokD, ROUTE, "粤B77777"); const wD2 = rD2.waybill?.id;
  const dReadE_strict = await toJson(await readLatest(tokD, wE_id, envStrict));
  check("严格模式：司机 D 读不到配送员 E 的运单(返回 null)", dReadE_strict.success && dReadE_strict.waybill === null);
  const dReadOwn_strict = await toJson(await readLatest(tokD, wD2, envStrict));
  check("严格模式：本人仍可读", dReadOwn_strict.success && dReadOwn_strict.waybill?.id === wD2);
  const dReadE_normal = await toJson(await readLatest(tokD, wE_id, env));
  check("关闭止血：司机 D 又能读 E 的运单(默认共享)", dReadE_normal.success && dReadE_normal.waybill?.id === wE_id);

  // ===================================================================
  console.log("\n【11】一致性修复仅管理员（外科手术式，非管理员不可触发）");
  const sRepair = await toJson(await diagMod.onRequestPost({ request: postReq("https://app.local/api/waybills/diagnostic?action=repair-consistency", tokS), env }));
  check("非管理员 S 修复被拒(403)", sRepair.success !== true && sRepair.error === "仅管理员可执行一致性修复", "code=" + (sRepair.code) + " err=" + (sRepair.error));
  const admRepair = await toJson(await diagMod.onRequestPost({ request: postReq("https://app.local/api/waybills/diagnostic?action=repair-consistency", tokADM), env }));
  check("管理员修复成功(应用自动项, 含 OTHER2 孤儿)", admRepair.success === true && admRepair.repairedCount >= 1, "success=" + admRepair.success + " code=" + (admRepair.code || "") + " repaired=" + (admRepair.repairedCount) + " verifyFail=" + (admRepair.verificationFailedCount || 0) + " verifyComplete=" + (admRepair.verificationComplete));
  const afterRepair = await toJson(await diagGet(tokADM, "check=consistency&all=1"));
  check("修复后 OTHER2 孤儿已清除", !(afterRepair.issues || []).some(i => i.type === "ORPHAN_INDEX_ENTRY" && i.routeId === OTHER2));

  // ===================================================================
  console.log("─".repeat(56));
  console.log("真实三用户端到端回归（P0 #5）：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
