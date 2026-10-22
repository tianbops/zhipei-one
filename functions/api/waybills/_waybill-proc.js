/**
 * 智配One · 运单处理状态机（实时上传任务 / Processing Ticket）
 * ------------------------------------------------------------------
 * 设计目标（项目总控 1.1 · P1 #17/#18 失败恢复）：
 *   一张运单从"上传→OCR→提取→匹配→去重→规划→保存"是长任务（尤其 OCR 流式识别）。
 *   此前任何环节失败都只是返回一段错误 JSON，没有可追溯的"进行中/失败/超时/已取消"状态，
 *   用户一旦中途断网或 OCR 超时，只能卡在"正在识别…"无法恢复。
 *
 *   本模块为每次 process 请求维护一张"处理票据"（proc ticket），落库 Redis、带 TTL：
 *     PROCESSING →（成功）DONE ｜（OCR 超时）TIMEOUT ｜（其它失败）FAILED ｜（用户取消）CANCELLED
 *   票据携带 recoverable / action / hint / detail，供前端直接给出可执行的恢复入口，
 *   供运维按 requestId 统一诊断（P1.5）。
 *
 *   注意：这是"实时处理任务"的状态机，与"已落库运单"的 stage(PLANNED/CONFIRMED/SUPERSEDED)
 *   是两套正交维度 —— 运单只在成功保存后才落库，失败时只有这张票据可见，避免脏运单污染索引/去重。
 *   全为新增键 zp:waybill:proc:<requestId>，best-effort 写入，不影响主流程，TTL 自动清理孤儿票据（无 Redis 重建）。
 */
import { command } from "../_redis.js";

const clean = v => String(v ?? "").trim();
const PROC_TTL = 15 * 60; // 15 分钟；TTL 是「垃圾回收时间」，只负责清理孤儿票据，不承担业务状态判定
// 业务实时状态阈值（访问时判定，见 effectiveStage）：0–3min PROCESSING / 3–5min STALLED / >5min TIMEOUT
// 阈值最终按真实 OCR（PP-OCRv6）耗时校准，先以 3/5 分钟为初值。
export const PROC_STALLED_MS = 3 * 60 * 1000;
export const PROC_TIMEOUT_MS = 5 * 60 * 1000;
export const PROC_STAGES = ["PROCESSING", "STALLED", "TIMEOUT", "FAILED", "CANCELLED", "DONE"];
const procKey = requestId => "zp:waybill:proc:" + clean(requestId);

// 保存竞态保护：PROCESSING 票据只有在“保存声明”尚未建立时才允许被取消。
// cancel 与 claim 都在 Redis EVAL 内完成，二者谁先成功谁决定最终时序：
//   CANCELLED 先成功 → 后续保存声明失败；
//   SAVE_CLAIMED 先成功 → 取消不再抢占，保存完成后 DONE 胜出。
const claimSaveScript = `local raw=redis.call("GET",KEYS[1]); if not raw then return 0 end; local ok,rec=pcall(cjson.decode,raw); if not ok or type(rec)~="table" then return 0 end; if rec.stage=="CANCELLED" or rec.stage=="DONE" then return 0 end; if rec.saveClaimedAt then return 1 end; rec.saveClaimedAt=ARGV[1]; rec.updatedAt=ARGV[1]; redis.call("SET",KEYS[1],cjson.encode(rec),"EX",ARGV[2]); return 1`;
const cancelScript = `local raw=redis.call("GET",KEYS[1]); if not raw then return 0 end; local ok,rec=pcall(cjson.decode,raw); if not ok or type(rec)~="table" then return 0 end; if rec.stage=="DONE" or rec.saveClaimedAt then return 0 end; rec.stage="CANCELLED"; rec.recoverable=true; rec.action=ARGV[1]; rec.hint=ARGV[2]; rec.detail=ARGV[3]; rec.updatedAt=ARGV[4]; redis.call("SET",KEYS[1],cjson.encode(rec),"EX",ARGV[5]); return 1`;

function nowISO() { return new Date().toISOString(); }

/** 写入初始 PROCESSING 票据。best-effort：失败不影响主流程。 */
export async function beginProc(env, { requestId, routeId, userId, fileName = null }) {
  if (!requestId) return null;
  const rec = {
    requestId,
    routeId: clean(routeId),
    userId: clean(userId),
    fileName: fileName ? String(fileName) : null,
    stage: "PROCESSING",
    waybillId: null,
    startedAt: nowISO(),
    updatedAt: nowISO(),
    recoverable: false,
    action: null,
    hint: null,
    detail: null,
    timing: null,
  };
  try {
    await command(env, ["SET", procKey(requestId), JSON.stringify(rec), "EX", String(PROC_TTL)]);
  } catch { /* best-effort */ }
  return rec;
}

