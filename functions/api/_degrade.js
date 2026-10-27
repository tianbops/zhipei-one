/**
 * 降级可观测（graceful degradation telemetry）
 * ------------------------------------------------------------------
 * 用途：给「刻意吞掉的异常」留下可取证的痕迹。
 *
 * 背景（2026-10-28）：
 *   项目里有一批 `catch{}` 属于**有意为之**（辅助数据失败不能回滚主数据），
 *   但全库原本**一条 console.warn 都没有** —— 意味着这些失败在线上完全不可见：
 *       · 全局学习写入失败 → 匹配率长期缓慢劣化，无人察觉；
 *       · 分布式锁释放失败 → 后续请求阻塞到 TTL，且没有任何告警；
 *       · 批量读取失败降级到 pipeline → 用户看到"空白"而不是错误。
 *   本工具把这类事件变成结构化、可聚合、可限频的告警，且不改变任何既有返回值与控制流。
 *
 * 设计约束（务必遵守）：
 *   1. **纯旁路**：调用它不得影响业务分支，也不得改变任何返回值。
 *   2. **自身绝不抛错**：任何内部异常都会被吞掉 —— 观测代码不许成为新的故障源。
 *   3. **限频**：同一 tag 在时间窗内只输出一次正文，其余累计为 suppressed 计数，
 *      避免热点异常打爆日志配额（Workers Logs 按量计费）。
 *   4. 输出为单行 JSON，便于 Cloudflare Logpush / `wrangler tail` 用等级字段过滤。
 */

// 同 tag 的抑制窗口：这段时间内重复命中只累计计数，不重复打印正文。
const WINDOW_MS = 60_000;
// 单个 isolate 内最多保留多少个 tag 的计数状态，防止 Map 无界增长。
const MAX_TAGS = 200;

/** tag -> { ts: 首次打印时间戳, hits: 窗口内命中数, printed: 已打印的累计次数 } */
const state = new Map();

/**
 * 把任意异常值压成一段安全的文本。
 * 层层降级：message 字符串 → 自身是字符串 → JSON → Object#toString，
 * 任何一层失败都不会抛出（观测代码必须比被测代码更耐脏）。
 */
function errText(error) {
  try {
    const raw = typeof error === "string" ? error : error?.message;
    if (typeof raw === "string") return raw.slice(0, 300);
    if (error == null) return "";
    try {
      return String(JSON.stringify(error)).slice(0, 300);
    } catch {
      // 循环引用等无法序列化的对象
      return Object.prototype.toString.call(error);
    }
  } catch {
    return "";
  }
}

function trimIfNeeded() {
  if (state.size <= MAX_TAGS) return;
  // 淘汰最久未更新的一半，保证热点 tag 的计数不丢
  const rows = [...state.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < Math.floor(rows.length / 2); i++) state.delete(rows[i][0]);
}

/**
 * 上报一次「已被吞掉的降级事件」。
 *
 * @param {string} tag       稳定事件名，建议 "模块.动作"，如 "learning.repair-failed"
 * @param {unknown} error    被捕获的异常（可以是任意值）
 * @param {object} [ctx]     附加上下文，禁止放入密码/令牌/完整运单正文
 * @returns {{printed:boolean, hits:number}} 仅供测试断言使用，业务代码无需关心返回值
 */
export function degraded(tag, error, ctx) {
  // 观测代码自身绝不能影响业务
  try {
    const now = Date.now();
    let s = state.get(tag);
    if (!s || now - s.ts > WINDOW_MS) {
      const prevHits = s && now - s.ts <= WINDOW_MS ? s.hits : 0;
      s = { ts: now, hits: prevHits + 1, printed: (s?.printed || 0) + 1 };
      state.set(tag, s);
      trimIfNeeded();
      emit({
        level: "warn",
        kind: "degraded",
        tag,
        error: errText(error),
        ...(ctx || {}),
        // 上一窗口被抑制的次数，用于判断是偶发还是持续故障
        suppressedInPrevWindow: Math.max(0, prevHits),
      });
      return { printed: true, hits: s.hits };
    }
    s.hits += 1;
    return { printed: false, hits: s.hits };
  } catch {
    return { printed: false, hits: 0 };
  }
}

function emit(payload) {
  try {
    console.warn(JSON.stringify(payload));
  } catch {
    /* 观测失败也必须静默：不得影响业务流程 */
  }
}

/** 仅供测试：清空限频状态。 */
export function __resetDegradeState() {
  state.clear();
}
