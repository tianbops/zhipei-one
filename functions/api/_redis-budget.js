/**
 * 智配One · 统一子请求预算（1.1 架构级根治 · P1.5 收口）
 * ------------------------------------------------------------------
 * 背景（2026-10-06 ~ 2026-10-07 生产事故链）：诊断列表 / 一致性巡检 / 运营统计 / 线路删除
 * 四条读路径都曾因「Redis 子请求数 O(N)」突破 Cloudflare Workers 每请求约 50 的子请求上限，
 * 各自抛异常、各自得到不同的裸错误（Error 1101 / 500）。事后每处都补了自己的预算逻辑——
 * 但四份实现各写各的 makeBudget / scanKeys / mget* / smembers*，常量与「complete 语义」都不统一，
 * 于是「再有一处读路径忘记预算」就成了第 5 次复发的温床。
 *
 * 本模块是**唯一**的预算真相源（single source of truth）：
 *   - Budget           每请求一个，take(n)/canTake(n)/remaining/exhausted
 *   - scanKeysBudgeted 预算受控 SCAN（每次迭代 = 1 子请求；超预算 / 超迭代上限立即停并报 complete=false）
 *   - mgetBatchMap      MGET 分批（N 子请求压成 ceil(N/BATCH)），返回 Map
 *   - mgetBatchList     MGET 分批，返回与入参同序的数组
 *   - smembersBatch     pipeline SMEMBERS 分批，返回 Map
 *   - createScopedClient 硬上限客户端：任何 read 入口用它包裹 command/pipeline/scan，
 *                       超出即抛 SUBREQUEST_BUDGET_EXCEEDED（被 _safe.js 兜底成 503），
 *                       从架构上保证「没有读路径能静默越过平台硬限」。
 *
 * 约定：SCAN 一次迭代 = 1 子请求（游标分页，真实 Workers 成本）；pipeline = 1 子请求
 * （Upstash 把 N 条命令打包进 1 个 HTTP 请求）；MGET 一批 = 1 子请求。与现网运维口径一致。
 *
 * 任何新增读路径都应从这里 import，不要再手写一份预算逻辑。
 */
import { command, pipeline } from "./_redis.js";

// ====== 共享常量（与历史四处实现对齐，集中在此一处维护）======
export const SUBREQUEST_LIMIT = 40;   // 留 10 给鉴权 / 日志 / 响应
export const SCAN_COUNT = 500;        // 单次 SCAN 覆盖的槽位数，越大迭代越少（一次迭代 = 一次子请求）
export const KEY_CAP = 5000;          // 单模式返回键上限，防御内存与 CPU 时间
export const MGET_BATCH = 100;
export const PIPELINE_BATCH = 50;

export const SUBREQUEST_BUDGET_EXCEEDED = "SUBREQUEST_BUDGET_EXCEEDED";

/**
 * 每请求子请求预算计数器。
 * 注意：take 失败只置 exhausted=true 并返回 false；是否「截断并降级」由调用方决定
 * （一致性巡检 / 统计选择 degraded，硬上限客户端选择抛错）。
 */
export class Budget {
  constructor(max = SUBREQUEST_LIMIT) {
    this.max = max;
    this.used = 0;
    this.exhausted = false;
  }
  /** 是否还能再占用 n 个预算（不扣减） */
  canTake(n = 1) {
    n = Math.max(0, Math.floor(n));
    return this.used + n <= this.max;
  }
  /** 占用 n 个预算；不够则标记 exhausted 并返回 false（调用方应主动截断/降级） */
  take(n = 1) {
    n = Math.max(0, Math.floor(n));
    if (this.used + n > this.max) { this.exhausted = true; return false; }
    this.used += n;
    return true;
  }
  get remaining() { return Math.max(0, this.max - this.used); }
}

/** 抛出统一的「子请求预算耗尽」错误（被 _safe.js 兜底成结构化 503） */
export function throwBudgetExceeded(max, context) {
  throw Object.assign(
    new Error(SUBREQUEST_BUDGET_EXCEEDED + (context ? " " + context : "") + " max=" + max),
    { code: SUBREQUEST_BUDGET_EXCEEDED, max }
  );
}