/** 更新票据状态（失败/超时/取消）。best-effort。 */
export async function failProc(env, requestId, patch) {
  if (!requestId) return null;
  try {
    const raw = await command(env, ["GET", procKey(requestId)]);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec) return null;

    // 终态保护：取消或已完成的票据不能被迟到的失败路径覆盖。
    // 特别是保存声明已经建立后，客户端断开/取消与后端保存失败可能交错：
    //   SAVE_CLAIMED + save failure -> FAILED（允许恢复）
    //   SAVE_CLAIMED + late CANCELLED -> 不允许改写
    //   DONE -> 永远保持 DONE
    if (rec.stage === "DONE") return rec;
    if (rec.stage === "CANCELLED" && !patch.force) return rec;

    const next = {
      ...rec,
      stage: patch.stage || "FAILED",
      recoverable: patch.recoverable !== undefined ? !!patch.recoverable : false,
      action: patch.action || null,
      hint: patch.hint || null,
      detail: patch.detail || null,
      timing: patch.timing && typeof patch.timing === "object" && !Array.isArray(patch.timing) ? patch.timing : rec.timing || null,
      order: patch.order || null,
      updatedAt: nowISO(),
    };
    if (patch.waybillId) next.waybillId = patch.waybillId;
    await command(env, ["SET", procKey(requestId), JSON.stringify(next), "EX", String(PROC_TTL)]);
    return next;
  } catch { return null; }
}

/**
 * 在正式保存前原子声明“保存权”。
 * 返回 false 表示该请求已经被取消/完成，调用方不得进入保存 EVAL。
 */
export async function claimProcSave(env, requestId) {
  if (!requestId) return false;
  try {
    const result = await command(env, ["EVAL", claimSaveScript, "1", procKey(requestId), nowISO(), String(PROC_TTL)]);
    return Number(result) === 1;
  } catch { return false; }
}

/**
 * 客户端取消的原子处理。若保存声明已经建立，则取消让位给保存，最终由 DONE 胜出。
 */
export async function cancelProc(env, requestId, { action = "REPROCESS", hint = "本次处理已取消，可重新上传运单", detail = null } = {}) {
  if (!requestId) return false;
  try {
    const result = await command(env, ["EVAL", cancelScript, "1", procKey(requestId), action, hint, detail || "", nowISO(), String(PROC_TTL)]);
    return Number(result) === 1;
  } catch { return false; }
}

/** 读取票据（运维/前端按 requestId 诊断）。 */
export async function getProc(env, requestId) {
  if (!requestId) return null;
  try {
    const raw = await command(env, ["GET", procKey(requestId)]);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return null; }
}

/** 成功：标记 DONE 并关联 waybillId。 */
export async function finishProc(env, requestId, waybillId) {
  if (!requestId) return null;
  try {
    const raw = await command(env, ["GET", procKey(requestId)]);
    const rec = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (!rec) return null;
    if (rec.stage === "CANCELLED") return rec;
    const next = { ...rec, stage: "DONE", waybillId: waybillId || null, updatedAt: nowISO() };
    await command(env, ["SET", procKey(requestId), JSON.stringify(next), "EX", String(PROC_TTL)]);
    return next;
  } catch { return null; }
}

/**
 * 访问时有效阶段：孤儿 PROCESSING（updatedAt 超阈值）在视图/诊断上重分类为 STALLED/TIMEOUT，
 * 避免「永久 PROCESSING」污染诊断统计。仅用于视图，不写回存储（存储终态仍由 failProc 落库）。
 * @param {{stage?:string, updatedAt?:string}} proc
 * @param {number} now 当前时间戳(ms)
 * @returns {string|null}
 */
export function effectiveStage(proc, now = Date.now()) {
  if (!proc) return null;
  if (proc.stage !== "PROCESSING") return proc.stage;
  const updated = proc.updatedAt ? Date.parse(proc.updatedAt) : NaN;
  const age = Number.isFinite(updated) ? now - updated : 0; // 缺失 updatedAt（仅测试种子）视为新鲜：不误判 TIMEOUT
  if (age >= PROC_TIMEOUT_MS) return "TIMEOUT";
  if (age >= PROC_STALLED_MS) return "STALLED";
  return "PROCESSING";
}

export default { beginProc, failProc, getProc, finishProc, claimProcSave, cancelProc, effectiveStage, PROC_STALLED_MS, PROC_TIMEOUT_MS, PROC_STAGES };
