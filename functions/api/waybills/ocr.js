/**
 * 智配One · OCR 适配层
 * ------------------------------------------------------------------
 * 固定使用 AI Studio 托管的 PaddleOCR（PP-OCRv6），零自建、零运维。
 *
 * 环境变量：
 *   PADDLEOCR_ACCESS_TOKEN  必填，AI Studio 令牌
 *   PADDLEOCR_BASE_URL      可选，默认官方地址
 *
 * 流程：提交识别任务 → 轮询任务状态 → 拉取结果 JSON → 归一为行文本。
 */
const API_BASE = "https://paddleocr.aistudio-app.com";
const JOB_PATH = "/api/v2/ocr/jobs";
const MODEL = "PP-OCRv6";
const clean = v => String(v ?? "").trim();

function fail(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function collectText(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) { for (const x of value) collectText(x, out); return out; }
  if (typeof value !== "object") return out;
  for (const key of ["rec_texts", "recTexts", "texts", "text"]) {
    const v = value[key];
    if (Array.isArray(v)) for (const x of v) if (clean(x)) out.push(clean(x));
    else if (typeof v === "string" && clean(v)) out.push(clean(v));
  }
  for (const key of ["ocrResults", "ocr_results", "prunedResult", "pruned_result", "result", "pages"]) {
    if (value[key]) collectText(value[key], out);
  }
  return out;
}

async function requestJson(url, init, timeoutMs = 8000, abortSignal = null) {
  const controller = new AbortController();
  if (abortSignal) { try { abortSignal.addEventListener("abort", () => controller.abort()); } catch {} }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      if (abortSignal && abortSignal.aborted) throw fail("OCR_CANCELLED", "已取消识别");
      throw fail("OCR_NETWORK_TIMEOUT", "OCR服务响应超时");
    }
    throw e;
  } finally { clearTimeout(timer); }
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw fail("OCR_BAD_RESPONSE", "OCR服务返回格式异常"); }
  if (!r.ok) {
    const detail = data?.msg || data?.message || data?.error || text?.slice(0, 300) || "";
    throw fail(
      r.status === 401 || r.status === 403 ? "OCR_AUTH" : r.status === 404 ? "OCR_ENDPOINT" : "OCR_API",
      `OCR服务请求失败（HTTP ${r.status}）`,
      { status: r.status, detail }
    );
  }
  return data;
}

