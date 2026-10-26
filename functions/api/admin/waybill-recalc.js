/* 一次性运维接口：按当前提取/匹配/去重/规划逻辑重算**指定运单**的门店结果。
   ------------------------------------------------------------------
   用途：修复旧版本代码遗留的脏数据（例如「表头 + 门店」粘成一条超长脏名，
   在匹配阶段与干净名冲突，导致 pending 卡在 PLANNED）。
   安全策略：
     - 仅 system_admin / admin 可调用；
     - **默认 dryRun=true**：只返回 before/after 对比，不写库；
     - 显式 apply=true 才写：写前把原记录备份到 zp:waybill:{id}:backup:{ts}（保留 30 天）；
     - 只覆盖 stores / stage / summary / diagnostics 等派生字段，id、rawText、date、
       vehicle、requestId、createdAt 等原始字段一律不动；
     - 写后重算当日汇总（门店数/重量变化必须同步 meta）。
   只处理单张运单，不提供批量入口（批量需另行评估）。
*/
import { json, body } from "../_json.js";
import { currentUser } from "../_auth.js";
import { get, command } from "../_redis.js";
import { extract } from "../waybills/_process-extract.js";
import { splitByRouteBase, dedupe, plan } from "../waybills/_process-plan.js";
import { matchStores } from "../waybills/_store-match-engine.js";
import { recomputeDayMeta } from "../waybills/_waybill-meta.js";

const isAdmin = u => u && (u.role === "system_admin" || u.role === "admin");

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ success: false, code: "AUTH_REQUIRED", error: "未登录" }, 401);
  if (!isAdmin(user)) return json({ success: false, code: "PERMISSION_DENIED", error: "仅管理员可重算运单" }, 403);

  const input = await body(request);
  const waybillId = String(input?.waybillId || "").trim();
  const apply = input?.apply === true;
  if (!waybillId) return json({ success: false, code: "WAYBILL_ID_REQUIRED", error: "缺少运单ID" }, 400);

  // 注意：get() 内部会加 PREFIX("zp:")，此处不能再带前缀（否则变成 zp:zp:waybill:*）
  const raw = await get(env, "waybill:" + waybillId);
  if (!raw) return json({ success: false, code: "WAYBILL_NOT_FOUND", error: "运单不存在" }, 404);
  let order;
  try { order = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {
    return json({ success: false, code: "WAYBILL_BAD_JSON", error: "运单数据格式异常" }, 500);
  }
  if (!order || typeof order !== "object") return json({ success: false, code: "WAYBILL_BAD_DATA", error: "运单数据异常" }, 500);

  const baseRaw = await get(env, "route:" + order.routeId + ":base");
  let baseStores = [];
  if (baseRaw) {
    try {
      const b = typeof baseRaw === "string" ? JSON.parse(baseRaw) : baseRaw;
      if (b && Array.isArray(b.stores)) baseStores = b.stores;
    } catch { /* 基准损坏时按无基准处理，由全局学习兜底 */ }
  }

  const rawText = String(order.rawText || "");
  if (!rawText.trim()) return json({ success: false, code: "NO_RAW_TEXT", error: "该运单没有原始文本，无法重算" }, 422);

  const extracted = extract(rawText);
  const rawCount = extracted.stores.length;
  const split = splitByRouteBase(extracted.stores, baseStores);
  const matched = matchStores(split, baseStores);
  const d = dedupe(matched);
  const planned = plan(d.items, baseStores.length > 0);
  const pending = planned.filter(x => x.pending).length;

  const storeBrief = list => (list || []).map((s, i) => ({
    index: i + 1,
    rawName: String(s.rawName || ""),
    name: String(s.name || ""),
    storeId: s.storeId || null,
    pending: !!s.pending,
    routeOrder: s.routeOrder ?? null,
  }));

  const before = {
    stage: order.stage || null,
    total: Array.isArray(order.stores) ? order.stores.length : 0,
    pending: Number(order.summary?.pending) || 0,
    dirty: (order.stores || []).filter(s => /运单列表|运输日期|总数量|车牌号|承运订单/.test(String(s.rawName || s.name || ""))).length,
    stores: storeBrief(order.stores),
  };
  const after = {
    stage: pending ? "PLANNED" : "CONFIRMED",
    total: planned.length,
    pending,
    dirty: planned.filter(s => /运单列表|运输日期|总数量|车牌号|承运订单/.test(String(s.rawName || s.name || ""))).length,
    stores: storeBrief(planned),
    counts: { rawCount, splitCount: split.length, matchedCount: matched.filter(x => !x.pending).length, dedupeMerged: d.merged },
  };

  if (!apply) {
    return json({ success: true, dryRun: true, waybillId, before: { ...before, stores: before.stores.slice(0, 6) }, after: { ...after, stores: after.stores.slice(0, 6) } });
  }

  // ---- 写库（可回滚）----
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupKey = "zp:waybill:" + waybillId + ":backup:" + ts;
  try {
    await command(env, ["SET", backupKey, typeof raw === "string" ? raw : JSON.stringify(raw), "EX", String(30 * 24 * 3600)]);
  } catch (e) {
    return json({ success: false, code: "BACKUP_FAILED", error: "备份原运单失败，已中止（未做任何修改）", detail: String(e?.message || e) }, 500);
  }

  const next = {
    ...order,
    stores: planned.map((s, i) => ({ ...s, routeOrder: i + 1 })),
    stage: pending ? "PLANNED" : "CONFIRMED",
    summary: {
      ...(order.summary || {}),
      total: planned.length,
      matched: planned.length - pending,
      pending,
      correction: planned.filter(x => x.correction).length,
    },
    diagnostics: {
      ...(order.diagnostics || {}),
      recalculatedAt: new Date().toISOString(),
      recalculatedBy: user.id,
      recalcBefore: { stage: before.stage, total: before.total, pending: before.pending, dirty: before.dirty },
      recalcAfter: { stage: pending ? "PLANNED" : "CONFIRMED", total: planned.length, pending, dirty: after.dirty },
    },
  };
  if (!pending) {
    next.confirmedAt = order.confirmedAt || new Date().toISOString();
    next.confirmedBy = order.confirmedBy || user.id;
  }

  try {
    await command(env, ["SET", "zp:waybill:" + waybillId, JSON.stringify(next)]);
  } catch (e) {
    return json({ success: false, code: "SAVE_FAILED", error: "写回运单失败（原记录已备份）", backupKey, detail: String(e?.message || e) }, 500);
  }
  let meta = null;
  try { meta = await recomputeDayMeta(env, next.routeId, next.date); } catch { /* meta 可稍后重算 */ }

  return json({
    success: true, dryRun: false, waybillId, backupKey,
    before: { stage: before.stage, total: before.total, pending: before.pending, dirty: before.dirty },
    after: { stage: next.stage, total: planned.length, pending, dirty: after.dirty },
    meta,
  });
}
