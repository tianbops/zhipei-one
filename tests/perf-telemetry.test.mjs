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
assert.match(report,/\^\(\?:history\|waybill\)-\[a-z-\]\+\$/,"report must preserve waybill timing phases");
const perfDiag=readFileSync(new URL("../js/perf-diagnostics.js",import.meta.url),"utf8");
assert.match(perfDiag,/window\.zpPerfRecord/);
assert.match(perfDiag,/p===\"\/api\/waybills\/process\"/);
assert.match(perfDiag,/response\[methodName\]/,"JSON/body timing must wait for the actual response body reader");
const upload=readFileSync(new URL("../js/home/upload-process.js",import.meta.url),"utf8");
const today=readFileSync(new URL("../js/home/today.js",import.meta.url),"utf8");
const monthly=readFileSync(new URL("../js/home-monthly.js",import.meta.url),"utf8");
assert.match(upload,/api-waybill-process/);
assert.match(upload,/waybill-server-total/);
assert.match(upload,/perfStreamComplete/);
assert.match(today,/home-today-ready-cache/);
assert.match(today,/home-today-ready-network/);
assert.match(monthly,/home-history-ready-cache/);
assert.match(monthly,/home-history-ready-network/);

// AbortError 与 TimeoutError 不得再混入 network。\nassert.match(ingest,/"network","abort","timeout"/);\nassert.match(perfDiag,/classifyFetchFailure/);\nassert.match(perfDiag,/name==="TimeoutError"/);\nassert.match(perfDiag,/name==="AbortError"/);\n