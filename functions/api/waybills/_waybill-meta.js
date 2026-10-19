// 智配One · 历史概览每日汇总键（方案C rollup，2026-10-19）
// ------------------------------------------------------------------
// 让历史概览接口不再 MGET 全量运单完整体，改为读「每日汇总」小键
//   zp:route:<routeId>:waybills:<date>:meta = {v:1, count, storeCount, totalWeight}
// 概览成本从「O(天数 × 当天单量)」降为「O(天数)」，与单量彻底脱钩。
//
// 设计要点：
//   1) recomputeDayMeta 从当日索引「真实数据」重算 meta，恒正确，不依赖增量维护（杜绝增量漂移）。
//      单次仅触及 1 天数据（SMEMBERS + MGET 该天运单），bounded，可安全在写入/删除路径调用。
//   2) 仅在首次部署后、legacy 数据尚无 meta 时，概览会按日自愈（bounded 1 天/次，受平台子请求硬限约束）；
//      大批量回填由管理员在 diagnostic 跑 rebuild-meta（游标分批）完成。
//   3) 与 history.js 概览聚合逐项同公式；仅 WAYBILL_STRICT_OWNER=1 紧急模式由读取侧回退读真实体
//      （见 history.js readDayAggregates），保证所有模式下行为一致。
import { command } from "../_redis.js";
import { Budget, mgetBatchMap, scanKeysBudgeted } from "../_redis-budget.js";

const clean = v => String(v ?? "").trim();
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
export const dayMetaKey = (routeId, date) => "zp:route:" + routeId + ":waybills:" + date + ":meta";
const waybillIndexKey = (routeId, date) => "zp:route:" + routeId + ":waybills:" + date;

// 与 history.js 概览聚合逐项同公式（去掉逐用户 ACL：按 routeId|date 维度聚合，调用方已校验线路归属）。
const isReadable = w =>
  !!w && w.schemaVersion === "2" && typeof w.id === "string" && typeof w.routeId === "string" &&
  Array.isArray(w.stores) && !!w.summary && w.historyStatus !== "SUPERSEDED" &&
  ["PLANNED", "CONFIRMED"].includes(w.stage);

export function aggregateWaybills(list, routeId, date) {
  let count = 0, storeCount = 0, totalWeight = 0;
  for (const w of list) {
    if (!isReadable(w)) continue;
    if (clean(w.routeId) !== routeId) continue;
    if (clean(w.date) !== date) continue;
    count++;
    storeCount += Number(w.summary?.finalCount || w.summary?.total || w.stores.length);
    totalWeight += Number(w.totalWeight) || 0;
  }
  return { count, storeCount, totalWeight };
}

export function parseMeta(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || typeof o !== "object") return null;
    return {
      count: Number(o.count) || 0,
      storeCount: Number(o.storeCount) || 0,
      totalWeight: Number(o.totalWeight) || 0,
    };
  } catch { return null; }
}

// 从当日索引真实数据重算 meta（始终正确）。bounded：仅触及 1 天运单。
// 返回聚合；日期非法时返回 null（调用方按 no-op 处理）。
export async function recomputeDayMeta(env, routeId, date) {
  if (!isDate(date)) return null;
  const indexKey = waybillIndexKey(routeId, date);
  const members = await command(env, ["SMEMBERS", indexKey]);
  const ids = Array.isArray(members) ? members.map(clean).filter(Boolean) : [];
  let list = [];
  if (ids.length) {
    const budget = new Budget();
    const read = await mgetBatchMap(env, ids.map(id => "zp:waybill:" + id), budget, { batch: 100 });
    list = ids.map(id => {
      const raw = read.map.get("zp:waybill:" + id);
      if (!raw) return null;
      try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    }).filter(Boolean);
  }
  const agg = aggregateWaybills(list, routeId, date);
  try { await command(env, ["SET", dayMetaKey(routeId, date), JSON.stringify({ v: 1, ...agg })]); } catch { /* best-effort */ }
  return agg;
}

// 读取 meta（不回退）。缺失/损坏返回 null。
export async function readDayMeta(env, routeId, date) {
  if (!isDate(date)) return null;
  const raw = await command(env, ["GET", dayMetaKey(routeId, date)]);
  return parseMeta(raw);
}

// 管理端一次性回填：游标分批扫描本线路（或全部）日期桶并重算 meta。
// 单请求预算内最多重算 limit 个日期桶，返回 nextCursor 供管理端接力调用，
// 直到 complete=true。recompute 幂等（始终从真值重算），重复调用安全。
export async function rebuildAllMeta(env, { routeId = null, all = false, cursor = "0", limit = 30 } = {}) {
  const scopeRoute = all ? null : clean(routeId);
  const inScope = r => scopeRoute === null || clean(r) === scopeRoute;
  const pattern = scopeRoute === null ? "zp:route:*:waybills:*" : "zp:route:" + scopeRoute + ":waybills:*";
  let cur = String(cursor || "0");
  const dates = [];
  const budget = new Budget();
  // 扫描收集日期桶（排除 :meta 子键与非法日期桶）
  do {
    if (dates.length >= limit) break;
    if (!budget.take(1)) break;
    const r = await command(env, ["SCAN", cur, "MATCH", pattern, "COUNT", "500"]);
    cur = String(r?.[0] ?? "0");
    for (const key of (Array.isArray(r?.[1]) ? r[1] : [])) {
      const text = String(key);
      if (text.endsWith(":meta")) continue;
      const idx = text.indexOf(":waybills:");
      if (idx < 0) continue;
      const rId = text.slice("zp:route:".length, idx);
      const date = text.slice(idx + ":waybills:".length);
      if (!isDate(date)) continue;
      if (!inScope(rId)) continue;
      dates.push({ routeId: rId, date });
    }
  } while (cur !== "0" && dates.length < limit);
  // 重算（bounded：每日期桶仅 1 天数据）
  let rebuilt = 0;
  for (const d of dates) {
    if (!budget.take(1)) break;
    await recomputeDayMeta(env, d.routeId, d.date);
    rebuilt++;
  }
  return { scanned: dates.length, rebuilt, nextCursor: cur, complete: cur === "0" };
}
