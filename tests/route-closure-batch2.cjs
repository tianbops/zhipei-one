// 第二批收口回归：P1-02 / P1-04 / P1-05 / P1-06 / P1-08
// ------------------------------------------------------------------
// 背景：第一批（route-closure-batch1）收口了线路删除与 routes 读路径，
//      但以下 5 条生产隐患仍未处理，本用例逐条验证它们真的被收口：
//   P1-02 admin/users.js      列表逐用户 GET + 每用户再 GET 一次线路 = 2N 子请求
//   P1-04 route-requests 两端 列表逐条 GET（管理端每条还读用户+线路 = 3N）
//   P1-05 全局学习冲突/隔离列表 裸 HSCAN + do{...}while(true)，无预算上限
//   P1-06 history 批量读取   readDateWaybillsBatch 未透传 budget → 裸 GET 循环
//   P1-08 预算统一           以上端点共享 SUBREQUEST_LIMIT + throwBudgetExceeded
//
// 断言口径与第一批一致：**子请求数不随数据量线性增长**，且超限时**不谎报 success**。
// 运行：node tests/route-closure-batch2.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

// 平台每请求约 50 子请求上限；留 5 余量
const CAP = 45;

const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
const setkv = (k, obj) => red.command(["SET", "zp:" + k, typeof obj === "string" ? obj : JSON.stringify(obj)]);
const getkv = async k => { const r = await red.command(["GET", "zp:" + k]); if (r === null || r === undefined) return null; try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } };
const req = (path, token, body) => ({
  url: "https://app.local" + path,
  headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) },
  json: async () => body || {},
});

