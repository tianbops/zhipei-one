// 1.1 可靠性：API 「永不向外抛异常」回归（Error 1101 → 结构化 JSON）
// ------------------------------------------------------------------
// 背景（2026-10-07 生产事故）：一致性巡检路径撞上 Workers 子请求上限后被平台掐断，
// 由于这条路径没有兜底，异常一路冒到 Cloudflare，用户看到的是
// 「Error 1101 · Worker threw exception」HTML 页和一个 Ray ID：
//   - 前端 fetch().then(r=>r.json()) 直接崩，连错误提示都显示不出来；
//   - 运维拿到的线索只有 Ray ID，无法分类是数据服务抖动还是代码缺陷。
// 本用例断言：无论底层怎么炸（Redis 不可达 / 抛异常 / 返回脏数据），
// 被 guard() 包装的 handler 都必须返回**结构化 JSON**，且不向上抛。
// 运行：node tests/integration-error-guard.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const { pathToFileURL } = require("url");
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;

  const uid = "uGuard", tok = "tok-Guard", route = "RGuard";
  red.command(["SET", "zp:user:" + uid, JSON.stringify({ id: uid, role: "user", boundRouteId: route, dispatchRouteId: route, routeDuty: "driver", sessionVersion: 1 })]);
  red.command(["SET", "zp:admin:" + "uAdm", JSON.stringify({ id: "uAdm", role: "root", sessionVersion: 1 })]);
  red.command(["SET", "zp:session:" + tok, JSON.stringify({ userId: uid, sessionVersion: 1 })]);
  red.command(["SET", "zp:session:tokAdm", JSON.stringify({ userId: "uAdm", sessionVersion: 1 })]);
  red.command(["SET", "zp:routes:index", JSON.stringify([route])]);
  red.command(["SET", "zp:route:" + route, JSON.stringify({ id: route, name: "护栏线路", status: "active" })]);

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const routesMod = await import(baseDir + "routes.js");
  const req = (url, t) => ({ url, headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + t : null) } });

  // ---- 正常连通时的基线：确认 handler 本身是好的（后面的失败断言才有意义） ----
  const okBase = await diagMod.onRequestGet({ request: req("https://app.local/api/waybills/diagnostic?routeId=" + route, tok), env });
  const baseJson = await okBase.json();
  check("基线：鉴权通过后诊断列表返回成功", okBase.status === 200 && baseJson.success === true, "HTTP " + okBase.status);

  // ---- 让底层 Redis 彻底不可达：原本会变成 Cloudflare Error 1101 的场景 ----
  const goodFetch = global.fetch;
  global.fetch = async () => { throw new Error("REDIS_ERROR:upstream unreachable (simulated)"); };

  console.log("【1】数据服务不可达：诊断列表必须返回结构化 JSON，不得抛出");
  let threw = null, r1 = null;
  try { r1 = await diagMod.onRequestGet({ request: req("https://app.local/api/waybills/diagnostic?routeId=" + route, tok), env }); }
  catch (e) { threw = e; }
  const j1 = r1 ? await r1.json() : null;
  check("handler 未向外抛异常", threw === null, threw ? String(threw.message) : "");
  check("返回体是合法 JSON 且 success=false", !!j1 && j1.success === false);
  check("带可分诊的 code", !!j1 && j1.code === "WAYBILL_DIAGNOSTIC_FAILED", "code=" + (j1 && j1.code));
  check("语种为用户可读文案（无内部异常裸奔）", !!j1 && typeof j1.error === "string" && j1.error.length > 0 && !/upstream unreachable/.test(j1.error), j1 && j1.error);
  check("状态码为 503（数据服务类失败）", r1 && r1.status === 503, "HTTP " + (r1 && r1.status));

  console.log("【2】一致性巡检路径（本次 1101 的直接受害者）同样不再冒到 Cloudflare");
  let threw2 = null, r2 = null;
  try { r2 = await diagMod.onRequestGet({ request: req("https://app.local/api/waybills/diagnostic?check=consistency&routeId=" + route, "tokAdm"), env }); }
  catch (e) { threw2 = e; }
  const j2 = r2 ? await r2.json() : null;
  check("handler 未向外抛异常", threw2 === null, threw2 ? String(threw2.message) : "");
  check("返回结构化 JSON 且带 code", !!j2 && j2.success === false && !!j2.code, j2 && JSON.stringify(j2).slice(0, 120));

  console.log("【3】一致性修复（写路径）同样有兜底");
  let threw3 = null, r3 = null;
  try { r3 = await diagMod.onRequestPost({ request: { url: "https://app.local/api/waybills/diagnostic?action=repair-consistency", headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer tokAdm" : null) } }, env }); }
  catch (e) { threw3 = e; }
  const j3 = r3 ? await r3.json() : null;
  check("handler 未向外抛异常", threw3 === null, threw3 ? String(threw3.message) : "");
  check("返回结构化 JSON 且带 code", !!j3 && j3.success === false && !!j3.code, j3 && JSON.stringify(j3).slice(0, 120));

  console.log("【4】线路接口（管理台首屏依赖）兜底不受影响");
  let threw4 = null, r4 = null;
  try { r4 = await routesMod.onRequestGet({ request: req("https://app.local/api/routes", tok), env }); }
  catch (e) { threw4 = e; }
  const j4 = r4 ? await r4.json() : null;
  check("handler 未向外抛异常", threw4 === null, threw4 ? String(threw4.message) : "");
  check("返回结构化 JSON 且 code=ROUTES_READ_FAILED", !!j4 && j4.code === "ROUTES_READ_FAILED", j4 && j4.code);

  global.fetch = goodFetch;
  console.log("\nERROR_GUARD 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
