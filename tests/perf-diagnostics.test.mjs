import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../js/perf-diagnostics.js", import.meta.url), "utf8");
assert.match(source, /get\("zpPerf"\)==="1"/);
assert.match(source, /if\(!enabled\) return/);
assert.match(source, /Server-Timing/);
assert.match(source, /network-error/);
assert.match(source, /window\.__zpPerfReportNow=report/);
assert.match(source, /startsWith\("\/api\/"\)/);
assert.doesNotMatch(source, /sendBeacon|localStorage\.setItem|sessionStorage\.setItem|fetch\(["']https?:/);
console.log("Local performance diagnostics safeguards passed.");
