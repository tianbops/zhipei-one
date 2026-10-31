/**
 * 智配One · 运单业务事件链（append-only，按运单 ID 维度）
 * ------------------------------------------------------------------
 * 设计目标（项目总控 1.1 · P1 #15/#18）：任何一张运单从创建到删除，
 * 每个关键阶段都留一条可追溯事件，用于故障排查与运维审计。
 *
 *   事件类型（非技术词，内部使用）：
 *     WAYBILL_CREATED / EXTRACT_COMPLETED / MATCH_COMPLETED /
 *     DEDUPE_COMPLETED / PLAN_COMPLETED / WAYBILL_SAVED /
 *     WAYBILL_IDEMPOTENT / CONFIRM_STARTED / CONFIRM_COMPLETED /
 *     LEARNING_COMPLETED / WAYBILL_SUPERSEDED / WAYBILL_DELETED
 *
 * 存储：zp:waybill:<id>:events（Redis List），RPUSH 追加，LTRIM 保留最近 1000 条。
 * 写入为 best-effort（失败不影响主流程），读取失败返回 [].
 */
import { command } from "../_redis.js";
import { beijingISO } from "../_time.js";

const clean = v => String(v ?? "").trim();
const EV_KEY = id => "zp:waybill:" + clean(id) + ":events";

/**
 * 追加一条运单事件。
 * @param {object} evt 至少含 event 字段；可含 stage/requestId/routeId/userId/waybillId/detail 等。
 */
export async function appendWaybillEvent(env, waybillId, evt) {
  try {
    const id = clean(waybillId);
    if (!id || !evt || !evt.event) return;
    const now = new Date();
    const record = { t: now.toISOString(), tBeijing: beijingISO(now), ...evt };
    await command(env, ["RPUSH", EV_KEY(id), JSON.stringify(record)]);
    await command(env, ["LTRIM", EV_KEY(id), "-1000", "-1"]);
  } catch {
    /* best-effort：事件链写入失败不影响主业务流程 */
  }
}

/** 读取运单事件链（旧→新）。 */
export async function listWaybillEvents(env, waybillId) {
  try {
    const raw = await command(env, ["LRANGE", EV_KEY(clean(waybillId)), "0", "-1"]);
    if (!Array.isArray(raw)) return [];
    return raw
      .map(x => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default { appendWaybillEvent, listWaybillEvents };
