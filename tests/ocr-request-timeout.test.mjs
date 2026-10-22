import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 只为测试把模块内的请求辅助函数导出到临时 data: module；生产模块导出面不变。
const source = readFileSync(new URL("../functions/api/waybills/ocr.js", import.meta.url), "utf8");
assert.match(source, /const text = await r\.text\(\);[\s\S]*?finally\s*\{\s*clearTimeout\(timer\)/,
  "响应正文读取必须在超时计时器清理之前完成");
assert.match(source, /const readResult = async \(u\) => \{[\s\S]*?raw = await rr\.text\(\);[\s\S]*?const err = fail\("OCR_RESULT_TIMEOUT"[\s\S]*?err\.retryable = true;/,
  "OCR 结果正文超时必须归类为可重试的 OCR_RESULT_TIMEOUT");
assert.match(source, /let delay = 900;/, "首次状态轮询等待应缩短到 900ms");
assert.match(source, /const deadline = Date\.now\(\) \+ 19000;/, "首次轮询优化不得缩短整体 OCR 截止时间");
assert.match(source, /\}, 10000, signal\)/, "OCR 任务提交超时保持 10000ms");
assert.match(source, /\},\s*6000, signal\s*\)/, "OCR 状态请求超时保持 6000ms");
assert.match(source, /const refreshStarted = Date\.now\(\);[\s\S]*?finally\s*\{\s*timing\.ocrStatusPollCount\+\+;\s*timing\.ocrStatusRequestMs \+= Date\.now\(\) - refreshStarted;\s*\}/,
  "重试时刷新 OCR 结果地址必须单独计入状态请求耗时，失败时也要计时");
assert.match(source, /const resultStarted = Date\.now\(\);\s*timing\.ocrResultFetchAttempts\+\+;\s*try\s*\{\s*const parsed = await parseResult\(await readResult\(url\)\);/,
  "结果读取尝试计数必须只覆盖实际结果读取，不能包含结果地址刷新");
assert.match(source, /timing\.ocrResultFetchMs \+= Date\.now\(\) - resultStarted;\s*throw e;/,
  "结果读取失败也必须累计独立的结果读取耗时");
const testModule = source.replace("async function requestJson(", "export async function requestJson(");
assert.notEqual(testModule, source, "requestJson test hook target must exist");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(testModule).toString("base64");
const { requestJson } = await import(moduleUrl);

const originalFetch = globalThis.fetch;
try {
  // 模拟上游已返回响应头、正文却一直不结束；AbortSignal 必须仍能中断正文读取。
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      }, { once: true });
    },
  }));
  const timed = requestJson("https://ocr.example.invalid/result", {}, 20);
  await assert.rejects(
    Promise.race([
      timed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("body timeout was not enforced")), 250)),
    ]),
    error => error?.code === "OCR_NETWORK_TIMEOUT",
    "body read must fail with OCR_NETWORK_TIMEOUT instead of hanging"
  );

  // 自定义 HTTP 鉴权错误必须保留原分类，不能被误报为网络超时。
  globalThis.fetch = async () => new Response(JSON.stringify({ msg: "unauthorized" }), { status: 401 });
  await assert.rejects(
    requestJson("https://ocr.example.invalid/auth", {}, 100),
    error => error?.code === "OCR_AUTH" && error?.status === 401
  );

  // 调用前已取消必须立即终止，不再发出外部请求。
  const controller = new AbortController();
  controller.abort();
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  await assert.rejects(
    requestJson("https://ocr.example.invalid/cancel", {}, 100, controller.signal),
    error => error?.code === "OCR_CANCELLED"
  );
  assert.equal(called, false, "already-aborted request must not reach fetch");
  console.log("OCR request timeout regression tests passed.");
} finally {
  globalThis.fetch = originalFetch;
}
