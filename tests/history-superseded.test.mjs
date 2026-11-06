/* 「被合并运单」列表与恢复 回归测试（2026-11-06）
   ------------------------------------------------------------------
   背景：同车同日两张单（22家/1.150887t 与 21家/1.070565t）被旧规则误判为重传，
   第 1 张被标 SUPERSEDED 并移出索引，界面上彻底消失。
   本测试锁住两条自救链路：
   1. 列表：只用 D1 主表粗筛，必须按线路过滤、跳过子键与非 SUPERSEDED；
   2. 恢复：清标记 → 加回索引 → 条件重建去重/指纹 → 重算当日汇总 → 留痕。
   同时锁住新的合并判定：一处不一致即不同运单（见 waybill-supersede.test.mjs）。
*/
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
const { listSuperseded, restoreSuperseded } = await import("../functions/api/history-trash.js");

const ROUTE = "route-r1";
const DATE = "2026-11-06";
const indexKey = "zp:route:" + ROUTE + ":waybills:" + DATE;

/* ---------- 假 D1：只实现 listSuperseded 用到的 prepare().all() ---------- */
const raw = new DatabaseSync(":memory:");
raw.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, expires_at INTEGER)");
const put = (key, value, type = "string") => raw.prepare("INSERT INTO kv(key,value,type,expires_at) VALUES(?,?,?,NULL)").run(key, value, type);
const fakeD1 = { prepare: (sql) => ({ all: (...p) => ({ results: raw.prepare(sql).all(...p) }) }) };

/* 第 1 单：被合并的那张（22 家 1.150887t） */
const first = {
  id: "W-FIRST", routeId: ROUTE, date: DATE, vehicle: "渝DK7692", stage: "CONFIRMED",
  totalWeight: 1.150887, createdBy: "u-1",
  stores: Array.from({ length: 22 }, (_, i) => ({ name: "门店" + (i + 1) })),
  summary: { finalCount: 22, total: 22 },
  historyStatus: "SUPERSEDED", supersededBy: "W-SECOND", supersededAt: "2026-11-06T09:30:00.000Z",
  dailyDedupeKey: "sig-first", businessFingerprint: "fp-first",
};
/* 第 2 单：正常在册（21 家 1.070565t） */
const second = {
  id: "W-SECOND", routeId: ROUTE, date: DATE, vehicle: "渝DK7692", stage: "CONFIRMED",
  totalWeight: 1.070565, createdBy: "u-1",
  stores: Array.from({ length: 21 }, (_, i) => ({ name: "门店" + (i + 1) })),
  summary: { finalCount: 21, total: 21 },
};

put("zp:waybill:W-FIRST", JSON.stringify(first));
put("zp:waybill:W-SECOND", JSON.stringify(second));
put("zp:waybill:W-OTHER-ROUTE", JSON.stringify({ ...first, id: "W-OTHER-ROUTE", routeId: "route-r2" }));
put("zp:waybill:W-FIRST:events", JSON.stringify(["WAYBILL_SUPERSEDED"]), "list"); // 子键必须跳过
put("zp:waybill:trash:W-DEL", JSON.stringify({ ...first, id: "W-DEL" }));           // 回收站键必须跳过
put("zp:waybill:dedupe:sig-first", "W-FIRST");                                      // 去重键必须跳过

/* ---------- 1. 列表：只列本线路、真正 SUPERSEDED 的主记录 ---------- */
{
  const r = await listSuperseded({ DB: fakeD1 }, ROUTE);
  assert.equal(r.supported, true, "D1 环境应支持");
  assert.equal(r.items.length, 1, `只应列出 1 张，实际 ${r.items.length}`);
  const it = r.items[0];
  assert.equal(it.id, "W-FIRST");
  assert.equal(it.date, DATE);
  assert.equal(it.vehicle, "渝DK7692");
  assert.equal(it.storeCount, 22);
  assert.equal(it.totalWeight, 1.150887);
  assert.equal(it.supersededBy, "W-SECOND");

  // 无线索时不得误报：另一条线路看不到
  const r2 = await listSuperseded({ DB: fakeD1 }, "route-r2");
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].id, "W-OTHER-ROUTE");

  // 无 D1（Upstash 回退）时明确 unsupported，前端据此隐藏区块
  const r3 = await listSuperseded({}, ROUTE);
  assert.deepEqual(r3, { supported: false, items: [] });
  console.log("✅ 列表只返回本线路被合并的主记录（子键 / 回收站 / 去重键均已跳过）");
}