export async function recognizeImage(env, file, onProgress = () => {}, signal = null) {
  onProgress(0);
  const token = clean(env?.PADDLEOCR_ACCESS_TOKEN);
  if (!token) throw fail("OCR_NOT_CONFIGURED", "OCR服务尚未配置");
  const base = clean(env?.PADDLEOCR_BASE_URL) || API_BASE;

  const form = new FormData();
  form.append("model", MODEL);
  form.append("optionalPayload", JSON.stringify({
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useTextlineOrientation: false,
  }));
  form.append("file", file, file.name || "waybill");

  const timing = { ocrSubmitMs: 0, ocrStatusPollCount: 0, ocrStatusWaitMs: 0, ocrStatusRequestMs: 0, ocrResultFetchMs: 0, ocrResultFetchAttempts: 0 };
  let submitted;
  const submitStarted = Date.now();
  try {
    submitted = await requestJson(base + JOB_PATH, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      body: form,
    }, 10000, signal);
  } catch (e) {
    throw fail(e?.code || "OCR_API", e?.message || "OCR服务请求失败", { status: e?.status, detail: e?.detail, base });
  }

  timing.ocrSubmitMs = Date.now() - submitStarted;
  const jobId = clean(submitted?.data?.jobId);
  if (!jobId) throw fail("OCR_SUBMIT_FAILED", "OCR任务提交失败");
  onProgress(10);

  // 给 Cloudflare Worker 后续的提取、匹配、去重、规划和保存留出时间，避免 OCR 长时间占用整个同步请求。
  const deadline = Date.now() + 19000;
  let delay = 1500;
  while (Date.now() < deadline) {
    const waitStarted = Date.now();
    await new Promise(r => setTimeout(r, delay));
    timing.ocrStatusWaitMs += Date.now() - waitStarted;
    let status;
    const statusStarted = Date.now();
    try {
      status = await requestJson(
        base + JOB_PATH + "/" + encodeURIComponent(jobId),
        { headers: { Authorization: "Bearer " + token, Accept: "application/json" } },
        6000, signal
      );
      timing.ocrStatusPollCount++;
      timing.ocrStatusRequestMs += Date.now() - statusStarted;
    } catch (e) {
      timing.ocrStatusPollCount++;
      timing.ocrStatusRequestMs += Date.now() - statusStarted;
      throw fail(e?.code || "OCR_API", e?.message || "OCR服务请求失败", { status: e?.status, detail: e?.detail, jobId, base, ...timing });
    }

    const data = status?.data || {};
    const state = clean(data.state || data.status).toLowerCase();
    onProgress(state === "failed" || state === "error"
      ? 100
      : Math.min(90, 10 + Math.round(((Date.now() - (deadline - 19000)) / 19000) * 80)));

    if (state === "failed" || state === "error") {
      throw fail("OCR_JOB_FAILED", data.errorMsg || data.msg || "OCR识别失败", { jobId });
    }

    if (state === "done" || state === "completed" || data.resultUrl?.jsonUrl) {
      const STATUS_PATH = base + JOB_PATH + "/" + encodeURIComponent(jobId);
      const url0 = clean(data.resultUrl?.jsonUrl);
      if (!url0) throw fail("OCR_RESULT_MISSING", "OCR结果地址缺失", { jobId });

      // 结果 JSON 偶发读取抖动（AI Studio 慢/结果地址未同步）会让整单处理前功尽弃：
      // 最多尝试 3 次（每次 8s 超时，退避 0.8s/1.6s）。
      // HTTP 5xx/429/403/404 视为可重试，且下次尝试前重查任务状态刷新结果地址；网络超时保留原地址重试。
      const readResult = async (u) => {
        let rr;
        try {
          rr = await fetch(u, { signal: AbortSignal.timeout(8000) });
        } catch (e) {
          if (e?.name === "TimeoutError" || e?.name === "AbortError") {
            const err = fail("OCR_RESULT_TIMEOUT", "OCR结果读取超时", { jobId });
            err.retryable = true;
            throw err;
          }
          throw fail("OCR_RESULT_FETCH", "OCR结果读取失败", { jobId, detail: e?.message || "" });
        }
        if (!rr.ok) {
          const detail = await rr.text().catch(() => "");
          const err = fail("OCR_RESULT_FETCH", `OCR结果读取失败（HTTP ${rr.status}）`, { jobId, status: rr.status, detail: detail.slice(0, 300) });
          err.retryable = rr.status >= 500 || rr.status === 429 || rr.status === 403 || rr.status === 404;
          err.refreshUrl = err.retryable;
          throw err;
        }
        return rr;
      };
      const parseResult = async (rr) => {
        const raw = await rr.text();
        const texts = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try { collectText(JSON.parse(line), texts); } catch {}
        }
        const unique = [...new Set(texts)].filter(Boolean);
        const lowConfidence = unique.length < 3 || unique.join("").replace(/\s/g, "").length < 20;
        if (!unique.length) throw fail("OCR_EMPTY", "OCR未识别到文字", { jobId });
        onProgress(100);
        return { jobId, provider: "aistudio", model: MODEL, rawText: unique.join("\n"), lineCount: unique.length, lowConfidence };
      };

      let url = url0, lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, 800 * attempt));
        const resultStarted = Date.now();
        timing.ocrResultFetchAttempts++;
        try {
          if (attempt > 0 && lastError?.refreshUrl) {
            const again = await requestJson(STATUS_PATH, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } }, 6000);
            url = clean(again?.data?.resultUrl?.jsonUrl) || url;
          }
          const parsed = await parseResult(await readResult(url));
          timing.ocrResultFetchMs += Date.now() - resultStarted;
          return { ...parsed, ...timing };
        } catch (e) {
          timing.ocrResultFetchMs += Date.now() - resultStarted;
          lastError = e;
          if (!e?.retryable) throw e;
        }
      }
      throw lastError || fail("OCR_RESULT_FETCH", "OCR结果读取失败", { jobId });
    }
    delay = Math.min(5000, Math.round(delay * 1.35));
  }
  throw fail("OCR_TIMEOUT", "OCR识别超时，请稍后重试", { jobId });
}

export default { recognizeImage };
