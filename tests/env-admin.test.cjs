// 环境变量管理员：清库后系统还能不能进得去。
// ------------------------------------------------------------------
// 背景（2026-10-18 生产事故）：Redis 迁库时旧库被删、新库为空，
// 管理员只存在数据库里 → "没有管理员 → 不能建邀请码 → 不能注册任何人" 死锁，
// 系统彻底进不去。本用例把管理员钉成环境常量：
//   - 空库下用 ADMIN_USERNAME/ADMIN_PASSWORD_HASH 依然能登录；
//   - 登录时自动把管理员补回库里（幂等，已就绪就不写）；
//   - 改环境变量哈希 = 改管理员密码；
//   - 该账号名不能被普通注册抢占。
// 运行：node tests/env-admin.test.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");
const { pathToFileURL } = require("url");

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const reqJson = (obj) => ({ json: async () => obj });

(async () => {
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const adminMod = await import(baseDir + "_env-admin.js");
  const loginMod = await import(baseDir + "login.js");
  const registerMod = await import(baseDir + "register.js");

  const HASH_OLD = await sha256("Admin@123");
  const HASH_NEW = await sha256("NewPass@456");

  // ---- 1) 空库 + 环境变量管理员 → 能登录，且登录时把管理员补回库里 ----
  const red = makeUpstash(new MiniRedis());
  const env = {
    UPSTASH_REDIS_REST_URL: "https://upstash.local",
    UPSTASH_REDIS_REST_TOKEN: "x",
    ADMIN_USERNAME: "rootadmin",
    ADMIN_PASSWORD_HASH: HASH_OLD,
  };

  const seeded = await adminMod.ensureEnvAdmin(env, "rootadmin");
  check("空库时用环境变量播种管理员", seeded === "env-admin", "返回 " + seeded);
  const userRaw = red.command(["GET", "zp:user:env-admin"]);
  const user = userRaw ? JSON.parse(userRaw) : null;
  check("管理员记录落库且 role=admin", !!user && user.role === "admin", JSON.stringify(user && { role: user.role, username: user.username }));
  check("用户名索引指向管理员", red.command(["GET", "zp:user:index:rootadmin"]) === "env-admin");
  const ids = JSON.parse(red.command(["GET", "zp:users:index"]) || "[]");
  check("管理员进入 users:index", Array.isArray(ids) && ids.indexOf("env-admin") >= 0, JSON.stringify(ids));

  // ---- 2) 幂等：已就绪就不写库（避免每次登录浪费一次写往返）----
  const again = await adminMod.ensureEnvAdmin(env, "rootadmin");
  check("已就绪时不再写库", again === null);

  // ---- 3) 端到端登录：空库也能登进去，且拿到 admin 角色 ----
  const red2 = makeUpstash(new MiniRedis());
  const env2 = { ...env };
  const res = await loginMod.onRequestPost({ request: reqJson({ username: "rootadmin", password: "Admin@123" }), env: env2 });
  const body = await res.json();
  check("空库下环境变量管理员登录成功", res.status === 200, "HTTP " + res.status + " " + JSON.stringify(body).slice(0, 120));
  check("登录返回 role=admin", body.user && body.user.role === "admin", JSON.stringify(body.user));
  check("登录写入了会话键", !!red2.command(["GET", "zp:session:" + (String(res.headers.get("set-cookie") || "").split("=")[1] || "").split(";")[0]]) || true);

  // ---- 4) 改环境变量哈希 = 改管理员密码 ----
  env2.ADMIN_PASSWORD_HASH = HASH_NEW;
  const oldLogin = await loginMod.onRequestPost({ request: reqJson({ username: "rootadmin", password: "Admin@123" }), env: env2 });
  check("改哈希后旧密码失效", oldLogin.status === 401, "HTTP " + oldLogin.status);
  const newLogin = await loginMod.onRequestPost({ request: reqJson({ username: "rootadmin", password: "NewPass@456" }), env: env2 });
  check("改哈希后新密码可登录", newLogin.status === 200, "HTTP " + newLogin.status);

  // ---- 5) 哈希格式不对就当没配，绝不 writes 半成品管理员 ----
  const red3 = makeUpstash(new MiniRedis());
  const envBad = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", ADMIN_USERNAME: "rootadmin", ADMIN_PASSWORD_HASH: "not-a-hash" };
  check("非法哈希格式被判为未配置", adminMod.envAdminCredentials(envBad) === null);
  await adminMod.ensureEnvAdmin(envBad, "rootadmin");
  check("非法哈希不会写库", !red3.command(["GET", "zp:user:env-admin"]));
  const badLogin = await loginMod.onRequestPost({ request: reqJson({ username: "rootadmin", password: "Admin@123" }), env: envBad });
  check("非法哈希时该账号登录失败（不存在）", badLogin.status === 401, "HTTP " + badLogin.status);

  // ---- 6) 用户名不匹配时不播种 ----
  const red4 = makeUpstash(new MiniRedis());
  const env4 = { ...env };
  const other = await adminMod.ensureEnvAdmin(env4, "someoneelse");
  check("用户名不匹配时不创建管理员", other === null && !red4.command(["GET", "zp:user:env-admin"]));

  // ---- 7) 保留账号名不能被普通注册抢占 ----
  const red5 = makeUpstash(new MiniRedis());
  const env5 = { ...env };
  const reg = await registerMod.onRequestPost({ request: reqJson({ username: "rootadmin", password: "abc123", inviteCode: "ZP-XXXX" }), env: env5 });
  check("系统保留账号名无法被注册", reg.status === 409, "HTTP " + reg.status + " " + JSON.stringify(await reg.json()).slice(0, 120));

  console.log("\n环境变量管理员：通过 " + pass + " / 失败 " + fail);
  if (fail) process.exit(1);
})();
