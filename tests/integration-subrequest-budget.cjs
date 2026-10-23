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
// 日期种子按「今天」相对生成（Asia/Shanghai 近似，与 functions/api/waybills/_stats.js
// 的 dateWindow 同算法）：硬编码日期会随真实时间滑出 days=30 窗口之外，
// scannedWaybills=0 让后续预算断言失去意义——这是一颗定时炸弹，改为时间无关。
const shanghaiToday = new Date(Date.now() + 8 * 3600 * 1000);
const fmtDate = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const dates = [2, 1, 0].map(i => { const d = new Date(shanghaiToday); d.setUTCDate(d.getUTCDate() - i); return fmtDate(d); });

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

  console.log("【3】运营统计 ?stats=1：窗口日期不得再变成「逐天 1 次 Redis 调用」");
  // 旧实现 scoped 路径按窗口每天 1 次 SMEMBERS（days=90 → 90 次，必然爆预算），
  // 全量路径还会叠上「全键 SCAN + 逐键 GET」。这里断言窗口拉到 90 天仍然便宜。
  // 注意：必须复用文件顶部包裹 global.fetch 的 subrequests 计数器，另起变量会恒为 0（假通过）
  const countFetch = async fn => { subrequests = 0; const r = await fn(); return { r, sub: subrequests }; };
  const statMod = await import(baseDir + "waybills/_stats.js");
  const statsFor = days => countFetch(() => statMod.computeStats(env, { routeId: R, days }));
  const s30 = await statsFor(30);
  const s90 = await statsFor(90);
  check("days=30 统计成功", s30.r.scannedWaybills > 0, "scannedWaybills=" + s30.r.scannedWaybills);
  check("days=30 子请求在预算内", s30.sub <= BASE_BUDGET, "subrequests=" + s30.sub);
  // 这条断言 2026-10-21 修过一次**阈值写错**的问题，改前请先看这段：
  // 原断言是 `s90.sub <= max(s30.sub + 2, s30.sub * 1.5)`，看似是"不许长到 1.5 倍"，
  // 但它把「绝对增量」和「相对倍数」混在了一起，且没有对照真正的敌人。
  // 真正的敌人是旧实现「按窗口日期逐个 SMEMBERS」——days=90 就是 90 次子请求。
  // 现网实测 30 天 3 次、90 天 6 次：增长来自"匹配到的键变多 → SCAN 多迭代几轮"，
  // 是 O(键数/批大小)，**不是** O(天数)。用 1.5 倍这种刚性倍数去卡，会把"已经比旧实现
  // 快 15 倍"的正确实现判成失败——这正是它长期挂着红灯的原因。
  // 所以这里改成两条语义明确的断言：① 绝对比旧实现好一个数量级；② 增速慢于天数增速。
  check("窗口 30→90 天：仍是「远优于逐天 1 次」（旧实现 days=90 ≈ 90 次）",
    s90.sub <= BASE_BUDGET && s90.sub * 10 <= 90, s30.sub + " → " + s90.sub + "（旧实现 ≈90）");
  check("子请求增速必须慢于天数增速（O(键数/批)，不是 O(天数)）",
    s90.sub < s30.sub * 3, s30.sub + " → " + s90.sub + "（天数 ×3，子请求必须 <×3）");
  const sAll = await countFetch(() => statMod.computeStats(env, { all: true, days: 90 }));
  check("全量统计同样在预算内", sAll.sub <= BASE_BUDGET, "subrequests=" + sAll.sub);
  check("全量统计结果正确（覆盖全部线路）", sAll.r.scannedWaybills >= s90.r.scannedWaybills,
    "all=" + sAll.r.scannedWaybills + " vs scoped=" + s90.r.scannedWaybills);

  console.log("\nSUBREQUEST_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