(async () => {
  const adminUsers = await import(baseDir + "admin/users.js");
  const adminReqs = await import(baseDir + "admin/route-requests.js");
  const userReqs = await import(baseDir + "route-requests.js");
  const adminGL = await import(baseDir + "admin/global-learning.js");
  const historyMod = await import(baseDir + "history.js");

  // 管理员账号（各端点共用）
  await setkv("user:adm1", { id: "adm1", role: "admin", username: "adm1", sessionVersion: 1 });
  await setkv("session:tokAdm1", { userId: "adm1", sessionVersion: 1 });

  // ============ 【P1-02】管理员用户列表：2N → 批量 ============
  console.log("【P1-02】admin/users 列表：用户与线路均批量读，子请求不随用户数线性增长");
  const N_USERS = 120;
  for (let i = 0; i < N_USERS; i++) {
    await setkv("user:u" + i, { id: "u" + i, username: "user" + i, name: "U" + i, role: "user", boundRouteId: "RT" + (i % 6), routeDuty: i % 2 ? "driver" : "delivery" });
    await setkv("route:RT" + (i % 6), { id: "RT" + (i % 6), name: "线路" + (i % 6), status: "active" });
  }
  await setkv("users:index", JSON.stringify(Array.from({ length: N_USERS }, (_, i) => "u" + i)));

  subrequests = 0;
  const usersRes = await adminUsers.onRequestGet({ request: req("/api/admin/users", "tokAdm1"), env });
  const usersJson = await usersRes.json();
  check("用户列表返回 success", usersJson.success === true, "HTTP " + usersRes.status + " detail=" + (usersJson.detail || usersJson.error || ""));
  check("120 个用户全部返回（未被截断谎报 success）", (usersJson.users || []).length === N_USERS, "count=" + (usersJson.users || []).length);
  check("线路名正确解析（批量读生效，非全部 null）", (usersJson.users || []).some(u => typeof u.routeName === "string" && u.routeName.length > 0), "sample=" + JSON.stringify((usersJson.users || [])[0]));
  check("P1-02 子请求 ≤ " + CAP + "（2N=240 未退化成线性）", subrequests <= CAP, "subrequests=" + subrequests);
  const baselineUsers = subrequests;

  // ============ 【P1-04】线路申请列表（管理端 3N → 批量）============
  console.log("【P1-04a】admin/route-requests 列表：申请+用户+线路批量读");
  const N_REQS = 100;
  const reqIds = [];
  for (let i = 0; i < N_REQS; i++) {
    const rid = "rq" + i;
    reqIds.push(rid);
    await setkv("user:ru" + i, { id: "ru" + i, username: "ru" + i, name: "RU" + i, role: "user" });
    await setkv("route:rRT" + (i % 5), { id: "rRT" + (i % 5), name: "申请线路" + (i % 5), status: "active" });
    await setkv("route-request:" + rid, { id: rid, userId: "ru" + i, routeId: "rRT" + (i % 5), duty: i % 2 ? "driver" : "delivery", status: "pending", createdAt: "2026-01-01T00:00:00Z" });
  }
  await setkv("route-requests:index", JSON.stringify(reqIds));

  subrequests = 0;
  const rrRes = await adminReqs.onRequestGet({ request: req("/api/admin/route-requests", "tokAdm1"), env });
  const rrJson = await rrRes.json();
  check("管理端申请列表返回 success", rrJson.success === true, "HTTP " + rrRes.status + " detail=" + (rrJson.detail || rrJson.error || ""));
  check("100 条待审申请全部返回", (rrJson.requests || []).length === N_REQS, "count=" + (rrJson.requests || []).length);
  check("关联用户名/线路名已解析", (rrJson.requests || []).some(x => typeof x.username === "string" && typeof x.routeName === "string" && x.routeName.length > 0));
  check("P1-04a 子请求 ≤ " + CAP + "（3N=300 未退化成线性）", subrequests <= CAP, "subrequests=" + subrequests);

  // ============ 【P1-04】用户端申请列表（N → 批量）============
  console.log("【P1-04b】用户端 route-requests 列表：仅返回本人申请且子请求受控");
  await setkv("user:business1", { id: "business1", role: "user", username: "business1", sessionVersion: 1 });
  await setkv("session:tokBiz1", { userId: "business1", sessionVersion: 1 });
  // 让本人在索引里占 40 条
  const mixedIds = [];
  for (let i = 0; i < 40; i++) {
    const rid = "myq" + i;
    mixedIds.push(rid);
    await setkv("route-request:" + rid, { id: rid, userId: "business1", routeId: "rRT0", duty: "driver", status: "pending", createdAt: "2026-01-01T00:00:00Z" });
  }
  for (let i = 0; i < 40; i++) mixedIds.push("otherq" + i);
  for (let i = 0; i < 40; i++) {
    await setkv("user:ou" + i, { id: "ou" + i, username: "ou" + i, role: "user" });
    await setkv("route-request:otherq" + i, { id: "otherq" + i, userId: "ou" + i, routeId: "rRT1", duty: "delivery", status: "pending", createdAt: "2026-01-01T00:00:00Z" });
  }
  await setkv("route-requests:index", JSON.stringify(mixedIds));

  subrequests = 0;
  const myRes = await userReqs.onRequestGet({ request: req("/api/route-requests", "tokBiz1"), env });
  const myJson = await myRes.json();
  check("用户端申请列表返回 success", myJson.success === true, "HTTP " + myRes.status);
  check("仅返回本人 40 条（未越权看到他人申请）", (myJson.requests || []).length === 40, "count=" + (myJson.requests || []).length);
  check("P1-04b 子请求 ≤ " + CAP, subrequests <= CAP, "subrequests=" + subrequests);

  // ============ 【P1-05】全局学习 HSCAN 预算化 ============
  console.log("【P1-05】全局学习冲突/隔离列表：HSCAN 受预算约束，超限显式 partial");
  // 直接注入哈希（等价 800 条 HSET，但避免 800 次往返污染子请求计数）
  const glHash = new Map();
  const N_REC = 800;
  for (let i = 0; i < N_REC; i++) {
    const st = i % 3 === 0 ? "CONFLICT" : (i % 3 === 1 ? "VERIFIED" : "QUARANTINED");
    glHash.set("S" + i, JSON.stringify({ storeId: "S" + i, standardName: "门店" + i, status: st, updatedAt: "2026-01-01T00:00:0" + (i % 10) + "Z", quarantinedAt: "2026-01-02T00:00:00Z" }));
  }
  red.hashes.set("zp:global:learning:records", glHash);

  // —— 段 1：800 field / COUNT=200 → 仅 4 轮，预算内可扫完，partial 应为 false（不谎报截断）
  subrequests = 0;
  const glRes = await adminGL.onRequestGet({ request: req("/api/admin/global-learning", "tokAdm1"), env });
  const glJson = await glRes.json();
  check("冲突列表返回 success", glJson.success === true, "HTTP " + glRes.status);
  check("冲突记录非空（HSCAN 真扫到了数据，桩已修）", (glJson.records || []).length > 0, "records=" + (glJson.records || []).length);
  check("只返回 CONFLICT 状态", (glJson.records || []).every(r => r.status === "CONFLICT"));
  check("预算内扫完时 partial=false（不谎报截断）", glJson.partial === false, "partial=" + glJson.partial);
  check("预算内扫完时 hasMore=false 且 cursor=0", glJson.hasMore === false && glJson.cursor === "0", "cursor=" + glJson.cursor + " hasMore=" + glJson.hasMore);

  // —— 段 2：扩容到 20000 field（COUNT=200 → 需 100 轮 > 预算 40），必须截断且显式 partial
  const bigHash = new Map(glHash);
  for (let i = 0; i < 20000; i++) {
    bigHash.set("BIG" + i, JSON.stringify({ storeId: "BIG" + i, standardName: "大店" + i, status: i % 2 === 0 ? "CONFLICT" : "VERIFIED", updatedAt: "2026-01-01T00:00:00Z" }));
  }
  red.hashes.set("zp:global:learning:records", bigHash);

  subrequests = 0;
  const glBigRes = await adminGL.onRequestGet({ request: req("/api/admin/global-learning", "tokAdm1"), env });
  const glBigJson = await glBigRes.json();
  check("海量冲突列表仍返回 success（列表可续扫，不整请求失败）", glBigJson.success === true, "HTTP " + glBigRes.status);
  check("海量冲突列表子请求 ≤ " + CAP + "（20000 field 不再无限迭代）", subrequests <= CAP, "subrequests=" + subrequests);
  check("海量冲突列表显式 partial=true（诚实信号，绝不谎报扫完）", glBigJson.partial === true, "partial=" + glBigJson.partial);
  check("截断时给出可续扫游标 hasMore=true 且 cursor≠0", glBigJson.hasMore === true && typeof glBigJson.cursor === "string" && glBigJson.cursor !== "0", "cursor=" + glBigJson.cursor + " hasMore=" + glBigJson.hasMore);

  // 续页：带游标继续扫，验证游标语义未被破坏且能推进
  subrequests = 0;
  const contJson = await (await adminGL.onRequestGet({ request: req("/api/admin/global-learning", "tokAdm1"), env })).json();
  check("不带游标重复请求稳定（可重入，无副作用）", contJson.success === true && typeof contJson.cursor === "string");

  subrequests = 0;
  const qRes = await adminGL.onRequestGet({ request: req("/api/admin/global-learning?action=quarantined", "tokAdm1"), env });
  const qJson = await qRes.json();
  check("隔离列表返回 success", qJson.success === true, "HTTP " + qRes.status);
  check("隔离列表截断显式 partial=true（诚实信号）", qJson.partial === true, "partial=" + qJson.partial);
  check("P1-05 隔离列表子请求 ≤ " + CAP, subrequests <= CAP, "subrequests=" + subrequests);

  // 恢复中等规模，供后续用例使用
  red.hashes.set("zp:global:learning:records", glHash);

  // ============ 【P1-06】history 批量读取预算透传 ============
  console.log("【P1-06】history 范围查询：预算透传，超范围显式 503 而非 1101");
  await setkv("user:hist1", { id: "hist1", role: "user", username: "hist1", boundRouteId: "HR", sessionVersion: 1, routeDuty: "driver" });
  await setkv("session:tokHist1", { userId: "hist1", sessionVersion: 1 });
  await setkv("route:HR", { id: "HR", name: "历史线路", status: "active", stores: [] });
  // 造 40 天 × 每天 5 张运单
  const mkDate = n => "2026-0" + (n <= 28 ? 1 : 2) + "-" + String(n <= 28 ? n : n - 28).padStart(2, "0");
  for (let d = 1; d <= 40; d++) {
    const date = mkDate(d);
    const wids = [];
    for (let k = 0; k < 5; k++) {
      const wid = "W" + d + "_" + k;
      wids.push(wid);
      await setkv("waybill:" + wid, { schemaVersion: "2", id: wid, routeId: "HR", date, stage: "CONFIRMED", stores: [], summary: { total: 1 }, createdAt: "2026-01-01T00:00:00Z", userId: "hist1" });
    }
    await red.command(["SADD", "zp:route:HR:waybills:" + date, ...wids]);
  }
  env.WAYBILL_HISTORY_MONTHS = 13;
  subrequests = 0;
  const hRes = await historyMod.onRequestGet({ request: req("/api/history?routeId=HR", "tokHist1"), env });
  const hJson = await hRes.json();
  check("历史范围查询返回 success", hJson.success === true, "HTTP " + hRes.status + " detail=" + (hJson.detail || hJson.error || "") + " code=" + (hJson.code || ""));
  check("查询到 40 天历史", (hJson.history || []).length === 40, "days=" + (hJson.history || []).length);
  check("每日运单数正确（5 张）", (hJson.history || []).every(d => d.count === 5), "sample=" + JSON.stringify((hJson.history || [])[0]));
  check("P1-06 范围查询子请求 ≤ " + CAP + "（200 运单未退化成裸 GET 循环）", subrequests <= CAP, "subrequests=" + subrequests);

  // 超大范围：显式 503，不谎报 success、不撞 1101
  env.WAYBILL_HISTORY_MONTHS = 120;
  subrequests = 0;
  let hBig, hBigJson;
  try { hBig = await historyMod.onRequestGet({ request: req("/api/history?routeId=HR", "tokHist1"), env }); hBigJson = await hBig.json(); }
  catch (e) { hBigJson = { success: false, thrown: String(e && e.message) }; }
  check("超大范围不抛未捕获异常（有兜底）", !hBigJson.thrown, "thrown=" + (hBigJson.thrown || "none"));
  check("超大范围子请求仍 ≤ " + CAP + "（预算护栏生效）", subrequests <= CAP, "subrequests=" + subrequests);
  check("超大范围要么显式 503 PARTIAL_FAILURE，要么正确成功（绝不谎报半截数据）",
    hBigJson.success === true ? (hBigJson.history || []).length === 40 : (hBigJson.code === "PARTIAL_FAILURE" && hBigJson.success === false),
    "success=" + hBigJson.success + " code=" + (hBigJson.code || "") + " days=" + (hBigJson.history || []).length);
  env.WAYBILL_HISTORY_MONTHS = 13;

  // ============ 【P1-08】预算统一：所有收口端点共享 SUBREQUEST_LIMIT ============
  console.log("【P1-08】预算统一：子请求上限一致，无裸 HSCAN / 无未受控列表");
  const { SUBREQUEST_LIMIT } = await import(baseDir + "_redis-budget.js");
  const budgetMod = await import(baseDir + "_redis-budget.js");
  check("SUBREQUEST_LIMIT = 40（留 10 给鉴权/日志/响应）", SUBREQUEST_LIMIT === 40, "limit=" + SUBREQUEST_LIMIT);
  check("hscanBudgeted 已导出为唯一真相源助手", typeof budgetMod.hscanBudgeted === "function");
  check("P1-02 列表子请求已远低于 2N（240 → " + baselineUsers + "）", baselineUsers <= CAP && baselineUsers < N_USERS * 2, "subrequests=" + baselineUsers);

  // 关键不变量：把数据量再放大 3 倍，子请求数不得线性增长（护栏 vs 裸循环的分水岭）
  const BIG = N_USERS * 3;
  for (let i = N_USERS; i < BIG; i++) await setkv("user:u" + i, { id: "u" + i, username: "user" + i, name: "U" + i, role: "user" });
  await setkv("users:index", JSON.stringify(Array.from({ length: BIG }, (_, i) => "u" + i)));
  subrequests = 0;
  let bigJson;
  try { const r = await adminUsers.onRequestGet({ request: req("/api/admin/users", "tokAdm1"), env }); bigJson = await r.json(); }
  catch (e) { bigJson = { thrown: String(e && e.message) }; }
  check("360 用户时不抛未捕获异常", !bigJson.thrown, "thrown=" + (bigJson.thrown || "none"));
  check("360 用户子请求 ≤ " + CAP + "（3 倍数据量不退化 = 护栏生效）", subrequests <= CAP, "subrequests=" + subrequests);
  check("360 用户时显式报错或完整返回，绝不返回「只列一半」的 success",
    bigJson.success === true ? (bigJson.users || []).length === BIG : bigJson.success === false,
    "success=" + bigJson.success + " users=" + (bigJson.users || []).length);

  console.log("\nROUTE_CLOSURE_BATCH2：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
