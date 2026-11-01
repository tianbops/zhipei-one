import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 只为测试把模块内的请求辅助函数导出到临时 data: module；生产模块导出面不变。
const source = readFileSync(new URL("../functions/api/waybills/ocr.js", import.meta.url), "utf8");
const processSource = readFileSync(new URL("../functions/api/waybills/process.js", import.meta.url), "utf8");
const adminDiagnosticsSource = readFileSync(new URL("../js/admin/diagnostics.js", import.meta.url), "utf8");
assert.match(adminDiagnosticsSource, /fieldEvidenceHtml/,
  "管理员运单诊断必须展示字段证据关联");
assert.match(adminDiagnosticsSource, /lineIndex/,
  "管理员诊断必须通过行索引读取原始 OCR 证据");
assert.match(adminDiagnosticsSource, /模型分数/,
  "管理员诊断展示原始模型分数时必须明确其为模型分数");
assert.match(adminDiagnosticsSource, /门店未关联原文/,
  "管理员诊断必须指出缺少原文关联的门店");
assert.match(adminDiagnosticsSource, /const allMissingStoreEvidence=fieldEvidence[\s\S]*?\.slice\(0,30\)/,
  "复制诊断必须保留最多 30 条完整未关联门店清单");
assert.match(adminDiagnosticsSource, /const missingStoreEvidence=allMissingStoreEvidence\.slice\(0,8\)/,
  "页面紧凑展示仍限制为前 8 条，避免改变现有页面密度");
assert.match(adminDiagnosticsSource, /另有[\s\S]*?条[\s\S]*?复制诊断/,
  "页面必须提示未关联门店清单还有多少条，并提示复制完整诊断");
