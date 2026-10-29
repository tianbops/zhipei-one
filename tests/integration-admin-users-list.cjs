// 管理员不出现在「用户管理」列表 —— 回归测试
// ------------------------------------------------------------------
// 背景：GET /api/admin/users 原样返回 users:index 全量账号，系统管理员
//（tianbo 等）也出现在「用户」列表里，且「用户」计数虚高。而后端本就
// 不允许经此接口修改系统管理员（POST 有 isSystemAdmin 拦截）——列出
// 管理员纯属噪音。修复：列表过滤 isSystemAdmin 账号（数据校验保留，
// 缺失/损坏仍报 USER_DATA_INVALID）。
// 运行：node tests/integration-admin-users-list.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
const setkv = (k, obj) => red.command(["SET", "zp:" + k, JSON.stringify(obj)]);

(async () => {
  const usersMod = await import(baseDir + "admin/users.js");

  // 数据：管理员 admin1 + 两个普通用户（uA 绑定线路，uB 未绑定）
  await setkv("users:index", ["admin1", "uA", "uB"]);
  await setkv("user:admin1", { id: "admin1", username: "tianbo", role: "admin", disabled: false });
  await setkv("user:uA", { id: "uA", username: "tian860", role: "user", disabled: false, boundRouteId: "R", routeDuty: "driver" });
  await setkv("user:uB", { id: "uB", username: "cs1234", role: "user", disabled: false });
  await setkv("route:R", { id: "R", name: "17号线", status: "active", driverUserId: "uA" });
  await setkv("session:aTok", { userId: "admin1", sessionVersion: 1 });
  await setkv("session:uTok", { userId: "uA", sessionVersion: 1 });

  const req = (tok) => ({
    url: "https://app.local/api/admin/users",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tok : null) }
  });

  // 【1】管理员视角：列表不含管理员，普通用户齐全，线路名正常解析
  console.log("【1】GET /api/admin/users：管理员不出现在列表");
  const res = await usersMod.onRequestGet({ request: req("aTok"), env });
  const j = await res.json();
  check("返回 success", j.success === true, "HTTP " + res.status);
  check("列表不含系统管理员 tianbo/admin1", Array.isArray(j.users) && !j.users.some(u => u.id === "admin1" || u.role === "admin"),
    "ids=" + (j.users || []).map(u => u.id).join(","));
  check("普通用户齐全（uA/uB）", j.users?.length === 2 && j.users.some(u => u.id === "uA") && j.users.some(u => u.id === "uB"));
  check("绑定线路名正常解析", j.users?.find(u => u.id === "uA")?.routeName === "17号线");

  // 【2】非管理员仍 403（权限边界不因过滤松动）
  console.log("【2】普通用户访问仍 403");
  const res2 = await usersMod.onRequestGet({ request: req("uTok"), env });
  check("非管理员 403", res2.status === 403);

  // 【3】数据校验保留：索引指向缺失用户仍报 USER_DATA_INVALID（过滤不吞坏数据）
  console.log("【3】坏数据守卫不因过滤失效");
  await setkv("users:index", ["admin1", "uA", "ghost"]);
  const res3 = await usersMod.onRequestGet({ request: req("aTok"), env });
  const j3 = await res3.json();
  check("缺失用户仍报 USER_DATA_INVALID 409", res3.status === 409 && j3.code === "USER_DATA_INVALID", "code=" + j3.code);

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
