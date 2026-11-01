/**
 * 智配One · 运单业务事件链（append-only，按运单 ID 维度）
 * ------------------------------------------------------------------
 * 设计目标（项目总控 1.1 · P1 #15/#18）：任何一张运单从创建到删除，
 * 每个关键阶段都留一条可追溯事件，用于故障排查与运维审计。
 *
 * 存储：zp:waybill:<id>:events（Redis List），RPUSH 追加，LTRIM 保留最近 1000 条。
 * 写入为 best-effort（失败不影响主流程），读取失败返回 []。
 */
import { command, pipeline } from "../_redis.js";
import { beijingISO } from "../_time.js";

const clean = v => String(v ?? "").trim();
const EV_KEY = id => "zp:waybill:" + clean(id) + ":events";

function eventRecord(evt) {
  const now = new Date();
  return { ...evt, t: now.toISOString(), tBeijing: beijingISO(now) };
}

/**
 * 追加一条运单事件。
 * @param {object} evt 至少含 event 字段；可含 stage/requestId/routeId/userId/waybillId/detail 等。
 */
export async function appendWaybillEvent(env, waybillId, evt) {
  try {
    const id = clean(waybillId);
    if (!id || !evt || !evt.event) return;
    const key = EV_KEY(id);
    const record = eventRecord(evt);
    await command(env, ["RPUSH", key, JSON.stringify(record)]);
    await command(env, ["LTRIM", key, "-1000", "-1"]);
  } catch {
    /* best-effort：事件链写入失败不影响主业务流程 */
  }
}

/**
 * 批量追加同一运单的有序生命周期事件。
 * Redis 使用单次 HTTP pipeline；D1 适配层在同一事务中批量提交。
 * 每条事件仍按 RPUSH → LTRIM 排列，保持原有事件顺序与 1000 条上限。
 * 失败只影响诊断事件，不影响已经成功的运单保存。
 */
export async function appendWaybillEvents(env, waybillId, events) {
  const id = clean(waybillId);
  if (!id || !Array.isArray(events) || !events.length) return 0;
  const key = EV_KEY(id);
  const commands = [];
  for (const evt of events) {
    if (!evt || !evt.event) continue;
    commands.push(["RPUSH", key, JSON.stringify(eventRecord(evt))]);
    commands.push(["LTRIM", key, "-1000", "-1"]);
  }
  if (!commands.length) return 0;
  try {
    await pipeline(env, commands);
    return commands.length / 2;
  } catch {
    /* best-effort：不回退逐条重试，避免网络结果不确定时重复追加事件 */
    return 0;
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

export default { appendWaybillEvent, appendWaybillEvents, listWaybillEvents };
