/**
 * 智配One · 运单运营统计（1.1 核心增强 · P1.5 延伸 / 1.3）
 * ------------------------------------------------------------------
 * 把"可观测（诊断）→ 可解释（一致性自检）→ 可量化（统计）"补成闭环：
 * 让运维/线路维护者随时看清健康度——待定率、低置信率、OCR 超时/失败率、
 * 确认率、质量门分布——支撑长期稳定运行决策。
 *
 * 纯只读、按需计算、不落地任何新存储、不碰 UI 红线。与一致性自检同源：
 * 业务用户仅看自己线路；管理员可 all=1 全量或指定 routeId。
 *
 * 数据来源（见 history.js / process.js / _waybill-proc.js）：
 *   索引     zp:route:<routeId>:waybills:<date>  → 运单量 / stage 分布
 *   主记录   zp:waybill:<id>                       → quality / stores.matchConfidence / pending / ocr.lowConfidence
 *   处理票据 zp:waybill:proc:<requestId>           → 近 15min 处理终态分布（OCR 可靠性）
 */
import { command } from "../_redis.js";
import { effectiveStage } from "./_waybill-proc.js";

const WB_PREFIX = "zp:waybill:";
const INDEX_PREFIX = "zp:route:";
const INDEX_SUFFIX = ":waybills:";
const clean = v => String(v ?? "").trim();
const MAX_SCANNED = 5000;

async function scanAll(env, pattern) {
  const out = [];
  let cursor = "0";
  do {
    const r = await command(env, ["SCAN", cursor, "MATCH", pattern, "COUNT", "200"]);
    cursor = String(r?.[0] ?? "0");
    for (const k of Array.isArray(r?.[1]) ? r[1] : []) out.push(String(k));
  } while (cursor !== "0");
  return out;
}

function dateWindow(days) {
  const n = Math.max(1, Math.min(90, Math.floor(Number(days) || 30)));
  const fmt = d => {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  };
  const today = new Date(Date.now() + 8 * 3600 * 1000); // Asia/Shanghai 近似（仅用于日期窗口边界）
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    list.push(fmt(d));
  }
  return { start: list[0], end: list[list.length - 1], days: n, dates: list };
}

const parseWaybill = raw => {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
};

/**
 * 计算运营统计。
 * @param {{routeId?:string, all?:boolean, days?:number}} opts
 * @returns 可解释报告 {scope, window, waybills, quality, matchConfidence, pending, ocr, processing, generatedAt, truncated?}
 */
