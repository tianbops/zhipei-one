// 会话滑动续期集成测试（2026-10-28）
// ------------------------------------------------------------------
// 验证「国民级」会话策略：长会话（90 天）+ 滑动续期 + 改密全设备登出。
// 用 _mini-redis 真实加载 me.js / home-bootstrap.js / _redis.js，断言：
//   (1) SESSION_TTL_SECONDS 恒为 90 天（7776000）；
//   (2) 心跳接口（/api/me、/api/home-bootstrap）成功时把服务端 TTL 续到 90 天，
//       并回写刷新后的会话 Cookie（Max-Age=7776000）——不刷 Cookie 则客户端仍按
//       首次 7 天倒计时，服务端续期形同虚设；
//   (3) 无效/缺失会话不续期、不回写 Cookie、返回 401；
//   (4) 改密（sessionVersion 自增）后旧会话 /api/me 返回 401（回归保护已有逻辑，不退化）。
// 运行：node tests/integration-session-sliding.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const apiDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const redisMod = await import(apiDir + "_redis.js");
  const meMod = await import(apiDir + "me.js");
  const bootMod = await import(apiDir + "home-bootstrap.js");

  const U = "uSlide", TOK = "tok-slide";
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const sessionKey = "zp:session:" + TOK;

  await red.command(["SET", "zp:user:" + U, JSON.stringify({
    id: U, username: "u", role: "user", boundRouteId: "r1", dispatchRouteId: "r1", routeDuty: "delivery", sessionVersion: 1
  })]);
  // 模拟「即将过期」的会话（TTL 100s），验证续期后会变成 90 天
  await red.command(["SET", sessionKey, JSON.stringify({ userId: U, sessionVersion: 1, createdAt: new Date().toISOString() }), "EX", "100"]);

  function cookieReq(token) {
    return { method: "GET", url: "https://x/api/me", headers: { get: (h) => String(h).toLowerCase() === "cookie" ? "zp_session=" + (token || "") : null } };
  }
  const TTL_90 = redisMod.SESSION_TTL_SECONDS;

  // (1) 常量值
  check("SESSION_TTL_SECONDS = 90 天 (7776000)", TTL_90 === 7776000, "实际 " + TTL_90);

  // (2) 续期前 TTL 为短值
  const ttlBefore = await red.command(["TTL", sessionKey]);
  check("续期前服务端 TTL 为短值 (≈100s)", ttlBefore > 0 && ttlBefore <= 100, "TTL=" + ttlBefore);

  // (3) /api/me 成功 → 刷新 Cookie + 续期
  const originalFetch = global.fetch;
  const refreshCommands = [];
  global.fetch = async (url, init) => {
    try { if (init?.body) refreshCommands.push(JSON.parse(init.body)); } catch {}
    return originalFetch(url, init);
  };
  const meRes = await meMod.onRequestGet({ request: cookieReq(TOK), env });
  global.fetch = originalFetch;
  const meData = await meRes.json();
  check("/api/me 返回 success:true", meData.success === true, JSON.stringify(meData).slice(0, 80));
  const meCookie = meRes.headers.get("set-cookie") || "";
  check("/api/me 响应刷新 Cookie Max-Age=7776000", meCookie.includes("Max-Age=7776000"), meCookie.slice(0, 60));
  check("滑动续期仅发出一次 EXPIRE（不再 GET 后 SETEX 两次往返）", refreshCommands.filter(c => Array.isArray(c) && c[0] === "EXPIRE" && c[1] === sessionKey).length === 1 && !refreshCommands.some(c => Array.isArray(c) && c[0] === "SET" && c[1] === sessionKey), JSON.stringify(refreshCommands.map(c => c[0])));
  const ttlAfterMe = await red.command(["TTL", sessionKey]);
  check("/api/me 后服务端 TTL 续到 90 天", ttlAfterMe >= TTL_90 - 5, "TTL=" + ttlAfterMe);

  // (4) 无效会话（错 token）：不续期、不回写 Cookie、401
  const badRes = await meMod.onRequestGet({ request: cookieReq("wrong-tok"), env });
  check("错 token → 401", badRes.status === 401, "status=" + badRes.status);
  check("错 token 不回写 set-cookie", !(badRes.headers.get("set-cookie") || "").includes("zp_session="));

  // (5) 缺失会话（无 cookie）：401、无 Cookie
  const noRes = await meMod.onRequestGet({ request: cookieReq(""), env });
  check("无 cookie → 401", noRes.status === 401, "status=" + noRes.status);
  check("无 cookie 不回写 set-cookie", !(noRes.headers.get("set-cookie") || "").includes("zp_session="));

  // (6) /api/home-bootstrap 成功 → 同样刷新 Cookie + 续期（乐观直达跳过 /api/me 时的关键路径）
  const bdRes = await bootMod.onRequestGet({ request: cookieReq(TOK), env });
  const bdData = await bdRes.json();
  check("/api/home-bootstrap 返回 success:true", bdData.success === true, JSON.stringify(bdData).slice(0, 80));
  const bdCookie = bdRes.headers.get("set-cookie") || "";
  check("/api/home-bootstrap 响应刷新 Cookie Max-Age=7776000", bdCookie.includes("Max-Age=7776000"));
  const ttlAfterBoot = await red.command(["TTL", sessionKey]);
  check("/api/home-bootstrap 后服务端 TTL 仍 90 天", ttlAfterBoot >= TTL_90 - 5, "TTL=" + ttlAfterBoot);

  // (7) 改密后旧会话失效（sessionVersion 不一致）→ 401（回归保护）
  const U2 = "uSlide2", TOK2 = "tok-slide2";
  await red.command(["SET", "zp:user:" + U2, JSON.stringify({
    id: U2, username: "u2", role: "user", boundRouteId: "r1", dispatchRouteId: "r1", routeDuty: "delivery", sessionVersion: 2
  })]); // 改密后 version 自增到 2
  await red.command(["SET", "zp:session:" + TOK2, JSON.stringify({ userId: U2, sessionVersion: 1, createdAt: new Date().toISOString() }), "EX", "100"]); // 旧会话仍 1
  const mvRes = await meMod.onRequestGet({ request: cookieReq(TOK2), env });
  check("改密后旧会话 /api/me → 401", mvRes.status === 401, "status=" + mvRes.status);

  console.log("\n会话滑动续期测试：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
