/**
 * 北京时间事件链回归测试。
 * 验证新事件同时保存 UTC / +08:00、旧事件可读，以及诊断页面展示和复制共用同一格式化函数。
 */
const fs = require("fs");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let pass = 0, fail = 0;
function check(name, ok, info) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (info ? " " + info : "")); }
}

(async () => {
  const redis = new MiniRedis();
  makeUpstash(redis);
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const { appendWaybillEvent, listWaybillEvents } = await import("../functions/api/waybills/_waybill-events.js");
  const { beijingISO } = await import("../functions/api/_time.js");

  const id = "time-event-regression";
  await appendWaybillEvent(env, id, { event: "WAYBILL_SAVED", requestId: "req-time-1" });
  const [created] = await listWaybillEvents(env, id);
  const utcMs = Date.parse(created?.t || "");
  const bjMs = Date.parse(created?.tBeijing || "");
  check("新事件同时保存 UTC t 和北京时间 tBeijing", !!created?.t && !!created?.tBeijing);
  check("tBeijing 带明确 +08:00 时区", /\+08:00$/.test(created?.tBeijing || ""));
  check("UTC 与北京时间代表同一时刻", Number.isFinite(utcMs) && utcMs === bjMs);
  check("北京时间墙钟相对 UTC 正好 +8 小时", Number.isFinite(utcMs) && created.tBeijing.slice(11, 19) === new Date(utcMs + 8 * 3600000).toISOString().slice(11, 19));
  check("beijingISO 可将 UTC 时间显式转换为 +08:00", beijingISO("2026-10-31T15:08:30.000Z") === "2026-10-31T23:08:30.000+08:00");

  // 模拟历史 Redis 事件：旧数据只有 t，不进行写回或迁移。
  await redis.command(["RPUSH", "zp:waybill:" + id + ":events", JSON.stringify({ event: "WAYBILL_CREATED", t: "2026-10-31T15:08:28.000Z" })]);
  const events = await listWaybillEvents(env, id);
  const legacy = events[1];
  check("旧事件仍可读取且不要求补写 tBeijing", legacy?.event === "WAYBILL_CREATED" && legacy?.t === "2026-10-31T15:08:28.000Z" && !legacy.tBeijing);

  const diagnosticSource = fs.readFileSync("functions/api/waybills/diagnostic.js", "utf8");
  const uiSource = fs.readFileSync("js/admin/diagnostics.js", "utf8");
  check("诊断接口将事件数组原样返回（不丢弃 tBeijing）", /events:eventsByKey\.get\(_key\)\|\|\[\]/.test(diagnosticSource));
  check("页面格式化优先读取 tBeijing，旧事件按 Asia/Shanghai 转换", /timeZone:"Asia\/Shanghai"/.test(uiSource) && /formatBeijingTime\(e\.t,e\.tBeijing\)/.test(uiSource));
  check("页面展示与复制均复用 eventText", /map\(e=>esc\(eventText\(e\)\)\)/.test(uiSource) && /map\(eventText\)/.test(uiSource));
  check("显示文本明确标注北京时间", /（北京时间）/.test(uiSource));

  console.log("北京时间事件链测试：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
