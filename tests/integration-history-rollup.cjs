// 方案C rollup 集成回归：历史概览改为读「每日汇总键」meta，与单量脱钩。
// 运行：node tests/integration-history-rollup.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const getReq = (url, token, method) => ({
  url, method: method || "GET",
  headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }
});

(async () => {
  const R = "route-roll";
  const uId = "uR", tok = "tok-R";
  seed("user:" + uId, { id: uId, role: "user", boundRouteId: R, dispatchRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tok, { userId: uId, sessionVersion: 1 });
  seed("route:" + R, { id: R, name: "线路R", status: "active" });

  const D1 = "2026-05-10", D2 = "2026-05-11", D3 = "2026-05-12";
  const mk = (id, date, nStores, weight, createdBy) => ({
    schemaVersion: "2", id, routeId: R, routeName: "线路R", date, vehicle: "粤B1", totalWeight: weight,
    stores: Array.from({ length: nStores }, (_, i) => ({ name: "s" + id + i })),
    summary: { original: nStores, total: nStores, matched: nStores, pending: 0, correction: 0, merged: 0, newStores: 0 },
    stage: "CONFIRMED", pipeline: ["CONFIRMED"], createdBy: createdBy || uId,
    createdAt: date + "T00:00:00.000Z", quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null }
  });
  const w1 = mk("W1", D1, 3, 1.5), w2 = mk("W2", D1, 1, 2.5), w3 = mk("W3", D2, 2, 0.8), w4 = mk("W4", D3, 1, 0.3, "otherUser");
  for (const w of [w1, w2, w3, w4]) seed("waybill:" + w.id, w);
  red.command(["SADD", "zp:route:" + R + ":waybills:" + D1, "W1", "W2"]);
  red.command(["SADD", "zp:route:" + R + ":waybills:" + D2, "W3"]);
  red.command(["SADD", "zp:route:" + R + ":waybills:" + D3, "W4"]);

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const histMod = await import(baseDir + "history.js");
  const metaMod = await import(baseDir + "waybills/_waybill-meta.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
  const envStrict = { ...env, WAYBILL_STRICT_OWNER: "1" };

  console.log("\n[A] recomputeDayMeta 直接重算 D1（2 单，3+1 店，1.5+2.5 重）");
  const a = await metaMod.recomputeDayMeta(env, R, D1);
  check("count=2", a && a.count === 2, JSON.stringify(a));
  check("storeCount=4", a && a.storeCount === 4, JSON.stringify(a));
  check("totalWeight=4", a && Math.abs(a.totalWeight - 4) < 1e-9, JSON.stringify(a));

  console.log("\n[B] 概览读「已存在」meta（用 sentinel 证明走 meta 而非读运单体）");
  red.command(["SET", "zp:route:" + R + ":waybills:" + D1 + ":meta", JSON.stringify({ v: 1, count: 4242, storeCount: 9999, totalWeight: 8888 })]);
  const m = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R, tok), env })).json();
  const d1 = m.history.find(x => x.date === D1);
  check("概览返回 sentinel 值（证明走 meta）", d1 && d1.count === 4242 && d1.storeCount === 9999 && d1.totalWeight === 8888, JSON.stringify(d1));
  check("概览无 503", m.success === true, JSON.stringify(m).slice(0, 120));
  // 2026-05 合计 = D1(sentinel 4242) + D2(自愈 1) + D3(自愈 1) = 4244
  check("month 聚合汇总正确", m.months.some(mo => mo.month === "2026-05" && mo.waybills === 4242 + 1 + 1), JSON.stringify(m.months));

  console.log("\n[C] legacy 缺 meta：概览按日自愈并回填");
  const metaD2 = JSON.parse(await red.command(["GET", "zp:route:" + R + ":waybills:" + D2 + ":meta"]) || "null");
  check("D2 meta 自愈重建为 1/2/0.8", metaD2 && metaD2.count === 1 && metaD2.storeCount === 2 && Math.abs(metaD2.totalWeight - 0.8) < 1e-9, JSON.stringify(metaD2));

  console.log("\n[D] 删除运单后 meta 同步重算");
  const delRes = await (await histMod.onRequestDelete({ request: getReq("https://app.local/api/history?routeId=" + R + "&date=" + D1 + "&waybillId=W1", tok, "DELETE"), env })).json();
  check("删除 W1 成功", delRes.success === true, JSON.stringify(delRes).slice(0, 120));
  const metaD1 = JSON.parse(await red.command(["GET", "zp:route:" + R + ":waybills:" + D1 + ":meta"]));
  check("D1 meta 重算为 1/1/2.5", metaD1 && metaD1.count === 1 && metaD1.storeCount === 1 && Math.abs(metaD1.totalWeight - 2.5) < 1e-9, JSON.stringify(metaD1));
  const m2 = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R, tok), env })).json();
  const d1b = m2.history.find(x => x.date === D1);
  check("概览反映删除后 D1 count=1", d1b && d1b.count === 1, JSON.stringify(d1b));
  // 删除后索引也清掉，再确认一次自愈不会把已删单算进去
  const metaD1b = JSON.parse(await red.command(["GET", "zp:route:" + R + ":waybills:" + D1 + ":meta"]));
  check("meta 不含已删 W1（count 仍为 1）", metaD1b.count === 1, JSON.stringify(metaD1b));

  console.log("\n[E] WAYBILL_STRICT_OWNER=1 紧急模式回退读真实体（他建运单排除）");
  const mN = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R, tok), env })).json();
  const d3n = mN.history.find(x => x.date === D3);
  check("非严格：他建 W4 计入（count=1）", d3n && d3n.count === 1, JSON.stringify(d3n));
  const mS = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R, tok), env: envStrict })).json();
  const d3s = mS.history.find(x => x.date === D3);
  check("严格：他建 W4 排除（count=0，回退读真实体）", d3s && d3s.count === 0, JSON.stringify(d3s));
  // 严格模式不得把 per-user 结果写入 meta（否则会污染后续非严格读取）
  const metaD3 = await red.command(["GET", "zp:route:" + R + ":waybills:" + D3 + ":meta"]);
  check("严格模式不写 meta（保持缺失/自愈前状态）", metaD3 === null || JSON.parse(metaD3).count !== 0, "meta=" + metaD3);

  console.log("\nHISTORY_ROLLUP 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
