// 1.1 可靠性护栏：管理端两处「全键空间 SCAN」的预算收口回归
// ------------------------------------------------------------------
// 背景：admin/users.js 的 cleanupUserSessions 曾 SCAN zp:session:* 全键空间（每次删用户都遍历全部会话）；
//      admin/manage.js 的 reset 曾 SCAN zp:waybill:* 等全量旧数据模式。两者都是 O(全键空间) 子请求，
//      大会话量 / 大运单量下会越过 Workers 每请求约 50 子请求上限 → 潜在 1101。
// 本用例把这两处统一收口到 _redis-budget.js（Budget + scanKeysBudgeted + iterCap），断言：
//   1. 仍正确删除目标数据（业务正确性第一，不因护栏而误漏）；
//   2. 子请求数受预算约束（≤ 45，远低于平台 ~50 上限），数据量放大也不退化成 N 倍。
// 运行：node tests/integration-admin-budget.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

// 每个 Redis REST 调用 = 1 次子请求
const BASE_BUDGET = 45;   // 平台 ~50，留余量
let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
const setkv = (k, obj) => red.command(["SET", "zp:" + k, JSON.stringify(obj)]);
const getkv = async k => { const r = await red.command(["GET", "zp:" + k]); if (!r) return null; try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } };

(async () => {
  const { Budget, scanKeysBudgeted, SUBREQUEST_LIMIT } = await import(baseDir + "_redis-budget.js");
  const usersMod = await import(baseDir + "admin/users.js");
  const manageMod = await import(baseDir + "admin/manage.js");
  const { hash } = await import(baseDir + "login.js");

  // ============ 【1】admin/manage reset：旧数据模式清理 + 预算受控（先于会话段，键空间干净）============
  console.log("【1】admin manage reset：清理旧运单/历史等全键模式，子请求在预算内");
  const pwHash = await hash("secret123");
  await setkv("user:admin1", { id: "admin1", role: "admin", username: "admin1", passwordHash: pwHash, sessionVersion: 1 });
  await setkv("session:aTok", { userId: "admin1", sessionVersion: 1 });
  await setkv("waybill:W1", { id: "W1", routeId: "R", date: "2026-01-01" });
  await setkv("route:R:waybills:2026-01-01", "W1");
  await setkv("route:R:orders:today", "x");
  await setkv("route:R:orders:latest", "x");
  await setkv("route:R:history:2026-01-01", "x");
  await setkv("history:H1", "x");
  await setkv("user:keep", { id: "keep" });                 // 不应被清
  await setkv("route:R", { id: "R", name: "R", status: "active" }); // 不应被清

  const req = (body) => ({
    url: "https://app.local/api/admin/manage",
    headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer aTok" : null) },
    json: async () => body
  });
  subrequests = 0;
  const res = await manageMod.onRequestPost({ request: req({ action: "reset", password: "secret123" }), env });
  const j = await res.json();
  check("reset 返回 success", j.success === true, "HTTP " + res.status + " detail=" + (j.detail || ""));
  check("旧 waybill 已清", (await getkv("waybill:W1")) === null);
  check("旧 route 日期桶已清", (await getkv("route:R:waybills:2026-01-01")) === null);
  check("旧 orders:today 已清", (await getkv("route:R:orders:today")) === null);
  check("旧 history 已清", (await getkv("history:H1")) === null);
  check("非旧模式键不被误删（user:keep）", (await getkv("user:keep")) !== null);
  check("非旧模式键不被误删（route:R）", (await getkv("route:R")) !== null);
  check("reset 子请求 ≤ " + BASE_BUDGET, subrequests <= BASE_BUDGET, "subrequests=" + subrequests);

  // ============ 【2】cleanupUserSessions：正确性 + 预算受控 ============
  console.log("【2】cleanupUserSessions：删用户时仅清该用户会话，且子请求在预算内");

  // 中量：uA 600 + uB 600 会话
  for (let i = 0; i < 600; i++) { await setkv("session:sA" + i, { userId: "uA", sessionVersion: 1 }); }
  for (let i = 0; i < 600; i++) { await setkv("session:sB" + i, { userId: "uB", sessionVersion: 1 }); }
  subrequests = 0;
  const delA = await usersMod.cleanupUserSessions(env, "uA");
  check("删除数等于 uA 会话数 (600)", delA === 600, "deleted=" + delA);
  let aLeft = 0, bLeft = 0;
  for (let i = 0; i < 600; i++) { if (await getkv("session:sA" + i)) aLeft++; if (await getkv("session:sB" + i)) bLeft++; }
  check("uA 会话全部清除", aLeft === 0, "remaining=" + aLeft);
  check("uB 会话未被误删", bLeft === 600, "remaining=" + bLeft);
  check("子请求 ≤ " + BASE_BUDGET, subrequests <= BASE_BUDGET, "subrequests=" + subrequests);

  // 海量：8000 会话，验证护栏生效（不退化成 N 倍子请求、不抛错）
  for (let i = 0; i < 4000; i++) { await setkv("session:hA" + i, { userId: "uH", sessionVersion: 1 }); }
  subrequests = 0;
  let threw = false;
  try { await usersMod.cleanupUserSessions(env, "uH"); } catch (e) { threw = true; }
  check("海量会话下不抛错（护栏截断而非 1101）", !threw);
  check("海量会话下子请求仍 ≤ " + BASE_BUDGET + "（护栏生效）", subrequests <= BASE_BUDGET, "subrequests=" + subrequests);

  console.log("\nADMIN_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
