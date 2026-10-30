// 聚合接口回归：dispatch-bootstrap / home-bootstrap + readRoutes 批量读取实证
// 运行：node tests/integration-bootstrap-aggregate.cjs
//
// 覆盖：
//   一、dispatch-bootstrap：自动临时线路 / 显式调度线路 / 401 / 403 / 409 数据异常
//   二、聚合 routes 与 /api/routes 逐字段一致（聚合不改变数据）
//   三、home-bootstrap：user 字段与 /api/me 逐字段一致 + 401
//   四、命令数实证：3 条线路的聚合读总命令数 ≤ 8，且以 MGET 批量读取
//       （历史逐条实现为 4M+2 次串行往返：M=3 时 14 次 → 现 6 次）
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const red = makeUpstash(new MiniRedis());
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const dsb = await import(baseDir + "dispatch-bootstrap.js");
  const hsb = await import(baseDir + "home-bootstrap.js");
  const routesMod = await import(baseDir + "routes.js");
  const meMod = await import(baseDir + "me.js");

  const set = (k, o) => red.command(["SET", "zp:" + k, typeof o === "string" ? o : JSON.stringify(o)]);
  const req = tok => ({
    url: "https://app.local/api/dispatch-bootstrap",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tok : null) }
  });

  /* ---------- 种子 ---------- */
  await set("user:u1", { id: "u1", username: "driver1", role: "user", sessionVersion: 1 });
  await set("session:tok1", { userId: "u1", sessionVersion: 1 });
  await set("user:u2", { id: "u2", username: "driver2", role: "user", boundRouteId: "R2", routeDuty: "driver", dispatchRouteId: "R2", sessionVersion: 1 });
  await set("session:tok2", { userId: "u2", sessionVersion: 1 });
  await set("user:adm", { id: "adm", username: "admin", role: "admin", sessionVersion: 1 });
  await set("session:tokAdm", { userId: "adm", sessionVersion: 1 });
  await set("routes:index", JSON.stringify(["R1", "R2", "R3"]));
  await set("route:R1", { id: "R1", name: "线路一", status: "active", driverUserId: "u2", deliveryUserId: null });
  await set("route:R2", { id: "R2", name: "线路二", status: "active" });
  await set("route:R3", { id: "R3", name: "线路三", status: "disabled" });
  await set("route:R1:base", { stores: [{}, {}, {}] });
  await set("route:R2:base", { stores: [] });
  await set("route:R3:base", JSON.stringify({ stores: [{}, {}] }));   // 字符串形态也要能解析

  console.log("【1】dispatch-bootstrap：无绑定用户 → 自动临时线路 + 线路列表");
  const rA = await dsb.onRequestGet({ request: req("tok1"), env });
  const jA = await rA.json();
  check("聚合返回 200 + success", rA.status === 200 && jA.success === true);
  check("自动分配临时线路", jA.dispatchRoute && jA.dispatchRoute.id === "__temp__:u1" && jA.dispatchRoute.type === "temporary", JSON.stringify(jA.dispatchRoute));
  check("线路列表 3 条、字段与 storeCount 正确",
    Array.isArray(jA.routes) && jA.routes.length === 3 &&
    (r => r && r.id === "R1" && r.storeCount === 3 && r.driverUserId === "u2")(jA.routes.find(r => r.id === "R1")) &&
    (r => r && r.storeCount === 0)(jA.routes.find(r => r.id === "R2")) &&
    (r => r && r.status === "disabled" && r.storeCount === 2)(jA.routes.find(r => r.id === "R3")),
    JSON.stringify(jA.routes));
  /* 注意：此处按 id 定位而非下标——线路列表自「升序排列」需求起按名称自然序输出
     （线路三 < 线路二，码点序），下标会随排序变化；顺序契约由【7】专责断言。 */

  const rRoutes = await routesMod.onRequestGet({ request: req("tok1"), env });
  const jRoutes = await rRoutes.json();
  check("聚合 routes 与 /api/routes 逐字段一致", JSON.stringify(jA.routes) === JSON.stringify(jRoutes.routes));

  console.log("【2】dispatch-bootstrap：显式调度线路");
  const rB = await dsb.onRequestGet({ request: req("tok2"), env });
  const jB = await rB.json();
  check("u2 调度线路解析为 R2", jB.success && jB.dispatchRoute && jB.dispatchRoute.id === "R2" && jB.dispatchRoute.name === "线路二" && jB.dispatchRoute.type === "route");

  console.log("【3】鉴权与权限契约（与 /api/dispatch、/api/routes 一致）");
  const rC1 = await dsb.onRequestGet({ request: { url: "x", headers: { get: () => null } }, env });
  check("未登录 401", rC1.status === 401 && (await rC1.json()).error === "未登录");
  const rC2 = await dsb.onRequestGet({ request: req("tokAdm"), env });
  const jC2 = await rC2.json();
  check("管理员 403", rC2.status === 403 && jC2.error === "管理员不参与业务调度");

  console.log("【4】线路数据损坏 → 409（消息与 /api/routes 逐字一致）");
  await set("route:R2", { id: "R2", name: "", status: "active" });
  const rD = await dsb.onRequestGet({ request: req("tok1"), env });
  const jD = await rD.json();
  check("数据异常 409 + ROUTE_DATA_INVALID + 原消息", rD.status === 409 && jD.code === "ROUTE_DATA_INVALID" && jD.error === "线路数据异常，请联系管理员处理", JSON.stringify(jD));
  const rD2 = await routesMod.onRequestGet({ request: req("tok1"), env });
  const jD2 = await rD2.json();
  check("/api/routes 同场景同消息（契约未漂移）", rD2.status === 409 && jD2.error === jD.error);
  await set("route:R2", { id: "R2", name: "线路二", status: "active" });

  console.log("【5】home-bootstrap：user 与 /api/me 逐字段一致");
  const rE = await hsb.onRequestGet({ request: req("tok2"), env });
  const jE = await rE.json();
  const rMe = await meMod.onRequestGet({ request: req("tok2"), env });
  const jMe = await rMe.json();
  check("user 字段逐字段一致", JSON.stringify(jE.user) === JSON.stringify(jMe.user), JSON.stringify(jE.user));
  check("调度线路正确", jE.dispatchRoute && jE.dispatchRoute.id === "R2");
  const rE2 = await hsb.onRequestGet({ request: { url: "x", headers: { get: () => null } }, env });
  check("未登录 401", rE2.status === 401);

  console.log("【6】命令数实证（3 条线路）");
  const origFetch = global.fetch;
  let cmds = [];
  global.fetch = async (url, init) => {
    if (init && init.body) {
      const b = JSON.parse(init.body);
      if (Array.isArray(b) && Array.isArray(b[0])) cmds.push(...b); else cmds.push(b);
    }
    return origFetch(url, init);
  };
  const rF = await dsb.onRequestGet({ request: req("tok2"), env });
  await rF.json();
  global.fetch = origFetch;
  const names = cmds.map(c => c[0] + (c[1] && String(c[1]).length < 40 ? " " + c[1] : ""));
  check("总命令数 ≤ 8（历史逐条实现 14 次）", cmds.length <= 8, "实际 " + cmds.length + " 次: " + names.join(" | "));
  check("以 MGET 批量读取线路主记录与 base", cmds.filter(c => c[0] === "MGET").length >= 2, names.join(" | "));
  const perRouteGets = cmds.filter(c => c[0] === "GET" && /^zp:route:R/.test(String(c[1] || ""))).length;
  check("逐条 GET zp:route:* ≤ 1（仅调度线路解析一次）", perRouteGets <= 1, "perRouteGets=" + perRouteGets);

  console.log("【6A】聚合接口独立读取并发验证（避免存储往返串行叠加）");
  const observeParallelGets = async (run, keys) => {
    const original = global.fetch;
    let active = 0, maximum = 0;
    global.fetch = async (url, init) => {
      let body = null;
      try { body = init?.body ? JSON.parse(init.body) : null; } catch {}
      const watched = Array.isArray(body) && body[0] === "GET" && keys.includes(body[1]);
      if (!watched) return original(url, init);
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 8));
        return await original(url, init);
      } finally { active--; }
    };
    try {
      const response = await run();
      await response.json();
      return maximum;
    } finally { global.fetch = original; }
  };
  const dispatchOverlap = await observeParallelGets(
    () => dsb.onRequestGet({ request: req("tok2"), env }),
    ["zp:routes:index", "zp:route:R2"]
  );
  check("dispatch-bootstrap：线路列表与调度线路读取重叠执行", dispatchOverlap >= 2, "最大并发=" + dispatchOverlap);
  const homeOverlap = await observeParallelGets(
    () => hsb.onRequestGet({ request: req("tok2"), env }),
    ["zp:route:R2", "zp:session:tok2"]
  );
  check("home-bootstrap：调度线路读取与会话续期读取重叠执行", homeOverlap >= 2, "最大并发=" + homeOverlap);

  console.log("【7】线路列表按名称自然序升序（产品要求「线路排列，升序排列」）");
  {
    // 全新 Redis 实例，索引刻意按「生产实测的降序」摆放（17→16→…→1 的索引方向），
    // 验证 readRoutes 出口统一升序，且与索引方向无关。
    const red2 = makeUpstash(new MiniRedis());
    const env2 = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
    const set2 = (k, o) => red2.command(["SET", "zp:" + k, typeof o === "string" ? o : JSON.stringify(o)]);
    await set2("user:u1", { id: "u1", username: "driver1", role: "user", sessionVersion: 1 });
    await set2("session:tok1", { userId: "u1", sessionVersion: 1 });
    await set2("routes:index", JSON.stringify(["R17", "R16", "R10", "R2", "R1", "R3"]));
    await set2("route:R17", { id: "R17", name: "17号线", status: "active" });
    await set2("route:R16", { id: "R16", name: "16号线", status: "active" });
    await set2("route:R10", { id: "R10", name: "10号线", status: "active" });
    await set2("route:R2", { id: "R2", name: "2号线", status: "active" });
    await set2("route:R1", { id: "R1", name: "1号线", status: "active" });
    await set2("route:R3", { id: "R3", name: "3号线", status: "disabled" });
    for (const rid of ["R17", "R16", "R10", "R2", "R1", "R3"]) await set2("route:" + rid + ":base", { stores: [] });
    const req2 = tok => ({ url: "https://app.local/api/routes", headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tok : null) } });
    const rOrd = await routesMod.onRequestGet({ request: req2("tok1"), env: env2 });
    const jOrd = await rOrd.json();
    check("降序索引 → 输出按名称自然序升序（1,2,3,10,16,17）",
      JSON.stringify(jOrd.routes.map(r => r.name)) === JSON.stringify(["1号线", "2号线", "3号线", "10号线", "16号线", "17号线"]),
      JSON.stringify(jOrd.routes.map(r => r.name)));
    const rOrd2 = await dsb.onRequestGet({ request: { url: "https://app.local/api/dispatch-bootstrap", headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer tok1" : null) } }, env: env2 });
    const jOrd2 = await rOrd2.json();
    check("聚合出口与 /api/routes 同序", JSON.stringify(jOrd2.routes.map(r => r.name)) === JSON.stringify(jOrd.routes.map(r => r.name)));
  }

  console.log("\nBOOTSTRAP_AGGREGATE：通过 " + pass + " / 失败 " + fail);
  if (fail) process.exit(1);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
