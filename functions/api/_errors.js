/**
 * 智配One · 统一错误出口（审计报告 P0-5）
 * ------------------------------------------------------------------
 * 目的：把"内部异常细节"和"可给用户看的业务文案"分开，避免把
 * Redis / SQLite / Worker 的原始报错与 `error.stack` 发给客户端。
 *
 * 判定口径：
 *   · 域内错误（domain error）= 抛出时自带本系统定义的错误码
 *     （如 STORE_IDENTITY_CONFLICT、BASE_NOT_FOUND、OCR_TIMEOUT），
 *     这类 error.message 是给用户看的中文业务提示，可以透传。
 *   · 未预期异常（unexpected）= 无 code、或 code 以 _INTERNAL_ /
 *     _UNHANDLED_ 结尾、或是运行时/网络原始异常，其 message 可能含
 *     键名、SQL、堆栈片段 —— 一律只回通用文案，细节只进服务端日志。
 *
 * 纪律：
 *   1. **任何**响应体不得出现 `error.stack`；
 *   2. 未预期异常的原文只能出现在 `console.error` 里（Workers 日志）；
 *   3. 新端点请用 clientMessage / clientDetail，不要直接写 e?.message。
 */

/** 本系统错误码命名空间；命中才认为是"可透传文案"的域内错误 */
const DOMAIN_CODE_RE =
  /^(OCR|CONFIRM|BASE|STORE|WAYBILL|PROCESS|LEARNING|ROUTE|DISPATCH|HISTORY|DATA|AUTH|ADMIN|INVITE|SESSION|USER|IMPORT|EXPORT|RECALC|SYNC|LOCK|PERF|SCHEMA|MIGRATION|D1)_[A-Z0-9_]+$/;

/** 这些后缀表示"兜底捕获点"自身产生的码，语义就是"未知内部错误"，不可透传 */
const INTERNAL_MARK_RE = /_(INTERNAL|UNHANDLED)_/;

/** 把任意抛出物（含非 Error）转成短文本，避免 String() 抛二次异常 */
function rawText(error) {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message) return error.message;
  try {
    return String(error);
  } catch {
    return "";
  }
}

/** 是否属于可透传文案的域内错误 */
export function isDomainError(error) {
  const code = String(error?.code || "");
  if (!DOMAIN_CODE_RE.test(code)) return false;
  return !INTERNAL_MARK_RE.test(code);
}

/**
 * 给客户端的错误文案：域内错误用其自身中文提示，其余一律用 fallback。
 * @param {unknown} error 捕获到的异常
 * @param {string} fallback 通用文案（不得含任何内部信息）
 */
export function clientMessage(error, fallback) {
  if (!isDomainError(error)) return fallback;
  return rawText(error) || fallback;
}

/**
 * 可选的 detail 字段：只对域内错误透出，且强制截断。
 * 未预期异常返回空串（调用方拼进响应体也不会泄露）。
 */
export function clientDetail(error, limit = 200) {
  if (!isDomainError(error)) return "";
  const text = rawText(error);
  return text ? String(text).slice(0, limit) : "";
}

/**
 * 服务端留痕：完整 message + stack 只写 console.error，不返回给客户端。
 * 用 JSON 单行输出，便于 Workers 日志按字段过滤。
 */
export function logServerError(scope, error, extra = {}) {
  try {
    console.error(
      JSON.stringify({
        level: "error",
        scope,
        code: error?.code || null,
        message: rawText(error).slice(0, 500),
        stack: typeof error?.stack === "string" ? error.stack : null,
        ...extra,
      })
    );
  } catch {
    /* 日志失败不得影响主流程 */
  }
}
