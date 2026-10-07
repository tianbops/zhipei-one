// 第一批收口回归：P1-01（SCAN 截断不得 success）+ P1-03（普通用户不触发全局改写）
// 运行：node tests/route-closure-batch1.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let dailyWaybillKey = null;
const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const set = (k, o) => red.command(["SET", "zp:" + k, typeof o === "string" ? o : JSON.stringify(o)]);
const exists = async k => { const v = await red.command(["GET", "zp:" + k]); return v !== null && v !== undefined; };

const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];

(async () => {
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const routesMod = await import(baseDir + "routes.js");
  ({ dailyWaybillKey } = await import(baseDir + "_waybill-identity.js"));
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };

  // ===== 场景 3（P1-01）：日期桶扫描被预算截断时，删除必须返回非 success，且线路/运单不被删除 =====
  console.log("【3】SCAN 截断（键空间过大）：删除被中止，绝不返回 success:true");
  const RD = "route-del-trunc";
  const uD = "uD-driver", uE = "uE-delivery", uAdm = "uAdm", tokAdm = "tokAdm";
  await set("user:" + uD, { id: uD, role: "user", boundRouteId: RD, routeDuty: "driver", sessionVersion: 1 });
  await set("user:" + uE, { id: uE, role: "user", boundRouteId: RD, routeDuty: "delivery", sessionVersion: 1 });
  await set("user:" + uAdm, { id: uAdm, role: "admin", sessionVersion: 1 });
  await set("session:" + tokAdm, { userId: uAdm, sessionVersion: 1 });
  await set("routes:index", JSON.stringify([RD]));
  await set("route:" + RD, { id: RD, name: "截断线路", status: "active", driverUserId: uD, deliveryUserId: uE });
  await set("route-requests:index", JSON.stringify([]));
  // 30 个日期桶 + 对应运单
  for (let i = 0; i < 30; i++) {
    const d = DATES[i % DATES.length];
    const id = "WT-" + i;
    const rec = { schemaVersion: "2", id, routeId: RD, date: d, vehicle: "粤B0001", totalWeight: 0.1, stores: [],
      businessFingerprint: "fp-" + id, requestId: "req-" + id, stage: "CONFIRMED", createdAt: d + "T08:00:00.000Z" };
    await set("waybill:" + id, rec);
    await red.command(["SADD", "zp:route:" + RD + ":waybills:" + d, id]);
    await set("waybill:fingerprint:" + rec.businessFingerprint, id);
    await set("waybill:proc:" + rec.requestId, JSON.stringify({ requestId: rec.requestId, waybillId: id }));
    const sig = await dailyWaybillKey(rec);
    await set("waybill:dedupe:" + sig, id);
  }
  // 制造超大键空间：9000 个无关 dummy 键，使 SCAN(count=200) 在 40 预算内扫不完 → complete=false
  for (let i = 0; i < 9000; i++) await red.command(["SET", "zp:dummy:" + i, "1"]);

  const delReq = routeId => ({
    url: "https://app.local/api/routes",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tokAdm : null) },
    json: async () => ({ action: "delete", routeId })
  });
  const r3 = await routesMod.onRequestPost({ request: delReq(RD), env });
  const j3 = await r3.json();
  check("删除返回非 success（SCAN 截断即中止，绝不谎报成功）", j3.success === false, "HTTP " + r3.status + " | " + JSON.stringify(j3).slice(0, 160));
  check("返回结构化错误且指向扫描/预算", !!j3 && /BUDGET|route-waybill-scan|预算|子请求/.test(j3.detail || j3.error || ""), j3 && (j3.detail || j3.error));
  check("线路主记录未被删除（中止安全）", await exists("route:" + RD));
  check("线路运单主键未被误删（删除已中止）", await exists("waybill:WT-0"));

  // ===== 场景 4（P1-03）：普通业务用户调 /api/routes 不触发全局绑定改写；仅管理员触发 =====
  console.log("【4】权限越界：普通用户读取线路不改写他人；管理员才做一致性修复");
  const R1 = "route-batch-a", R2 = "route-batch-b";
  const uVictim = "uVictim", uOther = "uOther2", uAdm2 = "uAdm2", tokV = "tokV", tokAdm2 = "tokAdm2";
  // uVictim 绑定 R2 为 driver，但 R2.driverUserId 指向 uOther（不一致，管理员应清掉 uVictim 绑定）
  await set("user:" + uVictim, { id: uVictim, role: "user", boundRouteId: R2, routeDuty: "driver", sessionVersion: 1 });
  await set("user:" + uOther, { id: uOther, role: "user", boundRouteId: R2, routeDuty: "delivery", sessionVersion: 1 });
  await set("user:" + uAdm2, { id: uAdm2, role: "admin", sessionVersion: 1 });
  await set("session:" + tokV, { userId: uVictim, sessionVersion: 1 });
  await set("session:" + tokAdm2, { userId: uAdm2, sessionVersion: 1 });
  await set("routes:index", JSON.stringify([R1, R2]));
  await set("route:" + R1, { id: R1, name: "线路A", status: "active" });
  await set("route:" + R2, { id: R2, name: "线路B", status: "active", driverUserId: uOther, deliveryUserId: uOther });
  await set("users:index", JSON.stringify([uVictim, uOther]));
  // 注意：R2.driverUserId=uOther（≠uVictim），uVictim 的绑定与线路占用不一致

  const getReq = tok => ({
    url: "https://app.local/api/routes",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tok : null) },
    json: async () => ({})
  });
  // 普通用户调用
  const rN = await routesMod.onRequestGet({ request: getReq(tokV), env });
  const jN = await rN.json();
  check("普通用户 GET 返回成功且含线路列表", jN.success === true && Array.isArray(jN.routes) && jN.routes.length === 2, "routes=" + (jN.routes ? jN.routes.length : "?"));
  const vAfterUser = JSON.parse(await red.command(["GET", "zp:user:" + uVictim]));
  check("普通用户调用后 uVictim.boundRouteId 未被改写（仍为 R2）", vAfterUser.boundRouteId === R2, "boundRouteId=" + vAfterUser.boundRouteId);

  // 管理员调用
  const rA = await routesMod.onRequestGet({ request: getReq(tokAdm2), env });
  const jA = await rA.json();
  check("管理员 GET 返回成功", jA.success === true, "HTTP " + rA.status);
  const vAfterAdmin = JSON.parse(await red.command(["GET", "zp:user:" + uVictim]));
  const r2After = JSON.parse(await red.command(["GET", "zp:route:" + R2]));
  // 管理员一致性修复的语义：R2.driverUserId 原本错指向 uOther（uOther 实为 delivery），
  // 巡检先让出该错位 slot、再还原孤儿司机 uVictim → 终态一致，而非简单清空 uVictim。
  check("管理员触发一致性修复（R2.driverUserId 被纠正为 uVictim）", r2After.driverUserId === uVictim, "R2.driverUserId=" + r2After.driverUserId);
  check("修复后绑定终态一致：uVictim 仍为 R2 司机且 R2.driverUserId 指向 uVictim", vAfterAdmin.boundRouteId === R2 && r2After.driverUserId === uVictim, "boundRouteId=" + vAfterAdmin.boundRouteId + " R2.driver=" + r2After.driverUserId);

  console.log("\nROUTE_CLOSURE_BATCH1：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
