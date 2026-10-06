/**
 * 智配One · 运单数据一致性自检 + 外科手术式修复（1.1 核心增强 · P1.5）
 * ------------------------------------------------------------------
 * 只读扫描 Redis 中运单相关键，比对「索引 / 日去重键 / 内容指纹键 / 事件链 / 主记录」
 * 之间的引用完整性，输出可解释差异报告；并可应用 ONLY 安全修复（删除悬空引用、
 * 按主记录补回缺失索引）。绝不整体重建 Redis、绝不擅自删除主记录
 * （MANUAL 项由运维人工拍板，INFO 项 TTL 自动清理）。
 *
 * 键结构（见 process.js / history.js / _waybill-events.js / _waybill-proc.js）：
 *   主记录   zp:waybill:<id>
 *   索引     zp:route:<routeId>:waybills:<date>  (SET，存 waybill id)
 *   日去重   zp:waybill:dedupe:<dailySig>         (string -> id)
 *   内容指纹 zp:waybill:fingerprint:<fp>           (string -> id)
 *   事件链   zp:waybill:<id>:events                (List)
 *   处理票据 zp:waybill:proc:<requestId>           (TTL 15min)
 */
import { command } from "../_redis.js";

const WB_PREFIX = "zp:waybill:";
const INDEX_PREFIX = "zp:route:";
const INDEX_SUFFIX = ":waybills:";
const clean = v => String(v ?? "").trim();

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

const parseWaybill = raw => {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
};

const isReadable = w =>
  w && w.schemaVersion === "2" && typeof w.id === "string" &&
  typeof w.routeId === "string" && Array.isArray(w.stores) &&
  !!w.summary && w.historyStatus !== "SUPERSEDED" &&
  ["PLANNED", "CONFIRMED"].includes(w.stage);

// 判断 pointsTo 是否在作用域内：scopeRoute 为 null 即全部；若指向缺失主记录（悬空）恒报。
function inScopeOfId(id, waybills, scopeRoute) {
  if (scopeRoute === null) return true;
  const w = waybills.get(id);
  if (!w) return true; // 悬空引用，无论作用域都报
  return clean(w.routeId) === scopeRoute;
}

/**
 * 扫描一致性。
 * @param {{routeId?:string, all?:boolean}} opts routeId 限定线路；all=true 扫描全部（仅运维）。
 * @returns 可解释报告 {scanned, issues, summary}
 */
