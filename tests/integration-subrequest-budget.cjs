// 1.1 可靠性护栏：Cloudflare Workers 每请求**子请求预算**回归
// ------------------------------------------------------------------
// 背景（2026-10-06 生产事故）：诊断列表曾是全键 SCAN + 逐张 GET + 逐张 LRANGE，
// 子请求数 O(N)。生产数据量下直接突破 Workers 免费版每请求约 50 个子请求上限 → 裸 500。
// 而本地单元/集成测试全绿，根本发现不了——因为测试不度量资源消耗。
//
// 本用例在 MiniRedis 上**统计一次请求产生的 Redis REST 调用次数**，断言：
//   1. 单次列表查询的子请求数远低于平台上限（预算内）；
//   2. 运单量翻倍时子请求数**不随之增长**（即 O(1)，而非旧的 O(N)）。
// 这样就把「资源边界」这类只在生产暴露的缺陷，钉死在 CI 里。
// 运行：node tests/integration-subrequest-budget.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

// makeUpstash 已接管 global.fetch；再包一层计数，每个 fetch = 1 次子请求
const BASE_BUDGET = 20;   // Workers 免费版约 50，留足余量
let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const R = "route-budget";
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const dates = ["2026-09-21", "2026-09-22", "2026-09-23"];

function seedWaybills(from, to) {
  for (let i = from; i <= to; i++) {
    const date = dates[i % dates.length];
    const id = "W" + i;
    seed("waybill:" + id, {
      schemaVersion: "2", id, routeId: R, routeName: "预算线路", date,
      vehicle: "粤B" + String(i).padStart(4, "0"), totalWeight: 0.1, stores: [],
      summary: { original: 0, total: 0, matched: 0, pending: 0, correction: 0, merged: 0, newStores: 0 },
      stage: "CONFIRMED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
      createdBy: "uB", createdAt: date + "T08:00:00.000Z",
      quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null }
    });
    red.command(["SADD", "zp:route:" + R + ":waybills:" + date, id]);
    red.command(["RPUSH", "zp:waybill:" + id + ":events", JSON.stringify({ t: date + "T08:00:00.000Z", event: "WAYBILL_CREATED" })]);
  }
}

(async () => {
  const uId = "uB", tok = "tok-Budget";
  seed("user:" + uId, { id: uId, role: "user", boundRouteId: R, dispatchRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tok, { userId: uId, sessionVersion: 1 });
  seed("route:" + R, { id: R, name: "预算线路", status: "active" });

  const N1 = 60;
  seedWaybills(1, N1);

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };
  const req = url => ({ url, headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + tok : null) } });
  const call = async () => {
    subrequests = 0;
    const r = await diagMod.onRequestGet({ request: req("https://app.local/api/waybills/diagnostic?routeId=" + R), env });
    return { json: await r.json(), status: r.status, sub: subrequests };
  };

  console.log("【1】" + N1 + " 张运单：结果正确且子请求在预算内");
  const a = await call();
  check("查询成功", a.json.success === true, "HTTP " + a.status);
  check("count 为真实总数 " + N1, a.json.count === N1, "count=" + a.json.count);
  check("仅返回前 20 张", Array.isArray(a.json.waybills) && a.json.waybills.length === 20);
  check("子请求数 ≤ " + BASE_BUDGET + "（远低于 Workers 约 50 上限）", a.sub <= BASE_BUDGET, "subrequests=" + a.sub);

  console.log("【2】运单量翻倍到 " + (N1 * 2) + " 张：子请求数不得随之增长（O(1) 而非 O(N)）");
  seedWaybills(N1 + 1, N1 * 2);
  const b = await call();
  check("查询仍成功", b.json.success === true, "HTTP " + b.status);
  check("count 为真实总数 " + (N1 * 2), b.json.count === N1 * 2, "count=" + b.json.count);
  check("子请求数仍在预算内", b.sub <= BASE_BUDGET, "subrequests=" + b.sub);
  check("增量 ≤ 2（旧的逐张模式增量约 " + (N1 * 2) + "）", Math.abs(b.sub - a.sub) <= 2, `${a.sub} → ${b.sub}`);
  check("200% 数据量下未退化到 N 倍子请求", b.sub < N1, "sub=" + b.sub + " vs N=" + (N1 * 2));

  console.log("\nSUBREQUEST_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
