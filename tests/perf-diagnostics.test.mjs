import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source=readFileSync(new URL("../js/perf-diagnostics.js",import.meta.url),"utf8");
assert.match(source,/get\("zpPerf"\)==="1"/);
assert.match(source,/Server-Timing|Server-Timing/);
assert.ok(source.includes("dur=([\\d.]+)$/"), "history Server-Timing phase parser must match numeric durations");
assert.match(source,/network/);
assert.match(source,/api\/perf-event/);
assert.match(source,/credentials:"same-origin"/);
assert.match(source,/page-load/);
assert.match(source,/api-history-detail/);
assert.match(source,/api-history-search/);
assert.match(source,/history-response-build/);
assert.doesNotMatch(source,/sendBeacon|localStorage\.setItem|sessionStorage\.setItem|fetch\(["']https?:|console\.info\("\[ZP-PERF\]",\{[^}]*url/i);

// ---- 账户接口细分 ----
// 此前 /api/me 与 /api/account* 全部并成 api-account 一个标签，
// 导致「账户 30 次异常」无法拆到具体接口，只能停留在平均值猜测。
assert.match(source,/api-account-me/);
assert.match(source,/api-account-settings/);
assert.match(source,/api-account-other/);
assert.doesNotMatch(source,/"api-account";/,"账户类不能再使用合并后的单一标签");

// ---- 非 2xx 必须携带具体 HTTP 状态码 ----
assert.match(source,/var code=/);
assert.match(source,/row\.code=code/);
assert.doesNotMatch(source,/status>=600/);

// ---- 反向回归：埋点被移除时本测试必须失败 ----
// 教训：仅断言脚本源码特征，无法发现「页面不再引用该脚本」造成的漏埋（同主题测试的漏检模式）。
for(const p of ["index.html","home.html","pages/account.html","pages/history.html","pages/dispatch.html"]){
  assert.ok(readFileSync(new URL("../"+p,import.meta.url),"utf8").includes("/js/perf-diagnostics.js?v="),
    p+" 必须引用 /js/perf-diagnostics.js（移除引用会导致埋点静默失效）");
}
console.log("Automatic anonymous performance diagnostics safeguards passed.");


// Full JSON response read timing and the streamed waybill completion hook.
assert.match(source,/window\.zpPerfRecord/);
assert.match(source,/p===\"\/api\/waybills\/process\"/);
assert.match(source,/bodyMethods=\[\"json\",\"text\",\"arrayBuffer\",\"blob\",\"formData\"\]/);

// Abort and timeout failures are separate from genuine network errors.
assert.match(source,/classifyFetchFailure/);
assert.match(source,/name==="AbortError"/);
assert.match(source,/name==="TimeoutError"/);
assert.match(source,/status==="network"\|\|status==="abort"\|\|status==="timeout"/);
