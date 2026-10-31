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

// 保留失败前已完成的阶段计时，便于通过 requestId 诊断超时和外部服务错误。
function withTiming(error, timing) {
  if (error && typeof error === "object") Object.assign(error, timing);
  return error;
}

// 保留 PaddleOCR 原生逐行证据；不保存可视化图片、Base64 或远端临时 URL。
export function collectLineEvidence(value, out = [], limit = 500) {
  if (!value || out.length >= limit) return out;
  if (Array.isArray(value)) { for (const item of value) collectLineEvidence(item, out, limit); return out; }
  if (typeof value !== "object") return out;
  const texts = Array.isArray(value.rec_texts) ? value.rec_texts : (Array.isArray(value.recTexts) ? value.recTexts : null);
  if (texts) {
    const scores = Array.isArray(value.rec_scores) ? value.rec_scores : (Array.isArray(value.recScores) ? value.recScores : []);
    const polys = Array.isArray(value.rec_polys) ? value.rec_polys : (Array.isArray(value.recPolys) ? value.recPolys : []);
    const boxes = Array.isArray(value.rec_boxes) ? value.rec_boxes : (Array.isArray(value.recBoxes) ? value.recBoxes : []);
    for (let i = 0; i < texts.length && out.length < limit; i++) {
      const text = clean(texts[i]); if (!text) continue;
      const n = scores[i] == null || scores[i] === "" ? null : Number(scores[i]);
      const score = Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
      const polygon = Array.isArray(polys[i]) && polys[i].length
        ? polys[i].slice(0, 8).map(point => Array.isArray(point) ? point.slice(0, 2).map(Number) : []) : null;
      const box = Array.isArray(boxes[i]) && boxes[i].length >= 4 ? boxes[i].slice(0, 4).map(Number) : null;
      out.push({ text: text.slice(0, 240), score, polygon, box });
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (["ocrImage","inputImage","docPreprocessingImage","preprocessedImages","image","images"].includes(key)) continue;
    if (child && typeof child === "object") collectLineEvidence(child, out, limit);
    if (out.length >= limit) break;
  }
  return out;
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
  if (abortSignal?.aborted) throw fail("OCR_CANCELLED", "已取消识别");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (abortSignal) {
    // 处理调用前已取消的请求，也避免监听器在请求结束后残留。
    if (abortSignal.aborted) controller.abort();
    else {
      try { abortSignal.addEventListener("abort", onAbort, { once: true }); } catch {}
    }
  }
  // 超时必须覆盖 fetch 响应头和响应正文读取；否则上游只返回响应头、正文卡住时会失去超时保护。
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...(init || {}), signal: controller.signal });
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
  } catch (e) {
    // 自定义业务错误（HTTP 状态、JSON 格式）不能被误报成网络超时。
    if (String(e?.code || "").startsWith("OCR_")) throw e;
    if (controller.signal.aborted) {
      if (abortSignal?.aborted) throw fail("OCR_CANCELLED", "已取消识别");
      throw fail("OCR_NETWORK_TIMEOUT", "OCR服务响应超时");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (abortSignal) {
      try { abortSignal.removeEventListener("abort", onAbort); } catch {}
    }
  }
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

  const timing = { ocrSubmitMs: 0, ocrStatusPollCount: 0, ocrStatusWaitMs: 0, ocrStatusRequestMs: 0, ocrResultFetchMs: 0, ocrResultFetchWaitMs: 0, ocrResultFetchAttempts: 0 };
  let submitted;
  const submitStarted = Date.now();
  try {
    submitted = await requestJson(base + JOB_PATH, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      body: form,
    }, 10000, signal);
  } catch (e) {
    timing.ocrSubmitMs = Date.now() - submitStarted;
    throw fail(e?.code || "OCR_API", e?.message || "OCR服务请求失败", { status: e?.status, detail: e?.detail, base, ...timing });
  }

  timing.ocrSubmitMs = Date.now() - submitStarted;
  const jobId = clean(submitted?.data?.jobId);
  if (!jobId) throw fail("OCR_SUBMIT_FAILED", "OCR任务提交失败", { ...timing });
  onProgress(10);

  // 给 Cloudflare Worker 后续的提取、匹配、去重、规划和保存留出时间，避免 OCR 长时间占用整个同步请求。
  const deadline = Date.now() + 19000;
  // 首次状态检查提前到 900ms；19 秒截止时间、单次超时与后续退避策略保持不变。
  let delay = 900;
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
      throw fail("OCR_JOB_FAILED", data.errorMsg || data.msg || "OCR识别失败", { jobId, ...timing });
    }

    if (state === "done" || state === "completed" || data.resultUrl?.jsonUrl) {
      const STATUS_PATH = base + JOB_PATH + "/" + encodeURIComponent(jobId);
      const url0 = clean(data.resultUrl?.jsonUrl);
      if (!url0) throw fail("OCR_RESULT_MISSING", "OCR结果地址缺失", { jobId, ...timing });

      // 结果 JSON 偶发读取抖动（AI Studio 慢/结果地址未同步）会让整单处理前功尽弃：
      // 最多尝试 3 次（每次 8s 超时，退避 0.8s/1.6s）。
      // HTTP 5xx/429/403/404 视为可重试，且下次尝试前重查任务状态刷新结果地址；网络超时保留原地址重试。
      const readResult = async (u) => {
        let rr, raw;
        try {
          // 8 秒超时同时覆盖响应头和正文读取；正文卡住也必须进入可重试的超时分支。
          rr = await fetch(u, { signal: AbortSignal.timeout(8000) });
          raw = await rr.text();
        } catch (e) {
          if (e?.name === "TimeoutError" || e?.name === "AbortError") {
            const err = fail("OCR_RESULT_TIMEOUT", "OCR结果读取超时", { jobId });
            err.retryable = true;
            throw err;
          }
          throw fail("OCR_RESULT_FETCH", "OCR结果读取失败", { jobId, detail: e?.message || "" });
        }
        if (!rr.ok) {
          const err = fail("OCR_RESULT_FETCH", `OCR结果读取失败（HTTP ${rr.status}）`, { jobId, status: rr.status, detail: raw.slice(0, 300) });
          err.retryable = rr.status >= 500 || rr.status === 429 || rr.status === 403 || rr.status === 404;
          err.refreshUrl = err.retryable;
          throw err;
        }
        return raw;
      };
      const parseResult = async (raw) => {
        const texts = [];
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try { collectText(JSON.parse(line), texts); } catch {}
        }
        const unique = [...new Set(texts)].filter(Boolean);
        const lineEvidence = [];
        for (const line of raw.split(/\\r?\\n/)) {
          if (!line.trim() || lineEvidence.length >= 500) continue;
          try { collectLineEvidence(JSON.parse(line), lineEvidence, 500); } catch {}
        }
        const lowConfidence = unique.length < 3 || unique.join("").replace(/\\s/g, "").length < 20;
        if (!unique.length) throw fail("OCR_EMPTY", "OCR未识别到文字", { jobId });
        onProgress(100);
        return { jobId, provider: "aistudio", model: MODEL, rawText: unique.join("\\n"), lineCount: unique.length, lowConfidence, lineEvidence };
      };

      let url = url0, lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) { const retryWait = 800 * attempt; const waitStarted = Date.now(); await new Promise(r => setTimeout(r, retryWait)); timing.ocrResultFetchWaitMs += Date.now() - waitStarted; }
        try {
          // 刷新结果地址属于状态请求，单独计时；不能混入结果 JSON 读取耗时。
          // 刷新失败也必须走统一错误出口，保留已有阶段计时。
          if (attempt > 0 && lastError?.refreshUrl) {
            const refreshStarted = Date.now();
            try {
              const again = await requestJson(STATUS_PATH, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } }, 6000);
              url = clean(again?.data?.resultUrl?.jsonUrl) || url;
            } finally {
              timing.ocrStatusPollCount++;
              timing.ocrStatusRequestMs += Date.now() - refreshStarted;
            }
          }
          const resultStarted = Date.now();
          timing.ocrResultFetchAttempts++;
          try {
            const parsed = await parseResult(await readResult(url));
            timing.ocrResultFetchMs += Date.now() - resultStarted;
            return { ...parsed, ...timing };
          } catch (e) {
            timing.ocrResultFetchMs += Date.now() - resultStarted;
            throw e;
          }
        } catch (e) {
          lastError = e;
          if (!e?.retryable) throw withTiming(e, timing);
        }
      }
      throw withTiming(lastError || fail("OCR_RESULT_FETCH", "OCR结果读取失败", { jobId }), timing);
    }
    delay = Math.min(5000, Math.round(delay * 1.35));
  }
  throw fail("OCR_TIMEOUT", "OCR识别超时，请稍后重试", { jobId, ...timing });
}

export default { recognizeImage };
