import { json } from "./_json.js";
import { currentUser } from "./_auth.js";
import { canUseRoute } from "./_permissions.js";
import { canWriteWaybill } from "./_waybill-acl.js";
import { command, get, pipeline } from "./_redis.js";
import { dailyWaybillKey } from "./_waybill-identity.js";
import { recomputeDayMeta } from "./waybills/_waybill-meta.js";
import { appendWaybillEvent } from "./waybills/_waybill-events.js";
import { Budget, scanKeysBudgeted, mgetBatchMap, SUBREQUEST_BUDGET_EXCEEDED } from "./_redis-budget.js";

// 历史回收站（P2-3，软删除配套）：
//   GET   列出本线路 7 天内已软删运单；?type=superseded 时列出「被合并运单」；
//   POST  恢复（trash 主记录 + 子键还原 + 重建日期索引 + 条件重建反向引用）；
//         ?type=superseded 时恢复被合并的单（清 historyStatus + 加回索引 + 重算汇总）；
//   DELETE 彻底删除（trash 主记录 + 子键）。
// 7 天 TTL 由 Upstash 自动消亡，本模块只负责用户主动的「恢复 / 彻底删除」。

/* 被合并运单（SUPERSEDED）不在任何索引里，只能回主表找。
   生产存储为 D1 单表 kv(key,value,type)，一条 SQL 粗筛 + JS 精确过滤即可；
   未配置 D1（Upstash 回退）时返回 unsupported，前端据此隐藏该区块。
   用 LIKE '%SUPERSEDED%' 粗筛（宁可多扫，不漏），再由 JS 校验
   historyStatus==="SUPERSEDED"，避免误把 supersededBy 之类字段当命中。 */
export async function listSuperseded(env, routeId) {
  if (!env?.DB?.prepare) return { supported: false, items: [] };
  const rs = await env.DB.prepare(
    "SELECT key, value FROM kv WHERE type='string' AND key GLOB 'zp:waybill:*' AND value LIKE '%SUPERSEDED%' LIMIT 500"
  ).all();
  const rows = Array.isArray(rs?.results) ? rs.results : [];
  const items = [];
  for (const row of rows) {
    const key = clean(row?.key);
    if (!key.startsWith("zp:waybill:")) continue;
    const id = key.slice("zp:waybill:".length);
    // 只认主记录：子键（events / backup / trash / dedupe / fingerprint）一律跳过
    if (!id || id.includes(":")) continue;
    let w; try { w = JSON.parse(row?.value); } catch { continue; }
    if (!w || typeof w !== "object") continue;
    if (clean(w.routeId) !== routeId) continue;
    if (clean(w.historyStatus) !== "SUPERSEDED") continue;
    const stores = Array.isArray(w.stores) ? w.stores : [];
    items.push({
      id,
      date: clean(w.date) || "",
      vehicle: clean(w.vehicle) || "",
      storeCount: Number(w.summary?.finalCount || w.summary?.total || stores.length) || 0,
      totalWeight: Number(w.totalWeight) || 0,
      supersededAt: clean(w.supersededAt) || "",
      supersededBy: clean(w.supersededBy) || "",
    });
  }
  items.sort((a, b) => String(b.supersededAt).localeCompare(String(a.supersededAt)));
  return { supported: true, items: items.slice(0, 100) };
}

/* 恢复被合并运单：清 SUPERSEDED 标记 → 加回日期索引 → 条件重建去重/指纹键
   → 重算当日汇总。恢复后当天就是两单，历史显示「2次」、首页出现切页。 */
