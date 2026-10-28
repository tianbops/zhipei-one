// 别名管理集成测试（2026-10-28）
// ------------------------------------------------------------------
// 用户反馈：数据资料页「编辑门店」弹窗原本不暴露别名，学习机制自动写入的别名
// （含 OCR 垃圾文本）无法在 UI 删除。本次在前端 data.html 编辑弹窗新增了别名
// 增删 UI；本测试用 _mini-redis 真实加载 base.js，断言后端持久化路径正确：
//   (1) canMaintain 用户经 PUT 删除某门店的垃圾别名 → 持久化成功，其余别名/门店不受影响；
//   (2) 经 GET 复核垃圾别名确实不在库、正常别名仍在；
//   (3) 可经 PUT 新增别名并持久化；
//   (4) 清空某门店全部别名不会触发 STORE_IDENTITY_CONFLICT；
//   (5) 仅 dispatch、无维护权限的用户 PUT 被 403 拒绝（权限边界不退化）。
// 运行：node tests/integration-base-alias-manage.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
function req(method, url, token, payload) {
  return {
    method, url,
    headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) },
    json: async () => payload,
  };
}
const setJson = (fullKey, obj) => red.command(["SET", fullKey, JSON.stringify(obj)]);

(async () => {
  const ROUTE = "route-test-alias";
  const U = "uAlias";
  const TOK = "tok-alias";
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // canMaintain 用户：绑定线路 + delivery 岗位
  setJson("zp:user:" + U, { id: U, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  setJson("zp:session:" + TOK, { userId: U, sessionVersion: 1 });
  setJson("zp:route:" + ROUTE, { id: ROUTE, name: "测试线", status: "active" });

  const GARBAGE = "渝北中景隆（重庆）贸易有限\n04:20 NOGA 5G 45 < × 运单列表 重庆市药品监督管理局检查一局";
  setJson("zp:route:" + ROUTE + ":base", { routeId: ROUTE, version: 1, stores: [
    { storeId: "S1", name: "门店一", originalName: "门店一", aliases: [GARBAGE, "别名A"], navigation: null, routeOrder: 1, note: "" },
    { storeId: "S2", name: "门店二", originalName: "门店二", aliases: [], navigation: null, routeOrder: 2, note: "" },
  ] });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const baseMod = await import(baseDir + "base.js");
  const url = "https://app.test/api/base?routeId=" + ROUTE;

  async function currentVersion(token) {
    const g = await baseMod.onRequestGet({ request: req("GET", url, token), env });
    const d = await g.json();
    return d.base ? d.base.version : null;
  }
  async function putStores(stores, token) {
    const v = await currentVersion(token);
    return baseMod.onRequestPut({ request: req("PUT", url, token, { routeId: ROUTE, expectedVersion: v, stores }), env });
  }
  const findStore = (base, id) => ((base && base.stores) || []).find(s => s.storeId === id);

  // (1) 删除 S1 的垃圾别名，保留“别名A”
  const put1 = await putStores([
    { storeId: "S1", name: "门店一", originalName: "门店一", aliases: ["别名A"], navigation: null, routeOrder: 1, note: "" },
    { storeId: "S2", name: "门店二", originalName: "门店二", aliases: [], navigation: null, routeOrder: 2, note: "" },
  ], TOK);
  const d1 = await put1.json();
  check("PUT 删除垃圾别名 → success", d1.success === true, JSON.stringify(d1).slice(0, 120));
  const s1 = findStore(d1.base, "S1");
  check("S1 垃圾别名已移除", s1 && !s1.aliases.includes(GARBAGE), s1 ? "aliases=" + JSON.stringify(s1.aliases) : "S1 缺失");
  check("S1 正常别名“别名A”保留", !!(s1 && s1.aliases.includes("别名A")));
  check("S2 不受影响且门店数=2", findStore(d1.base, "S2") && (d1.base.stores || []).length === 2);

  // (2) GET 复核持久化
  const g1 = await (await baseMod.onRequestGet({ request: req("GET", url, TOK), env })).json();
  const gs1 = findStore(g1.base, "S1");
  check("GET 复核：垃圾别名确实不在库", !(gs1 && gs1.aliases.includes(GARBAGE)));
  check("GET 复核：别名A 仍在库", !!(gs1 && gs1.aliases.includes("别名A")));

  // (3) 新增别名“新别名B”
  const put2 = await putStores([
    { storeId: "S1", name: "门店一", originalName: "门店一", aliases: ["别名A", "新别名B"], navigation: null, routeOrder: 1, note: "" },
    { storeId: "S2", name: "门店二", originalName: "门店二", aliases: [], navigation: null, routeOrder: 2, note: "" },
  ], TOK);
  const d2 = await put2.json();
  const s1b = findStore(d2.base, "S1");
  check("PUT 新增别名“新别名B” → 持久化", !!(s1b && s1b.aliases.includes("新别名B") && s1b.aliases.includes("别名A")));

  // (4) 清空 S1 全部别名不应触发身份冲突
  const put3 = await putStores([
    { storeId: "S1", name: "门店一", originalName: "门店一", aliases: [], navigation: null, routeOrder: 1, note: "" },
    { storeId: "S2", name: "门店二", originalName: "门店二", aliases: [], navigation: null, routeOrder: 2, note: "" },
  ], TOK);
  const d3 = await put3.json();
  check("清空别名无冲突且成功", d3.success === true, d3.error || "");

  // (5) 仅 dispatch、无维护权限用户 PUT 应被拒
  const U2 = "uDispatchOnly";
  const TOK2 = "tok-dispatch";
  setJson("zp:user:" + U2, { id: U2, role: "user", boundRouteId: "other-route", dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  setJson("zp:session:" + TOK2, { userId: U2, sessionVersion: 1 });
  const put4 = await putStores([
    { storeId: "S1", name: "门店一", originalName: "门店一", aliases: [], navigation: null, routeOrder: 1, note: "" },
    { storeId: "S2", name: "门店二", originalName: "门店二", aliases: [], navigation: null, routeOrder: 2, note: "" },
  ], TOK2);
  const d4 = await put4.json();
  check("仅 dispatch 用户 PUT 被 403 拒绝（权限边界不退化）", put4.status === 403 && d4.success === false, "status=" + put4.status);

  console.log("\n" + (fail ? "❌" : "✅") + " 别名管理集成测试：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试异常：", e); process.exit(1); });