assert.match(adminDiagnosticsSource, /门店未关联原文：["']?\+allMissingStoreEvidence\.join/,
  "复制诊断必须导出完整未关联门店清单，而不是页面前 8 条");
assert.match(adminDiagnosticsSource, /\.\.\.fieldEvidenceLines/,
  "复制诊断时必须包含字段证据内容");

const fieldEvidenceSource = readFileSync(new URL("../functions/api/waybills/_ocr-field-evidence.js", import.meta.url), "utf8");
assert.match(fieldEvidenceSource, /export function associateFieldEvidence/,
  "字段证据关联模块必须导出纯函数");
assert.match(processSource, /associateFieldEvidence[\s\S]*?fieldEvidence/,
  "运单处理必须把 OCR 行证据关联到提取字段");
assert.match(processSource, /fieldEvidence}:null/,
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
assert.equal(fieldEvidenceFixture.fields.find(x => x.field === "vehicle").evidence[0].lineIndex, 1);
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
assert.match(adminDiagnosticsSource, /ocrResultRequestMs:"结果请求累计"/,
  "按 requestId 查询时必须拆分结果请求耗时");
assert.match(adminDiagnosticsSource, /ocrResultBodyMs:"正文读取累计"/,
  "按 requestId 查询时必须拆分响应正文读取耗时");
assert.match(adminDiagnosticsSource, /ocrResultParseMs:"结果解析累计"/,
  "按 requestId 查询时必须拆分 OCR 结果解析耗时");
assert.match(adminDiagnosticsSource, /ocrImageCount:"OCR图片数"/,
  "诊断必须展示多图 OCR 图片数，避免把累计请求次数误认为重试次数");
assert.match(adminDiagnosticsSource, /多图 OCR 的提交、状态和结果耗时为各图片累计值/,
  "诊断必须解释多图计时是累计值而非墙钟等待时间");
assert.match(adminDiagnosticsSource, /\["结果重试等待","ocrResultFetchWaitMs"\]/,
  "线路/日期运单诊断也必须显示结果读取重试等待");
assert.match(source, /const text = await r\.text\(\);[\s\S]*?finally\s*\{\s*clearTimeout\(timer\)/,
  "响应正文读取必须在超时计时器清理之前完成");
assert.match(source, /const readResult = async \(u\) => \{[\s\S]*?raw = await rr\.text\(\);[\s\S]*?const err = fail\("OCR_RESULT_TIMEOUT"[\s\S]*?err\.retryable = true;/,
  "OCR 结果正文超时必须归类为可重试的 OCR_RESULT_TIMEOUT");
assert.match(source, /let delay = 500;/, "首次状态轮询等待应缩短到 500ms，以减少已完成任务的固定等待");
assert.match(source, /const OCR_STATUS_DEADLINE_MS = 30000;[\s\S]*?const deadline = Date\.now\(\) \+ OCR_STATUS_DEADLINE_MS;/,
  "OCR 状态等待窗口应扩展到 30 秒，并由单一常量驱动截止时间");
assert.match(source, /Math\.max\(1, Math\.min\(6000, remainingMs\)\), signal/,
  "每次状态请求超时必须受整个 OCR 截止时间的剩余预算约束");
assert.match(source, /setTimeout\(r, Math\.min\(delay, Math\.max\(0, deadline - Date\.now\(\)\)\)\)/,
  "轮询等待不得越过 OCR 总截止时间");
assert.match(source, /e\?\.code === "OCR_NETWORK_TIMEOUT" && Date\.now\(\) >= deadline/,
  "最后一次状态请求耗尽截止预算时应统一归类为 OCR_TIMEOUT");
assert.match(source, /\}, 10000, signal\)/, "OCR 任务提交超时保持 10000ms");
assert.match(source, /Math\.max\(1, Math\.min\(6000, remainingMs\)\)/, "OCR 状态请求单次超时上限保持 6000ms，并受剩余预算约束");
assert.match(source, /ocrResultRequestMs: 0/,
  "OCR 结果请求阶段必须独立计时");
assert.match(source, /ocrResultBodyMs: 0/,
  "OCR 响应正文读取阶段必须独立计时");
assert.match(source, /ocrResultParseMs: 0/,
  "OCR 结果解析阶段必须独立计时");
assert.match(source, /timing\.ocrResultChars \+= raw\.length/,
  "OCR 结果大小必须按字符数记录，不保存原文内容");
assert.match(processSource, /ocrResultRequestMs:results\.reduce/,
  "多图 OCR 请求阶段计时必须汇总");
assert.match(processSource, /ocrResultBodyMs:results\.reduce/,
  "多图 OCR 正文读取计时必须汇总");
assert.match(processSource, /ocrResultParseMs:results\.reduce/,
  "多图 OCR 解析计时必须汇总");
assert.match(processSource, /ocrImageCount:ocr\.imageCount/,
  "运单诊断必须持久化 OCR 图片数");
assert.match(source, /ocrResultFetchWaitMs: 0/,
  "OCR 结果重试等待必须有独立计时字段");
assert.match(source, /export function collectLineEvidence[\s\S]*?rec_scores[\s\S]*?rec_polys[\s\S]*?rec_boxes/,
  "OCR 适配层必须保留 PP-OCRv6 逐行分数与文本框证据");
assert.match(processSource, /lineEvidence:results\.flatMap[\s\S]*?imageIndex:imageIndex\+1/,
  "多图 OCR 证据必须保留图片来源索引");
assert.match(processSource, /lineEvidence:Array\.isArray\(ocr\.lineEvidence\)\?ocr\.lineEvidence:\[\]/,
  "逐行证据必须随运单记录保存");

const parseResultBlock = source.match(/const parseResult = async \(raw\) => \{([\s\S]*?)\n      \};/)?.[1] || "";
assert.ok(parseResultBlock, "OCR 结果解析函数必须存在");
assert.equal((parseResultBlock.match(/JSON\.parse\(/g) || []).length, 1,
  "每行 JSONL 必须只 JSON.parse 一次，同时提取文本与行证据");
assert.equal((parseResultBlock.match(/raw\.split\(/g) || []).length, 1,
  "OCR 结果必须只拆行遍历一次");
assert.match(parseResultBlock, /collectText[\s\S]*?collectLineEvidence/,
  "单次遍历必须同时保留文本和原始行证据提取");
assert.match(parseResultBlock, /new Set\(/,
  "文本去重必须保留且保持首次出现顺序");

const testModule = source.replace("async function requestJson(", "export async function requestJson(").replace("function collectText(", "export function collectText(");
assert.notEqual(testModule, source, "requestJson test hook target must exist");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(testModule).toString("base64");
const { requestJson, collectLineEvidence, collectText } = await import(moduleUrl);
const stringTextResult = collectText({ text: "单字段字符串识别结果" });
assert.deepEqual(stringTextResult, ["单字段字符串识别结果"], "OCR 适配器必须保留字符串格式的 text 字段");
assert.deepEqual(collectText({ texts: ["数组行一", "数组行二"] }), ["数组行一", "数组行二"], "修复字符串分支不得影响数组行");
assert.deepEqual(collectText({ result: { text: "嵌套字符串结果" } }), ["嵌套字符串结果"], "必须保留嵌套对象中的字符串识别结果");

const paddleResponseFixture = {
  result: {
    rec_texts: ["车牌：渝DK7692", "总重量：7.52吨"],
    rec_scores: [0.987, 0.812],
    rec_polys: [
      [[10, 20], [110, 20], [110, 48], [10, 48]],
      [[12, 60], [90, 60], [90, 88], [12, 88]]
    ],
    rec_boxes: [[10, 20, 110, 48], [12, 60, 90, 88]],
    inputImage: "must-not-be-copied"
  }
};
const collectedOcrLines = collectLineEvidence(paddleResponseFixture);
assert.equal(collectedOcrLines.length, 2, "应从嵌套 PP-OCR 响应中提取逐行结果");
assert.equal(collectedOcrLines[0].text, "车牌：渝DK7692");
assert.equal(collectedOcrLines[0].score, 0.987);
assert.deepEqual(collectedOcrLines[0].box, [10, 20, 110, 48]);
assert.deepEqual(collectedOcrLines[0].polygon, [[10, 20], [110, 20], [110, 48], [10, 48]]);
assert.equal(JSON.stringify(collectedOcrLines).includes("must-not-be-copied"), false,
  "OCR 证据不能包含输入图片或 Base64 内容");
const aliasOcrLines = collectLineEvidence({
  recTexts: ["司机：田波"],
  recScores: ["0.9"],
  recPolys: [[[1, 2], [3, 2], [3, 4]]]
});
assert.equal(aliasOcrLines[0].score, 0.9, "应兼容驼峰字段别名");
assert.equal(aliasOcrLines[0].box, null, "没有边界框时必须保留为空");
assert.equal(collectLineEvidence({ rec_texts: ["越界分数"], rec_scores: [1.5] })[0].score, null,
  "超出 0–1 的分数不得当作有效置信度");
assert.equal(collectLineEvidence({ rec_texts: ["A", "B", "C"] }, [], 2).length, 2,
  "逐行证据必须遵守数量上限");

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

// Monotonic timing assertions: Date.now is reserved for absolute deadlines, never elapsed durations.
assert.match(source,/const ocrPerfNow\s*=/);
assert.match(source,/const ocrPerfDuration\s*=/);
for(const marker of ["submitStarted","waitStarted","statusStarted","requestStarted","bodyStarted","refreshStarted","resultStarted","parseStarted"]){assert.match(source,new RegExp("const "+marker+" = ocrPerfNow\\(\\)"),marker+" must use monotonic start time");assert.match(source,new RegExp("ocrPerfDuration\\("+marker+"\\)"),marker+" must use monotonic elapsed time");}
assert.match(source,/finally\s*\{\s*\/\/ Count each result-read attempt exactly once[\s\S]*?ocrResultFetchMs \+= ocrPerfDuration\(resultStarted\)/,"result read attempt timing must be counted once on success and failure");

assert.match(source,/const refreshStarted = ocrPerfNow\(\);[\s\S]*?timing\.ocrStatusRequestMs \+= ocrPerfDuration\(refreshStarted\)/,"retry URL refresh must use monotonic timing");
assert.match(source,/const resultStarted = ocrPerfNow\(\);[\s\S]*?finally \{[\s\S]*?ocrResultFetchMs \+= ocrPerfDuration\(resultStarted\)/,"each result read attempt must be timed once");
assert.match(source,/timing\.ocrResultRequestMs \+= ocrPerfDuration\(requestStarted\)/,"result request timing includes failures");
assert.match(source,/timing\.ocrResultBodyMs \+= ocrPerfDuration\(bodyStarted\)/,"result body timing includes failures");
assert.match(source,/ocrResultFetchWaitMs \+= ocrPerfDuration\(waitStarted\)/,"retry backoff uses monotonic timing");
