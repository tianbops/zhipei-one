/**
 * 智配One · 运单处理 —— 落库族
 * ----------------------------------------------------------
 * 本文件由 process.js 按职责拆分而来（P1-1g，零改写）。
 * 依赖：_process-common.js（键构造/日期）。
 * 纪律：saveWaybill 先写主记录再补索引/事件/meta，任一步失败可带 requestId 重试
 *   （claimProcSave 幂等收口）；businessFingerprint / dailyWaybillKey 反引用
 *   仅在仍指向本单时清理，保护重传幂等。
 */

import {appendWaybillEvents} from "./_waybill-events.js";

export async function recordWaybillLifecycle(env, order, ctx) {
  const { requestId, rawExtractCount, extractCount, recoveredCount, matched, pending, d } = ctx;
  const events = [
    { event: "WAYBILL_CREATED", stage: "CREATED", requestId, routeId: order.routeId, userId: order.createdBy },
    { event: "EXTRACT_COMPLETED", stage: "EXTRACT", requestId, rawExtractCount, extractCount: order.diagnostics?.extractCount ?? order.stores.length, recoveredCount: order.diagnostics?.recoveredCount ?? 0, finalCount: order.stores.length },
    { event: "MATCH_COMPLETED", stage: "MATCH", requestId, matched: matched.filter(x => !x.pending).length, pending: pending.length },
    { event: "DEDUPE_COMPLETED", stage: "DEDUPE", requestId, before: matched.length, after: d.items.length, merged: d.merged },
    { event: "PLAN_COMPLETED", stage: "PLAN", requestId, count: order.stores.length },
    { event: "WAYBILL_SAVED", stage: "SAVED", requestId, id: order.id, qualityLevel: order.quality?.level, qualityFlags: order.quality?.flags || [] },
  ];
  await appendWaybillEvents(env, order.id, events);
}
