// 1.1 架构级根治：统一子请求预算模块（_redis-budget.js）回归
// ------------------------------------------------------------------
// 四读路径（诊断列表 / 一致性巡检 / 运营统计 / 线路删除）曾各写一份 makeBudget / scanKeys /
// mget* / smembers*，常量与 complete 语义都不统一，「再有一处忘记预算」即成第 5 次复发。
// 本用例把预算逻辑收口后的单一真相源（_redis-budget.js）钉死在 CI：
//   1. Budget 计数语义（take / canTake / remaining / exhausted）；
//   2. scanKeysBudgeted 在「预算耗尽 / 迭代上限 / 单模式键上限」三种边界都停并返回 complete=false；
//   3. mgetBatchMap / mgetBatchList / smembersBatch 分块正确、预算耗尽返回 partial+complete=false、
//      且子请求数 = ceil(N/BATCH)（O(1) 而非 O(N)）；
//   4. createScopedClient 硬上限：超出即抛 SUBREQUEST_BUDGET_EXCEEDED（_safe.js 兜底成 503）；
//   5. computeStats 真正纳入统一预算——大键空间下优雅置 truncated=true 而非抛 1101；
//   6. _safe.classify 把该错误归为 503 REQUEST_BUDGET_EXCEEDED。
// 运行：node tests/integration-redis-budget.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

// makeUpstash 已接管 global.fetch；再包一层计数，每个 fetch = 1 次子请求
let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;

