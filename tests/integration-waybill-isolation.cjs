// 智配One 运单隔离回归（P1 核心门禁）
// 复用 _mini-redis.cjs 真实加载 process/latest/history/diagnostic/confirm，
// 覆盖 2026-10-06 定稿的隔离语义：
//   正式线路：绑定二人（driver+delivery）互见、互删改；
//             带班人员（未绑定、派单到该线路）可见全部，但仅可删改自己创建的；
//             非本线路成员一律拒绝；临时线路恒 owner 私有；
//             WAYBILL_STRICT_OWNER=1 为紧急止血开关（读取回退为仅本人可见）。
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
function postJsonReq(url, token, bodyObj) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, json: async () => bodyObj };
}
async function toJson(resp) { return await resp.json(); }

(async () => {
  const TODAY = todayCN();
  const ROUTE = "route-2001", OTHER = "route-9002";
  const UA = "uA", UB = "uB", UD = "uD", UC = "uC", UE = "uE";
  const tokA = "tok-A", tokB = "tok-B", tokD = "tok-D", tokC = "tok-C", tokE = "tok-E";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const latestMod = await import(baseDir + "waybills/latest.js");
  const historyMod = await import(baseDir + "history.js");
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const confirmMod = await import(baseDir + "waybills/confirm.js");
  const migMod = await import(baseDir + "_migrations.js");

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // 角色矩阵
  //  uA/uB：绑定该线路（driver + delivery）→ 共同维护者
  //  uD：boundRouteId=其它线路、dispatchRouteId=ROUTE → 带班人员（未绑定，派单到此）
  //  uC：与 ROUTE 完全无关 → 非本线路成员
  //  uE：临时线路用户
  const mkUser = (id, bound, dispatch, duty) => { seed("user:" + id, { id, role: "user", boundRouteId: bound, dispatchRouteId: dispatch, routeDuty: duty, sessionVersion: 1 }); seed("session:tok-" + id.slice(1), { userId: id, sessionVersion: 1 }); };
  mkUser(UA, ROUTE, ROUTE, "driver");
  mkUser(UB, ROUTE, ROUTE, "delivery");
  mkUser(UD, OTHER, ROUTE, "driver");
  mkUser(UC, OTHER, OTHER, "driver");
  const TEMP_E = "__temp__:" + UE;
  mkUser(UE, TEMP_E, TEMP_E, "driver");
  seed("route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });
  seed("route:" + OTHER, { id: OTHER, name: "线路9002", status: "active" });
  seed("route:" + ROUTE + ":base", { routeId: ROUTE, version: 1, stores: [
    { storeId: "JM03050", name: "门店A", aliases: [], routeOrder: 1 },
    { storeId: "A1001", name: "门店B", aliases: [], routeOrder: 2 },
  ] });

  const upload = async (token, routeId, plate, extra) => {
    const fd = new FormData();
    fd.append("routeId", routeId);
    fd.append("rawText", `运输日期 ${TODAY}\n车牌号 ${plate}\n总重量 1.0吨\n门店A -> 门店B${extra ? " -> " + extra : ""}`);
    return await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", token, fd), env }));
  };
  const readById = (token, id, e) => latestMod.onRequestGet({ request: getReq("https://app.local/api/waybills/latest?id=" + id, token), env: e || env });
  const delById = (token, id, e) => historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + id, token), env: e || env });

  // ===================================================================
  console.log("\n【1】绑定二人（driver+delivery）：互见、互删改（共同维护）");
  const idA = (await upload(tokA, ROUTE, "粤B11111")).waybill?.id;
  const idB = (await upload(tokB, ROUTE, "粤B22222")).waybill?.id;
  check("uA/uB 各自上传成功", !!idA && !!idB, "idA=" + idA + " idB=" + idB);
  let R1 = await toJson(await readById(tokB, idA));
  check("uB 可读 uA 的运单（互见）", R1.success && R1.waybill?.id === idA);
  let H1 = await toJson(await historyMod.onRequestGet({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY, tokB), env }));
  check("uB 历史当日可见两条", H1.success && H1.count === 2, "count=" + H1.count);
  let D1 = await toJson(await diagMod.onRequestGet({ request: getReq("https://app.local/api/waybills/diagnostic?date=" + TODAY, tokB), env }));
  check("diagnostic 含两条", D1.success && (D1.waybills || []).length === 2, "n=" + (D1.waybills || []).length);
  let Del1 = await toJson(await delById(tokB, idA));
  check("uB 可删除 uA 的运单（互改）", Del1.success === true, "code=" + Del1.code);
  check("uA 运单确已删除", !red._get("zp:waybill:" + idA));

  // ===================================================================
  console.log("\n【2】带班人员 uD（未绑定、派单到该线路）：可见全部，仅可删改自己的");
  const idD = (await upload(tokD, ROUTE, "粤B33333")).waybill?.id;
  check("带班 uD 上传成功", !!idD, "id=" + idD);
  let R2 = await toJson(await readById(tokD, idB));
  check("带班可见绑定者的运单（全可见）", R2.success && R2.waybill?.id === idB);
  let H2 = await toJson(await historyMod.onRequestGet({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY, tokD), env }));
  check("带班历史当日可见该线路全部", H2.success && H2.count === 2, "count=" + H2.count);
  let Del2 = await toJson(await delById(tokD, idB));
  check("带班删除他人运单被拒", Del2.success !== true, "code=" + Del2.code);
  check("他人运单未被删除", !!red._get("zp:waybill:" + idB));
  let Del3 = await toJson(await delById(tokD, idD));
  check("带班删除自己的运单成功", Del3.success === true, "code=" + Del3.code);

  // 按日删除（不带 waybillId）：只应删掉带班自己创建的
  const idD2 = (await upload(tokD, ROUTE, "粤B44444")).waybill?.id;
  let Del4 = await toJson(await historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY, tokD), env }));
  check("带班按日删除只删自己的(deleted=1, skipped=1, total=2)", Del4.success === true && Del4.deleted === 1 && Del4.skipped === 1 && Del4.total === 2, "deleted=" + Del4.deleted + " skipped=" + Del4.skipped + " total=" + Del4.total);
  check("按日删除明确返回 PARTIAL_DELETE（提示他人单未删）", Del4.code === "PARTIAL_DELETE", "code=" + Del4.code);
  check("按日删除未误删绑定者运单", !!red._get("zp:waybill:" + idB));

  // ===================================================================
  console.log("\n【3】带班可确认自己上传的运单（否则待定门店无人能确认）");
  const rP = await upload(tokD, ROUTE, "粤B55555", "新门店ZZZ");
  const idP = rP.waybill?.id;
  const stores = rP.waybill?.stores || [];
  const pIdxList = stores.map((s, i) => (s.pending ? i : null)).filter(i => i !== null);
  const confs = pIdxList.map(i => ({ index: i, action: "new", standardName: stores[i].rawName || stores[i].name }));
  check("带班上传含待定门店的单", !!idP && pIdxList.length >= 1, "pending=" + JSON.stringify(pIdxList));
  if (idP && pIdxList.length) {
    let Cf = await toJson(await confirmMod.onRequestPost({ request: postJsonReq("https://app.local/api/waybills/confirm", tokD, {
      waybillId: idP, confirmRequestId: "cr-d-1", confirmations: confs,
    }), env }));
    check("带班可确认自己的运单", Cf.success === true, "code=" + Cf.code);
    let Cf2 = await toJson(await confirmMod.onRequestPost({ request: postJsonReq("https://app.local/api/waybills/confirm", tokD, {
      waybillId: idB, confirmRequestId: "cr-d-2", confirmations: [{ index: 0, action: "new", standardName: "门店A" }],
    }), env }));
    check("带班确认他人运单被拒", Cf2.success !== true, "code=" + Cf2.code);
    // 绑定者可维护带班留下的运单（带班走后数据不丢）
    let Cf3 = await toJson(await confirmMod.onRequestPost({ request: postJsonReq("https://app.local/api/waybills/confirm", tokB, {
      waybillId: idP, confirmRequestId: "cr-b-9", confirmations: confs,
    }), env }));
    check("绑定者可维护带班留下的运单", Cf3.success === true, "code=" + Cf3.code + " learning=" + Cf3.learning);
  }

  // ===================================================================
  console.log("\n【4】非本线路成员 uC：一律拒绝");
  let R3 = await toJson(await readById(tokC, idB));
  check("uC 读不到该线路运单", R3.success && R3.waybill === null);
  let Del5 = await toJson(await delById(tokC, idB));
  check("uC 删除被拒", Del5.success !== true, "code=" + Del5.code);

  // ===================================================================
  console.log("\n【5】临时线路恒 owner 私有（不受共享语义影响）");
  const fdE = new FormData();
  fdE.append("routeId", TEMP_E);
  fdE.append("rawText", `运输日期 ${TODAY}\n车牌号 粤B66666\n总重量 1.0吨\n门店A -> 门店B`);
  const idE = (await toJson(await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tokE, fdE), env }))).waybill?.id;
  check("临时线路运单创建成功", !!idE, "id=" + idE);
  if (idE) {
    // uA 与 uD 当前调度线路均为 ROUTE，latest 的 routeId 取 dispatchRouteId，故改用 history 按 ID 删除路径验证归属
    let Del6 = await toJson(await historyMod.onRequestDelete({ request: getReq("https://app.local/api/waybills/history?date=" + TODAY + "&waybillId=" + idE, tokA), env }));
    check("他人无法删除临时线路运单", Del6.success !== true, "code=" + Del6.code);
    check("临时线路运单未被删除", !!red._get("zp:waybill:" + idE));
  }

  // ===================================================================
  console.log("\n【6】止血开关 WAYBILL_STRICT_OWNER=1：读取回退为仅本人可见");
  const envStrict = { ...env, WAYBILL_STRICT_OWNER: "1" };
  const idB2 = (await upload(tokB, ROUTE, "粤B77777")).waybill?.id;
  let R4 = await toJson(await readById(tokA, idB2, envStrict));
  check("严格模式下 uA 读不到 uB 的运单", R4.success && R4.waybill === null);
  let R5 = await toJson(await readById(tokB, idB2, envStrict));
  check("严格模式下本人仍可读", R5.success && R5.waybill?.id === idB2);
  let R6 = await toJson(await readById(tokA, idB2));
  check("关闭开关后 uA 又能读到（默认共享）", R6.success && R6.waybill?.id === idB2);

  // ===================================================================
  console.log("\n【7】遗留角色归一化（P2-1）：system_admin → admin");
  seed("users:index", ["uLegacy1", "uLegacy2", "uOk"]);
  seed("user:uLegacy1", { id: "uLegacy1", role: "system_admin", name: "老管理员1" });
  seed("user:uLegacy2", { id: "uLegacy2", role: "system_admin", name: "老管理员2" });
  seed("user:uOk", { id: "uOk", role: "admin", name: "正常管理员" });
  const mr = await migMod.normalizeLegacyRoles(env);
  check("归一化扫描到 3 个账户", mr.scanned === 3, "scanned=" + mr.scanned);
  check("2 个 system_admin 被归一化为 admin", mr.normalized === 2, "normalized=" + mr.normalized);
  check("uLegacy1 role 已变为 admin", read("user:uLegacy1").role === "admin");
  check("uLegacy2 role 已变为 admin", read("user:uLegacy2").role === "admin");
  check("uOk（admin）保持不变", read("user:uOk").role === "admin");
  const mr2 = await migMod.normalizeLegacyRoles(env);
  check("重复执行幂等（不再归一化）", mr2.normalized === 0, "normalized=" + mr2.normalized);

  console.log(`\n==== 隔离回归：通过 ${pass} / 失败 ${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