export async function restoreSuperseded(env, user, routeId, id) {
  const raw = await get(env, "waybill:" + id);
  if (!raw) return json({ success: false, code: "WAYBILL_NOT_FOUND", error: "运单不存在" }, 404);
  let w; try { w = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return json({ success: false, code: "WAYBILL_PARSE_FAILED", error: "运单数据异常" }, 500); }
  if (!w || typeof w !== "object") return json({ success: false, code: "WAYBILL_BAD_DATA", error: "运单数据异常" }, 500);
  if (clean(w.historyStatus) !== "SUPERSEDED") return json({ success: false, code: "NOT_SUPERSEDED", error: "该运单不是被合并状态，无需恢复" }, 400);
  if (clean(w.routeId) !== routeId || !canWriteWaybill(user, w, env)) return json({ success: false, code: "FORBIDDEN", error: "无权恢复该运单" }, 403);

  const at = new Date().toISOString();
  const backupKey = "zp:waybill:" + id + ":backup:" + at.replace(/[-:.TZ]/g, "");
  const restored = { ...w };
  delete restored.historyStatus;
  delete restored.supersededBy;
  delete restored.supersededAt;
  delete restored.supersededReason;

  const budget = new Budget();
  const warnings = [];
  try {
    // 1) 先备份原记录（30 天），恢复失败可回溯
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["SET", backupKey, JSON.stringify(w)]);
    await command(env, ["EXPIRE", backupKey, 2592000]);
    // 2) 写回主记录（去掉合并标记）
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["SET", "zp:waybill:" + id, JSON.stringify(restored)]);
    // 3) 加回日期索引
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["SADD", "zp:route:" + routeId + ":waybills:" + clean(restored.date), id]);
    // 4) 条件重建反向引用：仅当为空或已指向本单，避免抢走现存单的去重键
    const refKeys = [];
    if (restored.businessFingerprint) refKeys.push("zp:waybill:fingerprint:" + restored.businessFingerprint);
    if (restored.date) { try { const sig = await dailyWaybillKey(restored); refKeys.push("zp:waybill:dedupe:" + sig); } catch {} }
    for (const rk of refKeys) {
      if (!budget.take(1)) break;
      const v = await command(env, ["GET", rk]);
      if (!v || String(v) === String(id)) await command(env, ["SET", rk, id]);
      else warnings.push(rk);
    }
    // 5) 当日汇总重算（家数/重量回到两单口径）
    try { await recomputeDayMeta(env, routeId, clean(restored.date)); } catch {}
    // 6) 留痕
    try { await appendWaybillEvent(env, id, { event: "WAYBILL_RESTORED", stage: "SAVED", by: user.id, at, reason: "SUPERSEDED_RESTORE" }); } catch {}
  } catch (e) {
    if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "恢复资源预算不足，请重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
    return json({ success: false, code: "RESTORE_FAILED", error: "恢复失败：" + (e?.message || "未知错误") }, 500);
  }
  return json({
    success: true, id, date: clean(restored.date),
    warnings: warnings.length ? warnings : undefined,
    message: warnings.length ? "已恢复，部分去重键被现存运单占用已跳过" : "已恢复，当天恢复为多单",
  });
}
const TRASH_TTL_SECONDS = 604800;
const trashMainKey = id => "zp:waybill:trash:" + id;
const trashChildPrefix = id => "zp:waybill:trash:" + id + ":";
const waybillChildPrefix = id => "zp:waybill:" + id + ":";
const clean = v => String(v ?? "").trim();

async function authAndRoute(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { error: json({ success: false, error: "未登录" }, 401) };
  if (user.role === "admin" || !canUseRoute(user)) return { error: json({ success: false, error: "无权操作回收站" }, 403) };
  const routeId = clean(user.dispatchRouteId) || clean(user.boundRouteId);
  return { user, routeId };
}