export async function scanConsistency(env, { routeId = null, all = false } = {}) {
  const scopeRoute = all ? null : clean(routeId);
  const inScope = r => scopeRoute === null || clean(r) === scopeRoute;

  // 1. 收集所有运单命名空间键
  const wbKeys = await scanAll(env, WB_PREFIX + "*");
  const waybills = new Map();   // id -> parsed
  const eventIds = new Set();   // 有事件链的 waybill id
  const dedupeKeys = [];        // {key, pointsTo}
  const fpKeys = [];            // {key, pointsTo}
  const procTickets = [];       // {key}
  for (const key of wbKeys) {
    const rest = key.slice(WB_PREFIX.length);
    if (rest.endsWith(":events")) { eventIds.add(rest.slice(0, -(":events".length))); continue; }
    if (rest.startsWith("dedupe:")) { const id = await command(env, ["GET", key]); dedupeKeys.push({ key, pointsTo: clean(id) }); continue; }
    if (rest.startsWith("fingerprint:")) { const id = await command(env, ["GET", key]); fpKeys.push({ key, pointsTo: clean(id) }); continue; }
    if (rest.startsWith("proc:")) { procTickets.push({ key }); continue; }
    const id = rest; // 主记录
    if (waybills.has(id)) continue;
    const w = parseWaybill(await command(env, ["GET", key]));
    if (w) waybills.set(id, w);
  }

  // 2. 索引集合
  const indexKeys = await scanAll(env, INDEX_PREFIX + "*" + INDEX_SUFFIX + "*");
  const indexMembers = new Map(); // `${routeId}|${date}` -> Set(id)
  const indexMeta = [];           // {routeId, date, key}
  for (const key of indexKeys) {
    const body = key.slice(INDEX_PREFIX.length);
    const idx = body.indexOf(INDEX_SUFFIX);
    if (idx < 0) continue;
    const rId = body.slice(0, idx);
    const date = body.slice(idx + INDEX_SUFFIX.length);
    if (!inScope(rId)) continue;
    const members = await command(env, ["SMEMBERS", key]);
    const set = new Set(Array.isArray(members) ? members.map(clean).filter(Boolean) : []);
    indexMembers.set(rId + "|" + date, set);
    indexMeta.push({ routeId: rId, date, key });
  }

  const issues = [];
  const MAX = 600;
  const push = it => { if (issues.length < MAX) issues.push(it); };

  // 3. 索引成员 → 主记录 完整性（孤儿索引条目 / SUPERSEDED 仍留索引）
  for (const { routeId: rId, date, key } of indexMeta) {
    for (const member of indexMembers.get(rId + "|" + date) || []) {
      const w = waybills.get(member);
      if (!w) {
        push({ type: "ORPHAN_INDEX_ENTRY", severity: "auto", routeId: rId, date, waybillId: member,
          detail: `索引 ${key} 含成员 ${member}，但主记录 zp:waybill:${member} 不存在`,
          fix: ["SREM", key, member] });
      } else if (w.historyStatus === "SUPERSEDED" || !["PLANNED", "CONFIRMED"].includes(w.stage)) {
        push({ type: "SUPERSEDED_IN_INDEX", severity: "auto", routeId: rId, date, waybillId: member,
          detail: `主记录 ${member} 状态为 ${w.stage}${w.historyStatus ? "/" + w.historyStatus : ""}，不应留在可查询索引`,
          fix: ["SREM", key, member] });
      }
    }
  }

  // 4. 主记录 → 索引 完整性 + 结构校验
  for (const [id, w] of waybills) {
    if (!inScope(w.routeId)) continue;
    if (!w || w.schemaVersion !== "2" || typeof w.id !== "string" || typeof w.routeId !== "string" || !Array.isArray(w.stores) || !w.summary) {
      push({ type: "MALFORMED_WAYBILL", severity: "manual", waybillId: id,
        detail: `主记录 ${id} 结构异常（schemaVersion=${w?.schemaVersion}），需人工核对`,
        fix: null });
      continue;
    }
    if (!isReadable(w)) continue; // SUPERSEDED / 不可读本就不在索引，跳过
    const date = clean(w.date);
    const idxKey = INDEX_PREFIX + w.routeId + INDEX_SUFFIX + date;
    const set = indexMembers.get(w.routeId + "|" + date);
    if (!set || !set.has(id)) {
      push({ type: "MISSING_INDEX_ENTRY", severity: "auto", routeId: w.routeId, date, waybillId: id,
        detail: `主记录 ${id}（${w.routeId} ${date}）未在索引 ${idxKey} 中，列表查询将遗漏`,
        fix: ["SADD", idxKey, id] });
    }
  }

  // 5. 去重键 / 指纹键 悬空
  for (const { key, pointsTo } of dedupeKeys) {
    if (!pointsTo) continue;
    if (!waybills.has(pointsTo) && inScopeOfId(pointsTo, waybills, scopeRoute)) {
      push({ type: "ORPHAN_DEDUPE_KEY", severity: "auto", key, pointsTo,
        detail: `去重键 ${key} 指向不存在的主记录 ${pointsTo}`,
        fix: ["DEL", key] });
    }
  }
  for (const { key, pointsTo } of fpKeys) {
    if (!pointsTo) continue;
    if (!waybills.has(pointsTo) && inScopeOfId(pointsTo, waybills, scopeRoute)) {
      push({ type: "ORPHAN_FINGERPRINT_KEY", severity: "auto", key, pointsTo,
        detail: `指纹键 ${key} 指向不存在的主记录 ${pointsTo}`,
        fix: ["DEL", key] });
    }
  }

  // 6. 事件链孤儿
  for (const id of eventIds) {
    if (waybills.has(id)) continue;
    if (inScopeOfId(id, waybills, scopeRoute)) {
      push({ type: "ORPHAN_EVENT_LIST", severity: "auto", waybillId: id, key: WB_PREFIX + id + ":events",
        detail: `事件链 zp:waybill:${id}:events 存在，但主记录 ${id} 不存在`,
        fix: ["DEL", WB_PREFIX + id + ":events"] });
    }
  }

  // 7. 重复内容指纹（MANUAL）
  const byFp = new Map();
  for (const [id, w] of waybills) {
    if (!inScope(w.routeId)) continue;
    const fp = clean(w.businessFingerprint);
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(id);
  }
  for (const [fp, ids] of byFp) {
    if (ids.length > 1) {
      push({ type: "DUPLICATE_FINGERPRINT", severity: "manual", fingerprint: fp, waybillIds: ids,
        detail: `内容指纹 ${fp} 命中 ${ids.length} 张运单，去重可能失效`,
        fix: null });
    }
  }

  // 8. 处理票据孤儿（info，TTL 15min 自动清理）
  for (const { key } of procTickets) {
    push({ type: "PROC_TICKET_ORPHAN", severity: "info", key,
      detail: `处理票据 ${key} 仍存在（TTL 15min 自动清理，无需人工处理）`,
      fix: null });
  }

  const counts = {};
  for (const it of issues) counts[it.type] = (counts[it.type] || 0) + 1;
  const autoRepairable = issues.filter(i => i.fix).length;
  return {
    scanned: {
      waybills: waybills.size,
      indexes: indexMeta.length,
      dedupeKeys: dedupeKeys.length,
      fingerprintKeys: fpKeys.length,
      eventLists: eventIds.size,
      procTickets: procTickets.length
    },
    issues,
    summary: { total: issues.length, autoRepairable, manual: issues.length - autoRepairable, counts, truncated: issues.length >= MAX }
  };
}

/**
 * 应用安全修复（仅执行 issue.fix，绝不触碰主记录 / 手动项 / INFO 项）。
 * @returns {repaired:[], skipped:[], repairedCount, skippedCount}
 */
export async function repairConsistency(env, issues) {
  const repaired = [];
  const skipped = [];
  for (const it of issues || []) {
    if (Array.isArray(it.fix) && it.fix.length) {
      const { fix, ...meta } = it;
      try { await command(env, fix); repaired.push({ type: it.type, ...meta }); }
      catch (e) { skipped.push({ type: it.type, error: String(e?.message || e) }); }
    } else {
      skipped.push({ type: it.type, reason: "MANUAL_OR_INFO" });
    }
  }
  return { repaired, skipped, repairedCount: repaired.length, skippedCount: skipped.length };
}

export default { scanConsistency, repairConsistency };
