// P1-2 集成回归（1.0 收口）：孤儿 PROCESSING 在运营统计中按 effectiveStage 重分类
// 验证「手机/PWA 被杀 → 服务器仍在 PROCESSING」的票据不会永远污染 diagnostic 统计为 PROCESSING，
// 而是按 updatedAt 阈值在视图上归为 STALLED(3–5min) / TIMEOUT(≥5min)。TTL(15min) 不变，仅视图重分类。
// 运行：node tests/integration-stats-stale.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
const R1 = "R1";

(async () => {
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const { computeStats } = await import("../functions/api/waybills/_stats.js");

  // 孤儿 PROCESSING（4min 前更新）→ 视图 STALLED
  red.command(["SET", "zp:waybill:proc:stale1", JSON.stringify({ stage: "PROCESSING", updatedAt: iso(4 * 60 * 1000), routeId: R1 })]);
  // 孤儿 PROCESSING（10min 前更新）→ 视图 TIMEOUT
  red.command(["SET", "zp:waybill:proc:timeout1", JSON.stringify({ stage: "PROCESSING", updatedAt: iso(10 * 60 * 1000), routeId: R1 })]);
  // 新鲜 PROCESSING（1min）→ 仍为 PROCESSING
  red.command(["SET", "zp:waybill:proc:fresh1", JSON.stringify({ stage: "PROCESSING", updatedAt: iso(1 * 60 * 1000), routeId: R1 })]);
  // 终态 DONE
  red.command(["SET", "zp:waybill:proc:done1", JSON.stringify({ stage: "DONE", updatedAt: iso(1 * 60 * 1000), routeId: R1 })]);
  // 另一条线路（不应计入 R1 统计）
  red.command(["SET", "zp:waybill:proc:other", JSON.stringify({ stage: "PROCESSING", updatedAt: iso(10 * 60 * 1000), routeId: "R2" })]);

  const stats = await computeStats(env, { routeId: R1, days: 30 });
  const bs = stats.processing.byStage;

  check("孤儿 PROCESSING(4min) 归 STALLED", bs.STALLED >= 1, "STALLED=" + bs.STALLED);
  check("孤儿 PROCESSING(10min) 归 TIMEOUT", bs.TIMEOUT >= 1, "TIMEOUT=" + bs.TIMEOUT);
  check("新鲜 PROCESSING(1min) 仍为 PROCESSING", bs.PROCESSING >= 1, "PROCESSING=" + bs.PROCESSING);
  check("终态 DONE 计入", bs.DONE >= 1, "DONE=" + bs.DONE);
  check("孤儿票据不污染 PROCESSING 计数（仅含 fresh1）", bs.PROCESSING === 1, "PROCESSING=" + bs.PROCESSING);
  check("本线孤儿/新鲜合计=3（不含 DONE/不含 R2）", bs.STALLED + bs.TIMEOUT + bs.PROCESSING === 3, "合计=" + (bs.STALLED + bs.TIMEOUT + bs.PROCESSING));
  check("其他线路 PROCESSING 不计入本线统计", bs.TIMEOUT === 1, "本线 TIMEOUT=" + bs.TIMEOUT);

  console.log("\nSTATS_STALE 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