export async function onRequestGet({ request, env }) {
  const auth = await authAndRoute(request, env);
  if (auth.error) return auth.error;
  const { routeId } = auth;
  // ?type=superseded：列出被同车重传「合并」掉的运单（可一键恢复）
  if (clean(new URL(request.url).searchParams.get("type")) === "superseded") {
    try {
      const r = await listSuperseded(env, routeId);
      return json({ success: true, routeId, type: "superseded", supported: r.supported, count: r.items.length, items: r.items });
    } catch (e) {
      return json({ success: false, code: "SUPERSEDED_LIST_FAILED", error: "被合并运单读取失败：" + (e?.message || "未知错误") }, 500);
    }
  }
  const budget = new Budget();
  let keys;
  try {
    const scanned = await scanKeysBudgeted(env, "zp:waybill:trash:*", budget, { count: 500, cap: 5000 });
    keys = scanned.keys;
    if (!scanned.complete) return json({ success: false, code: "PARTIAL_FAILURE", error: "回收站列表读取未完成，请重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
  } catch (e) {
    if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "回收站列表读取资源不足，请重试" }, 503);
    throw e;
  }
  const ids = keys.map(k => k.slice("zp:waybill:trash:".length).split(":")[0]);
  const uniqueIds = [...new Set(ids)];
  let rawMap;
  try {
    const r = await mgetBatchMap(env, uniqueIds.map(id => trashMainKey(id)), budget, { batch: 100 });
    rawMap = r.map;
  } catch (e) {
    if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "回收站列表读取资源不足，请重试" }, 503);
    throw e;
  }
  // TTL 必须分批 pipeline：逐条 TTL 会随回收站条目数线性消耗 Worker 子请求预算。
  // 只为当前线路且主记录有效的条目读取 TTL，且每批 50 条占用 1 个子请求预算。
  const eligible = [];
  for (const id of uniqueIds) {
    const raw = rawMap.get(trashMainKey(id));
    if (!raw) continue;
    let w; try { w = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { continue; }
    if (clean(w?.routeId) !== routeId) continue; // 仅本线路
    eligible.push({ id, w });
  }
  const ttlMap = new Map();
  for (let i = 0; i < eligible.length; i += 50) {
    const batch = eligible.slice(i, i + 50);
    if (!budget.take(1)) return json({ success: false, code: "PARTIAL_FAILURE", error: "回收站列表读取资源不足，请重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
    const results = await pipeline(env, batch.map(({ id }) => ["TTL", trashMainKey(id)]));
    for (let j = 0; j < batch.length; j++) ttlMap.set(batch[j].id, Number(results?.[j]) || 0);
  }
  const now = Date.now();
  const items = [];
  for (const { id, w } of eligible) {
    const ttl = ttlMap.get(id) || 0;
    const stores = Array.isArray(w.stores) ? w.stores : [];
    items.push({
      id,
      date: w.date || "",
      routeName: clean(w.routeName) || "",
      storeCount: Number(w.summary?.finalCount || w.summary?.total || stores.length) || 0,
      totalWeight: Number(w.totalWeight) || 0,
      ttl: ttl > 0 ? ttl : 0,
      expiresAt: ttl > 0 ? now + ttl * 1000 : 0,
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return json({ success: true, routeId, count: items.length, items });
}

export async function onRequestPost({ request, env }) {
  const auth = await authAndRoute(request, env);
  if (auth.error) return auth.error;
  const { routeId } = auth;
  const url = new URL(request.url);
  const id = clean(url.searchParams.get("id"));
  if (!id) return json({ success: false, code: "ID_REQUIRED", error: "缺少运单 id" }, 400);
  // ?type=superseded：恢复被「合并」掉的运单（不是回收站软删）
  if (clean(url.searchParams.get("type")) === "superseded") {
    return restoreSuperseded(env, auth.user, routeId, id);
  }
  const raw = await get(env, "waybill:trash:" + id);
  if (!raw) return json({ success: false, code: "TRASH_NOT_FOUND", error: "回收站中无此运单或已过期" }, 404);
  let w; try { w = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return json({ success: false, code: "TRASH_PARSE_FAILED", error: "回收站数据异常" }, 500); }
  if (clean(w.routeId) !== routeId || !canWriteWaybill(auth.user, w, env)) return json({ success: false, code: "FORBIDDEN", error: "无权恢复该运单" }, 403);

  const budget = new Budget();
  let warnings = [];
  try {
    // 1) 主记录还原（不加 TTL，与正常运单一致）
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["SET", "zp:waybill:" + id, JSON.stringify(w)]);
    // 2) 子键还原
    if (!budget.take(1)) throwBudget(budget);
    const scanned = await scanKeysBudgeted(env, trashChildPrefix(id) + "*", budget, { count: 500, cap: 5000 });
    if (!scanned.complete) return json({ success: false, code: "PARTIAL_FAILURE", error: "恢复子键读取未完成，请重试" }, 503);
    for (const ck of scanned.keys) {
      // 每次 RENAME 只发起一个 Redis REST 请求；不再预扣不存在的“后续删除”预算。
      if (!budget.take(1)) throwBudget(budget);
      const tail = ck.slice(trashChildPrefix(id).length);
      await command(env, ["RENAME", ck, waybillChildPrefix(id) + tail]);
    }
    // 3) 重建日期索引
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["SADD", "zp:route:" + routeId + ":waybills:" + (w.date || ""), id]);
    if (clean(w.date)) { try { await recomputeDayMeta(env, routeId, clean(w.date)); } catch {} }
    // 4) 条件重建反向引用：仅当键为空或指向本 id 才 SET；已被新单占用则跳过（保护重传幂等）
    const refKeys = [];
    if (w.businessFingerprint) refKeys.push("zp:waybill:fingerprint:" + w.businessFingerprint);
    if (w.date) { try { const sig = await dailyWaybillKey(w); refKeys.push("zp:waybill:dedupe:" + sig); } catch {} }
    for (const rk of refKeys) {
      if (!budget.take(1)) break;
      const v = await command(env, ["GET", rk]);
      // 反向引用键须为永久键（重传去重/指纹幂等依赖）；仅当为空或仍指向本单时重建，已被新单占用则跳过。
      if (!v || String(v) === String(id)) { await command(env, ["SET", rk, id]); }
      else warnings.push(rk);
    }
    // 5) 清理回收站主记录。子键已通过 RENAME 移回正式前缀，旧 trash 子键名已不存在，
    // 因此不再逐个 DEL 这些旧名称，避免无效请求耗尽预算并拖慢恢复。
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["DEL", trashMainKey(id)]);
  } catch (e) {
    if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "恢复资源预算不足，请重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
    return json({ success: false, code: "TRASH_RESTORE_FAILED", error: "恢复失败：" + (e?.message || "未知错误") }, 500);
  }
  return json({ success: true, id, warnings: warnings.length ? warnings : undefined, message: warnings.length ? "已恢复，部分反向引用被新数据占用已跳过" : undefined });
}

export async function onRequestDelete({ request, env }) {
  const auth = await authAndRoute(request, env);
  if (auth.error) return auth.error;
  const { routeId } = auth;
  const url = new URL(request.url);
  const id = clean(url.searchParams.get("id"));
  if (!id) return json({ success: false, code: "ID_REQUIRED", error: "缺少运单 id" }, 400);
  const raw = await get(env, "waybill:trash:" + id);
  if (!raw) return json({ success: false, code: "TRASH_NOT_FOUND", error: "回收站中无此运单或已过期" }, 404);
  let w; try { w = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return json({ success: false, code: "TRASH_PARSE_FAILED", error: "回收站数据异常，已拒绝删除" }, 500); }
  if (!w || typeof w !== "object" || clean(w.routeId) !== routeId || !canWriteWaybill(auth.user, w, env)) return json({ success: false, code: "FORBIDDEN", error: "无权删除该运单" }, 403);

  const budget = new Budget();
  try {
    if (!budget.take(1)) throwBudget(budget);
    await command(env, ["DEL", trashMainKey(id)]);
    if (!budget.take(1)) throwBudget(budget);
    const scanned = await scanKeysBudgeted(env, trashChildPrefix(id) + "*", budget, { count: 500, cap: 5000 });
    if (scanned.complete) { for (const ck of scanned.keys) { if (!budget.take(1)) break; await command(env, ["DEL", ck]); } }
    else return json({ success: false, code: "PARTIAL_FAILURE", error: "彻底删除子键读取未完成，请重试" }, 503);
  } catch (e) {
    if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "彻底删除资源预算不足，请重试" }, 503);
    return json({ success: false, code: "TRASH_DELETE_FAILED", error: "彻底删除失败：" + (e?.message || "未知错误") }, 500);
  }
  return json({ success: true, id, message: "已彻底删除" });
}

function throwBudget(budget) { throw Object.assign(new Error("回收站操作资源预算不足"), { code: SUBREQUEST_BUDGET_EXCEEDED, max: budget.max }); }
