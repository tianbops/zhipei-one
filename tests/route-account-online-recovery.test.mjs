import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const routePage = read("pages/route_apply.html");
const accountPage = read("pages/account.html");
const routeRecovery = read("js/route-apply-recovery.js");
const accountRecovery = read("js/account-online-recovery.js");

assert.ok(routePage.includes("/js/route-apply-recovery.js"), "线路申请页应加载弱网恢复模块");
assert.ok(accountPage.includes("/js/account-online-recovery.js"), "设置页应加载弱网恢复模块");
for (const event of ['"online"', '"focus"', '"visibilitychange"']) {
  assert.ok(routeRecovery.includes(event), "线路申请页缺少恢复触发：" + event);
  assert.ok(accountRecovery.includes(event), "设置页缺少恢复触发：" + event);
}
for (const field of ["routeDraft", "dutyDraft", "nameDraft", "phoneDraft"]) {
  assert.ok(routeRecovery.includes(field), "线路申请页未保护未提交字段：" + field);
}
assert.ok(routeRecovery.includes("window.load"), "线路申请页应复用只读 load()");
assert.ok(accountRecovery.includes("window.load"), "设置页应复用只读 profile load()");
assert.ok(!accountRecovery.includes('fetch("/api/me")') && !accountRecovery.includes('zpFetch("/api/me")'), "设置页恢复不得另造资料 API 或绕过既有 load()");
assert.doesNotMatch(routeRecovery, /location\.reload|method\s*:\s*["']POST/i, "线路申请恢复不得刷新页面或重放写请求");
assert.doesNotMatch(accountRecovery, /location\.reload|method\s*:\s*["']POST/i, "设置页恢复不得刷新页面或重放写请求");

console.log("线路申请/设置页弱网恢复守卫通过（只读恢复、保留编辑状态、不重放写操作）");