export async function computeStats(env, { routeId = null, all = false, days = 30 } = {}) {
  const scopeRoute = all ? null : clean(routeId);
  const win = dateWindow(days);
  const inWindow = d => d >= win.start && d <= win.end;

  // 1. 收集窗口内、作用域内的运单 id
  const ids = new Set();
  const indexEntriesScanned = { value: 0 };
  const truncated = { value: false };
  const addIds = arr => {
    for (const id of arr) { indexEntriesScanned.value++; if (ids.size >= MAX_SCANNED) { truncated.value = true; return; } ids.add(id); }
  };
  if (scopeRoute === null) {
    const indexKeys = await scanAll(env, INDEX_PREFIX + "*" + INDEX_SUFFIX + "*");
    for (const key of indexKeys) {
      const body = key.slice(INDEX_PREFIX.length);
      const idx = body.indexOf(INDEX_SUFFIX);
      if (idx < 0) continue;
      const date = body.slice(idx + INDEX_SUFFIX.length);
      if (!inWindow(date)) continue;
      const members = await command(env, ["SMEMBERS", key]);
      addIds(Array.isArray(members) ? members.map(clean).filter(Boolean) : []);
      if (truncated.value) break;
    }
  } else {
    for (const date of win.dates) {
      const members = await command(env, ["SMEMBERS", INDEX_PREFIX + scopeRoute + INDEX_SUFFIX + date]);
      addIds(Array.isArray(members) ? members.map(clean).filter(Boolean) : []);
      if (truncated.value) break;
    }
  }

  // 2. 批量读取并聚合
  const agg = {
    waybills: { total: 0, byStage: { PLANNED: 0, CONFIRMED: 0, SUPERSEDED: 0, OTHER: 0 }, confirmedRate: null },
    quality: { OK: 0, WARN: 0, REVIEW: 0, UNKNOWN: 0 },
    matchConfidence: { HIGH: 0, MEDIUM: 0, LOW: 0, PENDING: 0, UNKNOWN: 0 },
    pending: { waybillsWithPending: 0, totalStores: 0, pendingStores: 0, pendingRate: null },
    ocr: { lowConfidence: 0, total: 0 }
  };
  const uniqueIds = [...ids];
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const chunk = uniqueIds.slice(i, i + 50);
    const raws = await command(env, ["MGET", ...chunk.map(id => WB_PREFIX + id)]);
    for (const raw of raws) {
      const w = parseWaybill(raw);
      if (!w || w.schemaVersion !== "2") continue;
      agg.waybills.total++;
      const st = agg.waybills.byStage;
      if (st[w.stage] !== undefined) st[w.stage]++; else st.OTHER++;
      const ql = (w.quality && w.quality.level) || "UNKNOWN";
      if (agg.quality[ql] !== undefined) agg.quality[ql]++; else agg.quality.UNKNOWN++;
      const stores = Array.isArray(w.stores) ? w.stores : [];
      let hasPending = false;
      for (const s of stores) {
        agg.pending.totalStores++;
        if (s.pending) { agg.pending.pendingStores++; hasPending = true; }
        const lvl = s.matchConfidence && s.matchConfidence.level;
        if (lvl && agg.matchConfidence[lvl] !== undefined) agg.matchConfidence[lvl]++;
        else agg.matchConfidence.UNKNOWN++;
      }
      if (hasPending) agg.pending.waybillsWithPending++;
      if (w.ocr) { agg.ocr.total++; if (w.ocr.lowConfidence) agg.ocr.lowConfidence++; }
    }
  }
  agg.waybills.confirmedRate = agg.waybills.total ? +(agg.waybills.byStage.CONFIRMED / agg.waybills.total).toFixed(4) : null;
  agg.pending.pendingRate = agg.pending.totalStores ? +(agg.pending.pendingStores / agg.pending.totalStores).toFixed(4) : null;

  // 3. 处理票据（近 15min，TTL 自动清理）→ OCR 可靠性 / 可恢复失败率
  const procKeys = await scanAll(env, WB_PREFIX + "proc:*");
  const proc = { total: 0, byStage: { PROCESSING: 0, STALLED: 0, DONE: 0, TIMEOUT: 0, FAILED: 0, CANCELLED: 0, OTHER: 0 }, recoverableFailures: 0 };
  for (const key of procKeys) {
    const raw = await command(env, ["GET", key]);
    let t = parseWaybill(raw);
    if (!t) continue;
    if (scopeRoute && clean(t.routeId) !== scopeRoute) continue; // 统计作用域贯穿处理票据：普通用户仅本线路终态计入
    proc.total++;
    // 访问时有效阶段：孤儿 PROCESSING（updatedAt 超阈值）按 effectiveStage 重分类为 STALLED/TIMEOUT，避免污染统计
    const s = effectiveStage(t);
    if (proc.byStage[s] !== undefined) proc.byStage[s]++; else proc.byStage.OTHER++;
    if (s === "TIMEOUT" || s === "FAILED" || s === "CANCELLED") proc.recoverableFailures++;
  }

  return {
    scope: scopeRoute === null ? "ALL" : scopeRoute,
    window: { start: win.start, end: win.end, days: win.days },
    scannedWaybills: ids.size,
    indexEntriesScanned: indexEntriesScanned.value,
    waybills: agg.waybills,
    quality: agg.quality,
    matchConfidence: agg.matchConfidence,
    pending: agg.pending,
    ocr: agg.ocr,
    processing: proc,
    generatedAt: new Date().toISOString(),
    truncated: truncated.value
  };
}

export default { computeStats };