/* ---------- 2. 恢复：清标记 + 加回索引 + 备份 + 留痕 ---------- */
{
  const user = { id: "u-1", role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver" };
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  red._set("zp:waybill:W-FIRST", JSON.stringify(first));
  red._set("zp:waybill:W-SECOND", JSON.stringify(second));
  red.sets.set(indexKey, new Set(["W-SECOND"]));
  red.sets.set("zp:schedule:" + ROUTE, new Set());

  const resp = await restoreSuperseded(env, user, ROUTE, "W-FIRST");
  const d = await resp.json();
  assert.equal(d.success, true, "恢复应成功：" + JSON.stringify(d));
  assert.equal(d.date, DATE);

  const saved = JSON.parse(red._get("zp:waybill:W-FIRST"));
  assert.equal(saved.historyStatus, undefined, "必须清掉 SUPERSEDED 标记");
  assert.equal(saved.supersededBy, undefined, "必须清掉 replacedBy");
  assert.equal(saved.supersededReason, undefined, "必须清掉 replacedReason");
  assert.equal(saved.stage, "CONFIRMED", "阶段保持不变");
  assert.equal(saved.totalWeight, 1.150887, "重量保持不变");

  assert.equal(red.sets.get(indexKey)?.has("W-FIRST"), true, "必须加回当日索引");
  assert.equal(red.sets.get(indexKey)?.has("W-SECOND"), true, "原有单仍在索引");
  assert.equal(red.sets.get(indexKey)?.size, 2, "当天应为两单");

  const backups = [...red.strings.keys()].filter((k) => k.startsWith("zp:waybill:W-FIRST:backup:"));
  assert.equal(backups.length, 1, "恢复前必须留一份备份");
  const backup = JSON.parse(red._get(backups[0]));
  assert.equal(backup.historyStatus, "SUPERSEDED", "备份应是恢复前的原始状态");

  const events = (red.lists.get("zp:waybill:W-FIRST:events") || []).map((x) => JSON.parse(x));
  assert.ok(events.some((e) => e.event === "WAYBILL_RESTORED"), "应写入恢复事件");

  // 幂等：不是被合并状态时拒绝，避免重复恢复
  const again = await restoreSuperseded(env, user, ROUTE, "W-FIRST");
  const d2 = await again.json();
  assert.equal(again.status, 400);
  assert.equal(d2.code, "NOT_SUPERSEDED");
  console.log("✅ 恢复链路完整：清标记 / 加回索引 / 备份 / 事件留痕 / 重复恢复被拒");
}

/* ---------- 3. 安全边界：跨线路、缺记录 ---------- */
{
  const user = { id: "u-1", role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "driver" };
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  red._set("zp:waybill:W-OTHER-ROUTE", JSON.stringify({ ...first, id: "W-OTHER-ROUTE", routeId: "route-r2" }));

  const cross = await restoreSuperseded(env, user, ROUTE, "W-OTHER-ROUTE");
  const cj = await cross.json();
  assert.equal(cross.status, 403, "不得恢复其它线路的运单");

  const missing = await restoreSuperseded(env, user, ROUTE, "W-NOT-EXIST");
  assert.equal(missing.status, 404, "记录不存在应 404");
  console.log("✅ 跨线路恢复被拒（403），缺记录 404");
}

console.log("\n✅ history-superseded 全部通过");
