import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 只为测试把模块内的请求辅助函数导出到临时 data: module；生产模块导出面不变。
const source = readFileSync(new URL("../functions/api/waybills/ocr.js", import.meta.url), "utf8");
const processSource = readFileSync(new URL("../functions/api/waybills/process.js", import.meta.url), "utf8");
const adminDiagnosticsSource = readFileSync(new URL("../js/admin/diagnostics.js", import.meta.url), "utf8");
const fieldEvidenceSource = readFileSync(new URL("../functions/api/waybills/_ocr-field-evidence.js", import.meta.url), "utf8");
assert.match(processSource, /associateFieldEvidence[\\s\\S]*?fieldEvidence/ ,
  "运单处理必须把 OCR 行证据关联到提取字段");
assert.match(processSource, /fieldEvidence}:null/ ,
  "字段证据必须随 OCR 诊断信息持久化");
const { associateFieldEvidence } = await import(new URL("../functions/api/waybills/_ocr-field-evidence.js", import.meta.url));
const fieldEvidenceFixture = associateFieldEvidence({
  fields: { date: "2026-10-31", vehicle: "渝DK7692", driver: "田波", deliveryPerson: "陈兴亚", totalWeight: 7.52 },
  stores: [{ rawName: "江北区鸿恩寺客服中心", name: "江北区鸿恩寺客服中心" }, { rawName: "未识别门店", name: "未识别门店" }],
  lineEvidence: [
    { imageIndex: 1, text: "运输日期：2026年10月31日", score: 0.96, box: [1, 2, 30, 12] },
    { imageIndex: 1, text: "车牌：渝 D K 7692", score: 0.91, box: [2, 3, 40, 13] },
    { imageIndex: 2, text: "司机：田波", score: 0.88 },
    { imageIndex: 2, text: "送货员：陈兴亚", score: 0.84 },
    { imageIndex: 2, text: "总重量 7.52 吨", score: 0.81 },
    { imageIndex: 2, text: "江北区鸿恩寺客服中心", score: 0.93 }
  ]
});
assert.equal(fieldEvidenceFixture.fields.find(x => x.field === "date").source, "ocr");
assert.equal(fieldEvidenceFixture.fields.find(x => x.field === "date").evidence[0].imageIndex, 1);
assert.equal(fieldEvidenceFixture.fields.find(x => x.field === "vehicle").evidence[0].score, 0.91);
assert.equal(fieldEvidenceFixture.fields.find(x => x.field === "totalWeight").source, "ocr");
assert.equal(fieldEvidenceFixture.stores[0].source, "ocr");
assert.equal(fieldEvidenceFixture.stores[1].source, "unavailable", "无对应识别行时必须明确标记证据缺失");
const manualEvidence = associateFieldEvidence({
  fields: { vehicle: "渝DK7692" },
  lineEvidence: [{ text: "渝DK7692", score: 0.99 }],
  manualFields: ["vehicle"]
});
assert.equal(manualEvidence.fields.find(x => x.field === "vehicle").source, "manual",
  "用户表单覆盖值应标记为人工来源，不能伪装成 OCR 证据");

assert.match(processSource, /ocrResultFetchWaitMs:results\.reduce\(\(n,x\)=>n\+\(Number\(x\.ocrResultFetchWaitMs\)\|\|0\),0\)/,
  "成功处理时必须汇总 OCR 结果读取重试等待");
assert.match(processSource, /ocrResultFetchWaitMs:ocr\.ocrResultFetchWaitMs/,
  "成功运单必须保存 OCR 结果读取重试等待");
assert.match(adminDiagnosticsSource, /ocrResultFetchWaitMs:"结果重试等待"/,
  "按 requestId 查询时必须显示结果读取重试等待");
assert.match(adminDiagnosticsSource, /\["结果重试等待","ocrResultFetchWaitMs"\]/,
  "线路/日期运单诊断也必须显示结果读取重试等待");
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
assert.match(source, /ocrResultFetchWaitMs: 0/,
  "OCR 结果重试等待必须有独立计时字段");
assert.match(source, /const retryWait = 800 \* attempt;[\s\S]*?timing\.ocrResultFetchWaitMs \+= Date\.now\(\) - waitStarted;/,
  "结果读取重试的退避等待必须独立计时");
assert.match(source, /export function collectLineEvidence[\s\S]*?rec_scores[\s\S]*?rec_polys[\s\S]*?rec_boxes/,
  "OCR 适配层必须保留 PP-OCRv6 逐行分数与文本框证据");
assert.match(processSource, /lineEvidence:results\.flatMap[\s\S]*?imageIndex:imageIndex\+1/,
  "多图 OCR 证据必须保留图片来源索引");
assert.match(processSource, /lineEvidence:Array\.isArray\(ocr\.lineEvidence\)\?ocr\.lineEvidence:\[\]/,
  "逐行证据必须随运单记录保存");

const testModule = source.replace("async function requestJson(", "export async function requestJson(");
assert.notEqual(testModule, source, "requestJson test hook target must exist");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(testModule).toString("base64");
const { requestJson, collectLineEvidence } = await import(moduleUrl);

const evidenceFixture = {
  result: { ocrResults: [{ prunedResult: {
    rec_texts: ["渝DK7692", "总重量 7.52 吨"],
    rec_scores: [0.97, "0.81"],
    rec_polys: [[[1, 2], [30, 2], [30, 12], [1, 12]], [[2, 20], [40, 20], [40, 30], [2, 30]]],
    rec_boxes: [[1, 2, 30, 12], [2, 20, 40, 30]]
  }}]}
};
const evidence = collectLineEvidence(evidenceFixture);
assert.equal(evidence.length, 2, "应按识别行提取证据");
assert.equal(evidence[0].text, "渝DK7692");
assert.equal(evidence[0].score, 0.97);
assert.deepEqual(evidence[0].box, [1, 2, 30, 12]);
assert.equal(evidence[1].score, 0.81, "字符串形式的分数也应规范化");
assert.equal(collectLineEvidence(evidenceFixture, [], 1).length, 1, "证据数量必须受上限保护");
assert.equal(collectLineEvidence({rec_texts:["无分数"]})[0].score, null, "缺失分数不能伪造为高置信度");

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
