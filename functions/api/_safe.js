/**
 * 智配One · API 错误兜底（1.1 可靠性）
 * ------------------------------------------------------------------
 * 背景（2026-10-06 生产事件）：运单诊断列表因超出 Cloudflare Workers 子请求上限而崩溃，
 * 前端只能拿到一个毫无信息的裸 `500`，排障成本极高。
 *
 * 目标：任何未被业务逻辑捕获的异常，都必须变成**可分诊**的结构化响应：
 *   - Redis / 数据服务类失败 → 503 + DATA_STORE_UNAVAILABLE（对用户是「稍后重试」，不该展示内部细节）
 *   - 其余服务端异常       → 500 + INTERNAL_ERROR（附带截断 detail，便于定位，不外泄凭据）
 * 且**不向上抛出**，避免 Pages Functions 返回 HTML 错误页导致前端 JSON 解析失败。
 */
import { json } from "./_json.js";

const REDIS_MARKERS = ["REDIS_NOT_CONFIGURED", "REDIS_ERROR", "REDIS_PIPELINE_ERROR"];

/** 判定是否为数据服务（Redis/Upstash）类失败 */
export function isDataStoreError(e) {
  const msg = String(e?.message || e || "");
  return REDIS_MARKERS.some(m => msg.startsWith(m));
}

/** 把异常规整为 {code,error,detail,status} */
export function classify(e) {
  if (isDataStoreError(e)) {
    return { code: "DATA_STORE_UNAVAILABLE", status: 503,
      error: "数据服务暂时不可用，请稍后重试", detail: String(e?.message || e).slice(0, 180) };
  }
  return { code: "INTERNAL_ERROR", status: 500,
    error: "服务处理失败，请稍后重试", detail: String(e?.message || e || "UNKNOWN_ERROR").slice(0, 180) };
}

/**
 * 包装 Pages Functions 的 onRequest* handler：捕获未处理异常并返回结构化 JSON。
 * 用法：export const onRequestGet = guard(async ({request,env}) => { ... });
 */
export function guard(handler, fallbackCode) {
  return async ctx => {
    try { return await handler(ctx); }
    catch (e) {
      const info = classify(e);
      return json({ success: false, code: fallbackCode || info.code, error: info.error, detail: info.detail }, info.status);
    }
  };
}

export default { guard, classify, isDataStoreError };
