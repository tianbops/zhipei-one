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
import { Budget, SUBREQUEST_LIMIT, scanKeysBudgeted, mgetBatchMap, smembersBatch } from "../_redis-budget.js";
import { businessFingerprint, dailyWaybillKey } from "../_waybill-identity.js";

const WB_PREFIX = "zp:waybill:";
const INDEX_PREFIX = "zp:route:";
const INDEX_SUFFIX = ":waybills:";
const clean = v => String(v ?? "").trim();
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
// Asia/Shanghai 日期：运单日期兜底与 createdAt 取日期均以此为准，避免时区错位。
const cnDateParts = dateObj => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dateObj);
  const v = Object.fromEntries(p.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const todayCN = () => cnDateParts(new Date());
// 由 createdAt 推 YYYY-MM-DD；非法输入返回 null（上层再兜底到今天）
const cnDateOf = iso => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? cnDateParts(new Date(t)) : null;
};

// ====== Cloudflare Workers 资源边界护栏（2026-10-07 生产事故修） ======
// Workers 免费版每请求子请求上限约 50。巡检走两条成本线：
//   ① SCAN 迭代：每次迭代 = 1 个子请求；键空间大 + MATCH 稀疏时迭代次数 ≈ 键空间/COUNT
//   ② 逐键读取：GET / SMEMBERS 每个键 = 1 个子请求
// 旧实现两条都是 O(N)：先是逐键 GET/SMEMBERS，再叠加无上限的稀疏 SCAN，
// 生产数据量下必然爆预算 → Worker 抛异常 → Cloudflare Error 1101。
// 因此这里同时收紧三者：COUNT 放大、MGET/pipeline 批量、**全局预算 + 相位数上限**。
// 预算逻辑已统一收口到 _redis-budget.js（Budget / scanKeysBudgeted / mgetBatchMap / smembersBatch），
// 此处只保留一致性扫描专属的迭代上限。预算耗尽时不等平台掐断，而是主动截断并在报告里标注
// degraded —— 宁可给出「可能不完整」的结论，也不能让一致性工具沉默地返回一个「什么问题都没有」的假绿灯。
const SCAN_ITER_CAP_WAYBILL = 12;
const SCAN_ITER_CAP_INDEX = 8;

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

  const budget = new Budget();
  // 1. 收集所有运单命名空间键
  let complete = true;
  const wbScan = await scanKeysBudgeted(env, WB_PREFIX + "*", budget, { iterCap: SCAN_ITER_CAP_WAYBILL });
  complete = complete && wbScan.complete;
  const wbKeys = wbScan.keys;
  const waybills = new Map();   // id -> parsed
  const eventIds = new Set();   // 有事件链的 waybill id
  const dedupeKeys = [];        // {key, pointsTo}
  const fpKeys = [];            // {key, pointsTo}
  const procTickets = [];       // {key}
  const primaryIds = [], dedupeKeyList = [], fpKeyList = [];
  for (const key of wbKeys) {
    const rest = key.slice(WB_PREFIX.length);
    if (rest.endsWith(":events")) { eventIds.add(rest.slice(0, -(":events".length))); continue; }
    if (rest.startsWith("dedupe:")) { dedupeKeyList.push(key); continue; }
    if (rest.startsWith("fingerprint:")) { fpKeyList.push(key); continue; }
    if (rest.startsWith("proc:")) { procTickets.push({ key }); continue; }
    if (rest.includes(":")) continue; // 其余子命名空间（如 learning-repair）不属本巡检范围
    primaryIds.push(rest);
  }
  // 批量读取（旧实现为逐键 GET，子请求数 O(N) → 1101）
  const primaryRead = await mgetBatchMap(env, primaryIds.map(id => WB_PREFIX + id), budget);
  complete = complete && primaryRead.complete;
  for (const id of primaryIds) { const w = parseWaybill(primaryRead.map.get(WB_PREFIX + id)); if (w) waybills.set(id, w); }
  const dedupeRead = await mgetBatchMap(env, dedupeKeyList, budget);
  complete = complete && dedupeRead.complete;
  for (const key of dedupeKeyList) dedupeKeys.push({ key, pointsTo: clean(dedupeRead.map.get(key)) });
  const fpRead = await mgetBatchMap(env, fpKeyList, budget);
  complete = complete && fpRead.complete;
  for (const key of fpKeyList) fpKeys.push({ key, pointsTo: clean(fpRead.map.get(key)) });

  const issues = [];
  const MAX = 600;
  const push = it => { if (issues.length < MAX) issues.push(it); };

  // 2. 索引集合
  // 限定线路时把 SCAN 收窄到该线路的索引前缀——不限定时才扫全部线路（仅运维）
  const indexPattern = scopeRoute === null
    ? INDEX_PREFIX + "*" + INDEX_SUFFIX + "*"
    : INDEX_PREFIX + scopeRoute + INDEX_SUFFIX + "*";
  const idxScan = await scanKeysBudgeted(env, indexPattern, budget, { iterCap: SCAN_ITER_CAP_INDEX });
  complete = complete && idxScan.complete;
  const indexKeys = idxScan.keys.filter(key => {
    const body = key.slice(INDEX_PREFIX.length);
    const idx = body.indexOf(INDEX_SUFFIX);
    return idx >= 0 && inScope(body.slice(0, idx));
  });
  const idxRead = await smembersBatch(env, indexKeys, budget);
  complete = complete && idxRead.complete;
  const membersMap = idxRead.map;
  // 「主记录视图」与「索引视图」是否完整：这是**能否做引用完整性判定**的前提。
  // 键空间被截断时，某个主记录没被读到并不代表它不存在——若照常报 ORPHAN/MISSING，
  // 就会把「扫不全」伪装成「数据坏了」，诱导运维执行错误的删除修复。
  // 因此凡依赖「另一侧不存在」的判定，一律在视图不完整时停报，只保留单侧可见即可证实的项。
  const refsComplete = wbScan.complete && primaryRead.complete;
  const indexComplete = idxScan.complete && idxRead.complete;
  const indexMembers = new Map(); // `${routeId}|${date}` -> Set(id)
  const indexMeta = [];           // {routeId, date, key}
  const inBadBucket = new Set();  // 已出现在非法日期桶中的运单 id（由 MALFORMED_INDEX_DATE 负责归档）
  for (const key of indexKeys) {
    const body = key.slice(INDEX_PREFIX.length);
    const idx = body.indexOf(INDEX_SUFFIX);
    if (idx < 0) continue;
    const rId = body.slice(0, idx);
    const date = body.slice(idx + INDEX_SUFFIX.length);
    if (!inScope(rId)) continue;
    const members = membersMap.get(key);
    const set = new Set(Array.isArray(members) ? members.map(clean).filter(Boolean) : []);
    // 空/非法日期桶（如 zp:route:<routeId>:waybills: —— OCR 未识别日期的历史运单所在）：
    // 历史查询按 YYYY-MM-DD 枚举、诊断列表按日期格式过滤，两处都取不到，运单会「凭空消失」。
    // 因此单独成项，并给出「加入正确日期桶 + 移出非法桶」的两步修复。
    if (!isDate(date)) {
      for (const member of set) {
        inBadBucket.add(member);
        const w = waybills.get(member);
        const target = w && isDate(clean(w.date)) ? clean(w.date) : cnDateOf(w && w.createdAt) || todayCN();
        const correctKey = INDEX_PREFIX + rId + INDEX_SUFFIX + target;
        push({ type: "MALFORMED_INDEX_DATE", severity: "auto", routeId: rId, date: date || "(空)", waybillId: member, targetDate: target,
          detail: `索引日期栏位为 "${date || "(空)"}"（非 YYYY-MM-DD），成员 ${member} 在历史查询与诊断列表中均不可见；应归入 ${target} 桶`,
          fix: [["SADD", correctKey, member], ["SREM", key, member]] });
      }
      continue;
    }
    indexMembers.set(rId + "|" + date, set);
    indexMeta.push({ routeId: rId, date, key });
  }

  // 3. 索引成员 → 主记录 完整性（孤儿索引条目 / SUPERSEDED 仍留索引）
  for (const { routeId: rId, date, key } of indexMeta) {
    for (const member of indexMembers.get(rId + "|" + date) || []) {
      const w = waybills.get(member);
      if (!w) {
        if (!refsComplete) continue; // 主记录视图不完整，「找不到」不能当作「不存在」
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
    // 主记录本身没有合法配送日期（历史 OCR 未识别）：绝不能再按它拼 key 去做 SADD——
    // 那会把记录塞回非法日期桶，与 MALFORMED_INDEX_DATE 的修复互相抵消形成死循环。
    // 这里单独成项交由人工处理（一致性模块不改写主记录），实际归档由上述修复项接管。
    if (!isDate(clean(w.date))) {
      push({ type: "WAYBILL_DATE_INVALID", severity: "manual", routeId: w.routeId, waybillId: id,
        detail: `主记录 ${id} 缺少合法配送日期（date="${clean(w.date)}"），历史/列表上的日期会显示为空；建议重新上传覆盖`,
        fix: null });
      continue;
    }
    // 已由 MALFORMED_INDEX_DATE 负责迁移归档的记录不再重复报 MISSING，避免同一张单被报两次
    if (inBadBucket.has(id)) continue;
    const date = clean(w.date);
    const idxKey = INDEX_PREFIX + w.routeId + INDEX_SUFFIX + date;
    const set = indexMembers.get(w.routeId + "|" + date);
    if (!set || !set.has(id)) {
      if (!(refsComplete && indexComplete)) continue; // 视图不全时报告 MISSING 只会误导
      push({ type: "MISSING_INDEX_ENTRY", severity: "auto", routeId: w.routeId, date, waybillId: id,
        detail: `主记录 ${id}（${w.routeId} ${date}）未在索引 ${idxKey} 中，列表查询将遗漏`,
        fix: ["SADD", idxKey, id] });
    }
  }

  // 5. 去重键 / 指纹键：不仅检查“悬空”，还校验 key 与目标运单是否真正对应。
  //    这能抓住跨线路/错位引用：目标主记录存在并不代表这个引用就是合法的。
  //    key 本身由 canonicalWaybill/dailySignature 派生，发现错位时只删除引用键，不删除主记录。
  for (const { key, pointsTo } of dedupeKeys) {
    if (!pointsTo) continue;
    const w = waybills.get(pointsTo);
    if (!w) {
      if (refsComplete && inScopeOfId(pointsTo, waybills, scopeRoute)) {
        push({ type: "ORPHAN_DEDUPE_KEY", severity: "auto", key, pointsTo,
          detail: `去重键 ${key} 指向不存在的主记录 ${pointsTo}`,
          fix: ["DEL", key] });
      }
      continue;
    }
    if (!inScope(w.routeId)) continue;
    if (w.historyStatus === "SUPERSEDED" || !["PLANNED", "CONFIRMED"].includes(w.stage)) {
      push({ type: "STALE_DEDUPE_KEY", severity: "auto", key, pointsTo,
        detail: `去重键 ${key} 指向不可作为当前业务去重目标的运单 ${pointsTo}（${w.stage || "UNKNOWN"}${w.historyStatus ? "/" + w.historyStatus : ""}）`,
        fix: ["DEL", key] });
      continue;
    }
    const expectedKey = "zp:waybill:dedupe:" + await dailyWaybillKey(w);
    if (expectedKey !== key) {
      push({ type: "MISPLACED_DEDUPE_KEY", severity: "auto", key, pointsTo,
        detail: `去重键 ${key} 与目标运单 ${pointsTo} 的业务签名不一致，疑似跨线路或错位引用`,
        fix: ["DEL", key] });
    }
  }
  for (const { key, pointsTo } of fpKeys) {
    if (!pointsTo) continue;
    const w = waybills.get(pointsTo);
    if (!w) {
      if (refsComplete && inScopeOfId(pointsTo, waybills, scopeRoute)) {
        push({ type: "ORPHAN_FINGERPRINT_KEY", severity: "auto", key, pointsTo,
          detail: `指纹键 ${key} 指向不存在的主记录 ${pointsTo}`,
          fix: ["DEL", key] });
      }
      continue;
    }
    if (!inScope(w.routeId)) continue;
    if (w.historyStatus === "SUPERSEDED" || !["PLANNED", "CONFIRMED"].includes(w.stage)) {
      push({ type: "STALE_FINGERPRINT_KEY", severity: "auto", key, pointsTo,
        detail: `指纹键 ${key} 指向不可作为当前业务指纹目标的运单 ${pointsTo}（${w.stage || "UNKNOWN"}${w.historyStatus ? "/" + w.historyStatus : ""}）`,
        fix: ["DEL", key] });
      continue;
    }
    const expectedKey = "zp:waybill:fingerprint:" + await businessFingerprint(w);
    if (expectedKey !== key) {
      push({ type: "MISPLACED_FINGERPRINT_KEY", severity: "auto", key, pointsTo,
        detail: `指纹键 ${key} 与目标运单 ${pointsTo} 的内容指纹不一致，疑似跨线路或错位引用`,
        fix: ["DEL", key] });
    }
  }

  // 6. 事件链孤儿
  for (const id of eventIds) {
    if (waybills.has(id)) continue;
    if (refsComplete && wbScan.complete && inScopeOfId(id, waybills, scopeRoute)) {
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

  // 9. 扫描完整性：预算耗尽/未跑完键空间时，必须显式声明「结果可能不完整」，
  //    绝不能沉默地返回 0 问题让运维误判数据健康。
  if (!complete) {
    push({ type: "SCAN_TRUNCATED", severity: "info",
      detail: `本次巡检未完整覆盖 Redis 键空间（已触及平台子请求预算上限 ${SUBREQUEST_LIMIT}），结论可能遗漏问题；请用 routeId 缩小范围后重扫`,
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
    // degraded=true 表示本次结论不完整（截断），运维不得据此判定「数据无问题」
    degraded: !complete,
    budget: { limit: SUBREQUEST_LIMIT, used: budget.used, hitsServerlessLimit: budget.exhausted },
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
  const budget = new Budget();

  for (const it of issues || []) {
    const fix = it.fix;
    const steps = Array.isArray(fix) && Array.isArray(fix[0]) ? fix : (Array.isArray(fix) && fix.length ? [fix] : []);
    if (!steps.length) {
      skipped.push({ type: it.type, reason: "MANUAL_OR_INFO" });
      continue;
    }
    // 每个 issue 最多消耗 1 个 Workers 子请求；预算不足立即停止，避免修复过程再次触发 1101。
    if (!budget.canTake(1)) {
      skipped.push({ type: it.type, reason: "BUDGET_EXCEEDED" });
      continue;
    }

    const { fix: _drop, ...meta } = it;
    try {
      // 日期索引迁移必须原子完成：先加入正确桶，再移出错误桶，不能出现半迁移状态。
      if (
        steps.length === 2 &&
        steps[0][0] === "SADD" &&
        steps[1][0] === "SREM" &&
        steps[0].length === 3 &&
        steps[1].length === 3
      ) {
        await command(env, [
          "EVAL",
          "redis.call('SADD',KEYS[1],ARGV[1]); return redis.call('SREM',KEYS[2],ARGV[2])",
          "2",
          steps[0][1],
          steps[1][1],
          steps[0][2],
          steps[1][2]
        ]);
      } else if (steps.length === 1) {
        await command(env, steps[0]);
      } else {
        skipped.push({ type: it.type, ...meta, reason: "UNSUPPORTED_ATOMIC_FIX" });
        continue;
      }
      budget.take(1);
      repaired.push({ type: it.type, ...meta });
    } catch (e) {
      skipped.push({ type: it.type, ...meta, error: String(e?.message || e) });
    }
  }

  return {
    repaired,
    skipped,
    repairedCount: repaired.length,
    skippedCount: skipped.length,
    budgetExceeded: skipped.some(x => x.reason === "BUDGET_EXCEEDED")
  };
}
export default { scanConsistency, repairConsistency };