(async () => {
  const budgetMod = await import(baseDir + "_redis-budget.js");
  const { Budget, SUBREQUEST_LIMIT, scanKeysBudgeted, mgetBatchMap, mgetBatchList,
    smembersBatch, createScopedClient } = budgetMod;
  const safeMod = await import(baseDir + "_safe.js");
  const statsMod = await import(baseDir + "waybills/_stats.js");

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const seed = (k, v) => red.command(["SET", "zp:" + k, typeof v === "string" ? v : JSON.stringify(v)]);
  const set = (k, v) => red.command(["SET", k, typeof v === "string" ? v : JSON.stringify(v)]);

  // ============ 1. Budget 计数语义 ============
  console.log("【1】Budget 计数语义");
  const b = new Budget(3);
  check("初始 used=0", b.used === 0);
  check("take(1) 成功", b.take(1) === true && b.used === 1);
  check("canTake(3) 为 false（将越限）", b.canTake(3) === false);
  check("remaining=2", b.remaining === 2);
  check("take(2) 成功", b.take(2) === true && b.used === 3);
  check("已耗尽时 take(1) 失败并置 exhausted", b.take(1) === false && b.exhausted === true);
  check("耗尽后 remaining=0", b.remaining === 0);

  // ============ 2. scanKeysBudgeted 三种边界 ============
  console.log("【2】scanKeysBudgeted 预算 / 迭代上限 / 键上限");
  for (let i = 0; i < 30; i++) set("zp:wb:k" + i, "v");
  // 2a 预算耗尽：max=5，COUNT=5 → 每迭代 5 键，6 次迭代即越限
  const b2 = new Budget(5);
  subrequests = 0;
  const r2 = await scanKeysBudgeted(env, "zp:wb:*", b2, { count: 5 });
  check("预算耗尽立即停（complete=false）", r2.complete === false, "used=" + b2.used);
  check("预算耗尽未越平台硬限（子请求 ≤ 限）", subrequests <= 5, "sub=" + subrequests);
  // 2b 迭代上限：iterCap=2，COUNT=100。先注入大量无关键把 wb2 推到游标后方，
  // 验证 iterCap 真正截断（而非「一次 SCAN 碰巧覆盖全键空间」的假通过）。
  for (let i = 0; i < 401; i++) set("zp:pad:p" + i, "v");
  for (let i = 0; i < 30; i++) set("zp:wb2:m" + i, "v");
  const b2b = new Budget(40);
  const r2b = await scanKeysBudgeted(env, "zp:wb2:*", b2b, { count: 100, iterCap: 2 });
  check("iterCap 截断 complete=false", r2b.complete === false);
  check("iterCap 截断未扫到尾部稀疏键（keys 远小于全量）", r2b.keys.length < 30, "keys=" + r2b.keys.length);
  // 2c 键上限 cap（独立前缀，避免被 2b 注入的 pad 键挤到游标后方、预算先耗尽）
  for (let i = 0; i < 21; i++) set("zp:cap:c" + i, "v");
  const b2c = new Budget(40);
  const r2c = await scanKeysBudgeted(env, "zp:cap:c*", b2c, { count: 5, cap: 7 });
  check("cap 截断键数被钳到 cap", r2c.keys.length === 7 && r2c.complete === false, "keys=" + r2c.keys.length);
  // 2d 充足预算下完整返回（pattern 收窄到 zp:wb:k*，避开同前缀的 zp:wb2:* 干扰）
  const b2d = new Budget(40);
  const r2d = await scanKeysBudgeted(env, "zp:wb:k*", b2d, { count: 100 });
  check("充足预算下完整返回", r2d.complete === true && r2d.keys.length === 30, "keys=" + r2d.keys.length);

  // ============ 3. 三类 batch 助手 ============
  console.log("【3】mgetBatchMap / mgetBatchList / smembersBatch 分块与预算");
  for (let i = 0; i < 250; i++) { set("zp:m:k" + i, "V" + i); red.command(["SADD", "zp:s:set", "m" + i]); }
  // 3a mgetBatchMap 分块 = ceil(250/100)=3，返回 Map
  const b3 = new Budget(40);
  subrequests = 0;
  const m3 = await mgetBatchMap(env, Array.from({ length: 250 }, (_, i) => "zp:m:k" + i), b3);
  check("mgetBatchMap 子请求 = ceil(250/100)=3（O(1)）", subrequests === 3, "sub=" + subrequests);
  check("mgetBatchMap 返回完整 Map", m3.map.size === 250 && m3.complete === true);
  check("mgetBatchMap 取值正确", m3.map.get("zp:m:k7") === "V7");
  // 3b mgetBatchList 同序
  const b3b = new Budget(40);
  const l3 = await mgetBatchList(env, Array.from({ length: 250 }, (_, i) => "zp:m:k" + i), b3b);
  check("mgetBatchList 长度=250 且同序", l3.list.length === 250 && l3.list[7] === "V7");
  // 3c smembersBatch 分块 = ceil(1/50)=1，返回 Map
  const b3c = new Budget(40);
  subrequests = 0;
  const s3 = await smembersBatch(env, ["zp:s:set"], b3c);
  check("smembersBatch 子请求 = 1（pipeline 批）", subrequests === 1, "sub=" + subrequests);
  check("smembersBatch 返回全部成员", s3.map.get("zp:s:set").length === 250 && s3.complete === true);
  // 3d 预算耗尽则返回 partial + complete=false（不抛）
  const b3d = new Budget(2);
  const m3d = await mgetBatchMap(env, Array.from({ length: 250 }, (_, i) => "zp:m:k" + i), b3d);
  check("预算耗尽时 mgetBatchMap 返回 partial", m3d.map.size < 250 && m3d.complete === false, "size=" + m3d.map.size);
  const b3e = new Budget(1);
  const s3e = await smembersBatch(env, Array.from({ length: 200 }, (_, i) => "zp:s:set"), b3e);
  check("预算耗尽时 smembersBatch 部分完成（complete=false）", s3e.complete === false);

  // ============ 4. createScopedClient 硬上限 ============
  console.log("【4】createScopedClient 硬上限客户端");
  for (let i = 0; i < 10; i++) set("zp:hc:k" + i, "v");
  const client = createScopedClient(env, 3);
  let ok = true, err = null;
  try {
    await client.command(["GET", "zp:hc:k0"]);   // 1
    await client.command(["GET", "zp:hc:k1"]);   // 2
    await client.command(["GET", "zp:hc:k2"]);   // 3
    await client.command(["GET", "zp:hc:k3"]);   // 4 → 应抛
  } catch (e) { err = e; ok = false; }
  check("超出硬上限抛出（未静默越限）", err !== null && err.code === "SUBREQUEST_BUDGET_EXCEEDED", err ? err.code : "no-throw");
  check("抛出前已成功执行前 3 次", ok === false && client.budget.used === 3);
  // scan 越限同样抛
  const client2 = createScopedClient(env, 2);
  let err2 = null;
  try { await client2.scan("zp:hc:*", { count: 1 }); } catch (e) { err2 = e; }
  check("scan 越限抛出 SUBREQUEST_BUDGET_EXCEEDED", !!err2 && err2.code === "SUBREQUEST_BUDGET_EXCEEDED", err2 && err2.code);

  // ============ 5. computeStats 真正纳入统一预算（大键空间优雅降级） ============
  console.log("【5】computeStats 统一预算：大键空间不 1101，优雅 truncated");
  const R1 = "R-budget-A", R2 = "R-budget-B";
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  function seedStats(route, n) {
    for (let i = 1; i <= n; i++) {
      const d = dates[i % dates.length];
      const id = route + "-W" + i;
      seed("waybill:" + id, {
        schemaVersion: "2", id, routeId: route, routeName: route, date: d, vehicle: "粤B" + String(i).padStart(4, "0"),
        totalWeight: 0.1, stores: [], summary: { original: 0, total: 0, matched: 0, pending: 0, correction: 0, merged: 0, newStores: 0 },
        stage: "CONFIRMED", pipeline: ["CONFIRMED"], createdBy: "u", createdAt: d + "T08:00:00.000Z",
        quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null }
      });
      red.command(["SADD", "zp:route:" + route + ":waybills:" + d, id]);
    }
  }
  seedStats(R1, 30); seedStats(R2, 30);
  subrequests = 0;
  const stScoped = await statsMod.computeStats(env, { routeId: R1, days: 30 });
  check("scoped 统计成功", stScoped.scannedWaybills === 30, "scanned=" + stScoped.scannedWaybills);
  check("scoped 子请求在预算内", subrequests <= 20, "sub=" + subrequests);
  check("scoped 未截断", stScoped.truncated === false);

  // 大键空间：注入大量无关键，迫使 all=true 的索引 SCAN 迭代越过预算（优雅 truncated，不抛）
  for (let i = 1; i <= 25000; i++) set("zp:cache:j" + i, "v" + i);
  subrequests = 0;
  let stAll, threwAll = null;
  try { stAll = await statsMod.computeStats(env, { all: true, days: 90 }); }
  catch (e) { threwAll = e; }
  check("大键空间 all=true 未向外抛（不会 1101）", threwAll === null, threwAll ? String(threwAll.message) : "");
  check("大键空间 all=true 子请求 ≤ 模块预算 " + SUBREQUEST_LIMIT, subrequests <= SUBREQUEST_LIMIT, "sub=" + subrequests);
  check("大键空间 all=true 声明结论不完整 truncated=true", !!stAll && stAll.truncated === true, stAll && ("truncated=" + stAll.truncated));

  // ============ 6. _safe.classify 预算错误 ============
  console.log("【6】_safe.classify 把预算耗尽归为 503 REQUEST_BUDGET_EXCEEDED");
  const c = safeMod.classify(Object.assign(new Error("SUBREQUEST_BUDGET_EXCEEDED max=40"), { code: "SUBREQUEST_BUDGET_EXCEEDED" }));
  check("分类为 503", c.status === 503, "status=" + c.status);
  check("code=REQUEST_BUDGET_EXCEEDED", c.code === "REQUEST_BUDGET_EXCEEDED", c.code);
  check("与数据服务错误区分（REDIS_ERROR→503 DATA_STORE_UNAVAILABLE）",
    safeMod.classify(new Error("REDIS_ERROR")).code === "DATA_STORE_UNAVAILABLE");

  console.log("\nREDIS_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
