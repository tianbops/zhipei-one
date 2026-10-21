/**
 * 智配One · API 错误兜底与轻量性能观测
 * 所有经 guard 包装的 API 响应都会带 Server-Timing: app;dur=<ms> 与 X-ZP-Request-Id，
 * 便于浏览器 Network 面板区分「后端处理耗时」与「浏览器/网络等待」。
 * 仅增加响应头，不改变业务返回体、状态码、鉴权或 Redis 访问行为。
 */
import { json, withSecurityHeaders } from "./_json.js";

const REDIS_MARKERS = ["REDIS_NOT_CONFIGURED", "REDIS_ERROR", "REDIS_PIPELINE_ERROR"];
const BUDGET_MARKERS = ["SUBREQUEST_BUDGET_EXCEEDED"];

export function isDataStoreError(e) {
  const msg = String(e?.message || e || "");
  return REDIS_MARKERS.some(m => msg.startsWith(m));
}
export function isBudgetError(e) {
  const msg = String(e?.message || e || "");
  return BUDGET_MARKERS.some(m => msg.startsWith(m));
}
export function classify(e) {
  if (isDataStoreError(e)) {
    return { code: "DATA_STORE_UNAVAILABLE", status: 503,
      error: "数据服务暂时不可用，请稍后重试", detail: String(e?.message || e).slice(0, 180) };
  }
  if (isBudgetError(e)) {
    return { code: "REQUEST_BUDGET_EXCEEDED", status: 503,
      error: "本次请求需扫描的数据量超出平台单次上限，请缩小范围后重试",
      detail: String(e?.message || e).slice(0, 180) };
  }
  return { code: "INTERNAL_ERROR", status: 500,
    error: "服务处理失败，请稍后重试", detail: String(e?.message || e || "UNKNOWN_ERROR").slice(0, 180) };
}

function withTiming(response, startedAt) {
  if (!(response instanceof Response)) return response;
  // 安全头在这里统一补一次：Pages 的 _headers 对 Functions 响应无效，
  // 而登录成功这类返回是裸 new Response（没走 json()），是唯一能兜住它们的公共出口。
  const headers = withSecurityHeaders(response.headers);
  const elapsed = Math.max(0, Number((performance.now() - startedAt).toFixed(1)));
  const phaseTiming = headers.get("Server-Timing");
  headers.set("Server-Timing", (phaseTiming ? phaseTiming + ", " : "") + "app;dur=" + elapsed);
  // Request id 只用于把浏览器 Network 面板中的一次请求与诊断记录对应，不含用户信息。
  if (!headers.has("X-ZP-Request-Id")) headers.set("X-ZP-Request-Id", crypto.randomUUID());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * 包装 Pages Functions handler。只为响应添加轻量计时头；不修改业务 JSON。
 */
export function guard(handler, fallbackCode) {
  return async ctx => {
    const startedAt = performance.now();
    try {
      return withTiming(await handler(ctx), startedAt);
    } catch (e) {
      const info = classify(e);
      return withTiming(json({ success: false, code: fallbackCode || info.code, error: info.error, detail: info.detail }, info.status), startedAt);
    }
  };
}
export default { guard, classify, isDataStoreError };
