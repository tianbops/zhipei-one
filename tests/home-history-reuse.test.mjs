import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const home = readFileSync(new URL("../js/home/today.js", import.meta.url), "utf8");
const monthly = readFileSync(new URL("../js/home-monthly.js", import.meta.url), "utf8");

// The monthly-statistics request is the shared source for the final home fallback.
assert.match(monthly, /window\.zpHomeMonthlyDataPromise\s*=\s*load\(\)/);
assert.match(monthly, /return d;[\s\S]*window\.zpHomeMonthlyDataPromise/);
assert.match(home, /const sharedPromise\s*=\s*window\.zpHomeMonthlyDataPromise/);
assert.match(home, /historyData\s*=\s*await Promise\.race\(/);
assert.match(home, /fetchJson\("\/api\/history\?months=13",20000\)/);

// Keep a bounded wait and preserve the old fallback when the shared read fails.
assert.match(home, /setTimeout\(\(\)=>resolve\(null\),20000\)/);
assert.match(home, /if\(!historyData\?\.success\|\|!Array\.isArray\(historyData\.history\)\)/);
assert.match(home, /todayEntry=historyData\.history\.find/);
console.log("首页历史数据复用回归测试：通过（共享响应、超时、原兜底保留）");