/**
 * 预算受控 SCAN：每次迭代 = 1 个子请求。
 * 迭代超 iterCap、或预算不足、或单模式键数超 cap 时立即停止并声明 complete=false，
 * 绝不把 worker 拖到平台硬限（避免 Cloudflare Error 1101）。
 * @returns {{keys:string[], complete:boolean}}
 */
export async function scanKeysBudgeted(env, pattern, budget, { count = SCAN_COUNT, cap = KEY_CAP, iterCap = Infinity } = {}) {
  const keys = [];
  let complete = true;
  let cursor = "0";
  let iter = 0;
  do {
    if (iter >= iterCap || !budget.take(1)) { complete = false; break; }
    const r = await command(env, ["SCAN", cursor, "MATCH", pattern, "COUNT", String(count)]);
    cursor = String(r?.[0] ?? "0");
    iter++;
    for (const k of Array.isArray(r?.[1]) ? r[1] : []) {
      keys.push(String(k));
      if (keys.length >= cap) { cursor = "0"; complete = false; break; }
    }
  } while (cursor !== "0");
  return { keys, complete };
}

/** 批量 MGET：N 个子请求压成 ceil(N/BATCH)，返回 Map(key -> raw) */
export async function mgetBatchMap(env, keys, budget, { batch = MGET_BATCH } = {}) {
  const out = new Map();
  let complete = true;
  if (!keys.length) return { map: out, complete };
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    if (!budget.take(1)) { complete = false; break; }
    const raws = await command(env, ["MGET", ...chunk]);
    for (let j = 0; j < chunk.length; j++) out.set(chunk[j], Array.isArray(raws) ? raws[j] : null);
  }
  return { map: out, complete };
}

/** 批量 MGET：返回与入参同序的 raw 数组（聚合循环用） */
export async function mgetBatchList(env, keys, budget, { batch = MGET_BATCH } = {}) {
  const out = [];
  let complete = true;
  if (!keys.length) return { list: out, complete };
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    if (!budget.take(1)) { complete = false; break; }
    const raws = await command(env, ["MGET", ...chunk]);
    for (const r of (Array.isArray(raws) ? raws : [])) out.push(r);
  }
  return { list: out, complete };
}

/** 批量 SMEMBERS：pipeline 一次请求跑多条命令，返回 Map(key -> string[]) */
export async function smembersBatch(env, keys, budget, { batch = PIPELINE_BATCH } = {}) {
  const out = new Map();
  let complete = true;
  if (!keys.length) return { map: out, complete };
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    if (!budget.take(1)) { complete = false; break; }
    const res = await pipeline(env, chunk.map(k => ["SMEMBERS", k]));
    for (let j = 0; j < chunk.length; j++) out.set(chunk[j], Array.isArray(res?.[j]) ? res[j] : []);
  }
  return { map: out, complete };
}

/**
 * 硬上限客户端：把 command / pipeline / scan 全部纳入同一预算，超出即抛。
 * 用于「希望一次性失败而非降级」的读入口（如管理台批量导出）；
 * 一致性巡检 / 统计等需要「尽量多扫、不够就 degraded」的路径仍用上面的 Budget + 助手显式控制。
 * 抛出的错误会被 _safe.js 兜底为 503 REQUEST_BUDGET_EXCEEDED。
 */
export function createScopedClient(env, max = SUBREQUEST_LIMIT) {
  const budget = new Budget(max);
  const gate = () => { if (!budget.take(1)) throwBudgetExceeded(max); };
  return {
    budget,
    command: async (parts) => { gate(); return command(env, parts); },
    pipeline: async (cmds) => { gate(); return pipeline(env, cmds); },
    /** 预算受控 SCAN：迭代越限即抛，绝不把 worker 拖到平台硬限 */
    scan: async (pattern, opts) => {
      const { keys, complete } = await scanKeysBudgeted(env, pattern, budget, opts);
      if (!complete) throwBudgetExceeded(max, "SCAN");
      return keys;
    },
  };
}

export default {
  Budget, SUBREQUEST_BUDGET_EXCEEDED, throwBudgetExceeded,
  scanKeysBudgeted, mgetBatchMap, mgetBatchList, smembersBatch, createScopedClient,
  SUBREQUEST_LIMIT, SCAN_COUNT, KEY_CAP, MGET_BATCH, PIPELINE_BATCH,
};
