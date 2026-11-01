import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ingest=readFileSync(new URL("../functions/api/perf-event.js",import.meta.url),"utf8");
const report=readFileSync(new URL("../functions/api/perf-report.js",import.meta.url),"utf8");
assert.match(ingest,/PAGES = new Set/);
assert.match(ingest,/ENDPOINTS = new Set/);
assert.match(ingest,/origin !== requestUrl.origin/);
assert.match(ingest,/body.events.length > 25/);
assert.match(ingest,/request.text\(\)/);
assert.match(ingest,/TextEncoder\(\)/);
assert.match(ingest,/1209600/);
assert.match(ingest,/"zp:perf:hour:"/);
assert.match(ingest,/"zp:perf:ingest-rate:"/);
assert.match(ingest,/allowedPhases/);
for(const phase of ["waybill-server-base-lookup","waybill-server-base-index","waybill-server-base-wait","waybill-server-base-overlap"])assert.ok(ingest.includes('"'+phase+'"'),phase+" must be accepted by telemetry");
assert.match(ingest,/phaseBase\.\."sum"/);
assert.match(report,/metric\.startsWith\("phase:"\)/);
assert.match(report,/avgMs=phase\.count/);
assert.doesNotMatch(ingest,/request\.headers\.get\(["']cookie|authorization|x-forwarded-for/i);
assert.match(report,/user.role!=="admin" && user.role!=="system_admin"/);
assert.match(report,/HGETALL/);
assert.match(report,/windowHours:24/);

// ---- 账户接口细分 + HTTP 状态码聚合 ----
assert.match(ingest,/api-account-me/);
assert.match(ingest,/api-account-settings/);
assert.match(ingest,/api-account-other/);
assert.match(ingest,/for i=1,#ARGV,8 do/,"每事件新增状态码参数后，Lua 步长必须同步为 8");
assert.match(ingest,/local cd=base\.\."code:"/,"非 2xx 必须按 code:<状态码> 细分聚合");
assert.match(ingest,/status=="4xx" or status=="5xx"/,"状态码细分只应用于 4xx/5xx（network 没有状态码）");
assert.match(ingest,/statusCode >= 100 && statusCode < 600/);
assert.match(report,/metric\.startsWith\("code:"\)/,"报告需能解析状态码细分字段");
assert.match(report,/parts\.length<4/,"字段名已变为可变段数，不能再用固定 4 段解析");
console.log("Anonymous performance telemetry safeguards passed.");

// ---- D1 路由指标展示口径 ----
const adminHtml=readFileSync(new URL("../admin.html",import.meta.url),"utf8");
assert.match(adminHtml,/D1 路由统计口径/);
assert.match(adminHtml,/读结果元数据条数/);
assert.match(adminHtml,/不等于独立 SQL 请求数或用户请求数/);
assert.match(adminHtml,/一次 batch 可能返回多条结果/);


// D1 路由计数必须与毫秒耗时分开展示，避免把结果记录数误读为耗时。
const perfUi=readFileSync(new URL("../js/admin/perf.js",import.meta.url),"utf8");
assert.match(perfUi,/isD1RoutingMetric/);
assert.match(perfUi,/D1 读路由统计 · 结果记录数/);
assert.match(perfUi,/条\/次/);
assert.match(perfUi,/累计 .* 条结果记录/);
assert.match(perfUi,/name\.startsWith\("history-"\)&&!name\.startsWith\("history-waybill-"\)&&!isD1RoutingMetric\(name\)/);
assert.match(perfUi,/name\.startsWith\("history-waybill-"\)/);
assert.match(perfUi,/esc\(phaseLabel\(name\)\)/);
assert.match(perfUi,/运单上传与处理阶段耗时/);
assert.match(perfUi,/前12项/);
assert.match(perfUi,/filter\(\(\[name\]\)=>isD1RoutingMetric\(name\)\)/);


// ---- 完整响应与页面就绪 / 运单流式处理遥测 ----
for(const endpoint of ["api-waybill-process","home-today-ready-cache","home-today-ready-network","home-history-ready-cache","home-history-ready-network"])assert.ok(ingest.includes('"'+endpoint+'"'),endpoint+" must be accepted by the telemetry endpoint");
assert.match(ingest,/const storedName = name\.startsWith\("waybill-"\) \? "history-" \+ name : name/,"waybill phases must map into the existing registered Lua namespace");
assert.ok(report.includes("[a-z0-9-]+$"),"report must preserve waybill timing phases");
const perfDiag=readFileSync(new URL("../js/perf-diagnostics.js",import.meta.url),"utf8");
const perfUiLabels=readFileSync(new URL("../js/admin/perf.js",import.meta.url),"utf8");
for(const label of ["线路基准读取耗时","线路基准索引编译耗时","OCR 后基准剩余等待","OCR 期间重叠耗时"])assert.ok(perfUiLabels.includes(label),label+" must be understandable in the admin performance view");
assert.match(perfDiag,/window\.zpPerfRecord/);
assert.match(perfDiag,/p===\"\/api\/waybills\/process\"/);
assert.match(perfDiag,/response\[methodName\]/,"JSON/body timing must wait for the actual response body reader");
const upload=readFileSync(new URL("../js/home/upload-process.js",import.meta.url),"utf8");
const today=readFileSync(new URL("../js/home/today.js",import.meta.url),"utf8");
const monthly=readFileSync(new URL("../js/home-monthly.js",import.meta.url),"utf8");
assert.match(upload,/api-waybill-process/);
assert.match(upload,/waybill-server-total/);
for(const phase of ["waybill-server-base-lookup","waybill-server-base-index","waybill-server-base-wait","waybill-server-base-overlap"])assert.ok(upload.includes('"'+phase+'"'),phase+" must be emitted by upload telemetry");
assert.match(upload,/perfStreamComplete/);
assert.match(today,/home-today-ready-cache/);
assert.match(today,/home-today-ready-network/);
assert.match(monthly,/home-history-ready-cache/);
assert.match(monthly,/home-history-ready-network/);

// AbortError 与 TimeoutError 不得再混入 network。\nassert.match(ingest,/"network","abort","timeout"/);\nassert.match(perfDiag,/classifyFetchFailure/);\nassert.match(perfDiag,/name==="TimeoutError"/);\nassert.match(perfDiag,/name==="AbortError"/);\n
// The streaming OCR path records abort and timeout independently of generic fetch telemetry.
assert.match(upload,/perfFailureStatus/);
assert.match(upload,/\?"timeout":"abort"/);
assert.match(upload,/perfFailureStatus="timeout"/);
assert.match(upload,/perfFailureStatus\|\|\(perfResponseStatus===null/);

// Idempotent OCR submissions still expose the current processing timing, not the old saved waybill timing.
const processApi=readFileSync(new URL("../functions/api/waybills/process.js",import.meta.url),"utf8");
assert.equal((processApi.match(/processingTiming:processingTiming\(\)/g)||[]).length,5);
assert.match(processApi,/saveStages/);
assert.equal(processApi.split('event:"WAYBILL_IDEMPOTENT"').length-1,3,"every idempotent reuse path must retain the current attempt timing");
assert.match(processApi,/event:"WAYBILL_IDEMPOTENT"[^}]*timing:processingTiming/,"idempotent events must attach processing timing");
assert.match(upload,/perfResult\?\.processingTiming/);

// Streaming responses use HTTP 200 as the transport, so preserve the underlying process status for failure telemetry.
assert.match(processApi,/type:"result",\.\.\.payload,httpStatus:response\.status/);
assert.match(processApi,/httpStatus:500/);
assert.match(upload,/perfResult\?\.success===false&&Number\.isInteger\(perfResult\?\.httpStatus\)/);

// Failed OCR/process responses expose top-level timing; include those phases in the same telemetry pipeline.
assert.match(upload,/perfResult\?\.timing&&typeof perfResult\.timing==="object"\?perfResult\.timing/);

// ---- 运单计时精度与诊断字段完整性回归 ----
const diagnosticApi=readFileSync(new URL("../functions/api/waybills/diagnostic.js",import.meta.url),"utf8");
const diagnosticUi=readFileSync(new URL("../js/admin/diagnostics.js",import.meta.url),"utf8");
assert.match(diagnosticUi,/本次尝试耗时/,"idempotent event timing must be visible in copied and displayed event history");
assert.match(processApi,/const waybillPerfDuration\s*=/,"运单处理阶段必须统一使用单调高精度计时");
for(const marker of ["baseLookupStarted","indexStarted","started","r2StageStarted","ocrStarted","baseWaitStarted","extractedStarted","matchStarted","dedupeStarted","planStarted"]){
  assert.match(processApi,new RegExp("waybillPerfDuration\\("+marker+"\\)"),marker+" must use high-resolution duration");
  assert.doesNotMatch(processApi,new RegExp("Date\\.now\\(\\)\\s*-\\s*"+marker),marker+" must not use millisecond-resolution Date.now");
}
for(const key of ["ocrImageCount","ocrResultRequestMs","ocrResultBodyMs","ocrResultParseMs","ocrResultChars"]){
  assert.match(diagnosticApi,new RegExp('"'+key+'"'),key+" must survive diagnostic safeTiming filtering");
}
assert.match(diagnosticUi,/const formatTimingMs\s*=/,"sub-10ms timing values must remain visible");
assert.ok(processApi.includes("const waybillPerfClock="),"diagnostics must disclose whether high-resolution timing is available");
assert.ok(processApi.includes('timingResolutionMs:timingClock==="performance.now"?0.01:1'),"diagnostics must expose timer resolution when falling back to Date.now");
assert.match(diagnosticApi,/"r2StageMs"/,"R2 staging duration must survive safeTiming filtering");
assert.match(diagnosticApi,/"r2StageBytes"/,"R2 staging byte count must survive safeTiming filtering");
assert.ok(diagnosticUi.includes("准备+识别累计"),"the cumulative recognition label must state its preparation boundary");
assert.match(diagnosticUi,/R2暂存/,"R2 staging must be separately visible");
assert.match(diagnosticUi,/计时分辨率/,"the diagnostic must explain timer resolution");
for(const key of ["baseLookupMs","baseIndexMs","baseWaitMs","baseOverlapMs"]){
  assert.ok(diagnosticUi.includes('"'+key+'"'),key+" must be shown in full waybill diagnostics");
}

// OCR request durations use the same monotonic high-resolution clock; wall-clock remains only for absolute deadlines.
const ocrApi=readFileSync(new URL("../functions/api/waybills/ocr.js",import.meta.url),"utf8");
assert.match(ocrApi,/const ocrPerfNow\s*=/);
assert.match(ocrApi,/const ocrPerfDuration\s*=/);
for(const marker of ["submitStarted","waitStarted","statusStarted","requestStarted","bodyStarted","refreshStarted","resultStarted","parseStarted"]){
  assert.match(ocrApi,new RegExp("ocrPerfDuration\\("+marker+"\\)"),marker+" must use monotonic duration");
  assert.doesNotMatch(ocrApi,new RegExp("Date\\.now\\(\\)\\s*-\\s*"+marker),marker+" must not use wall-clock subtraction");
}
