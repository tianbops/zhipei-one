import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const html=readFileSync(resolve(root,"admin.html"),"utf8");
const diag=readFileSync(resolve(root,"js/admin/diagnostics.js"),"utf8");
const learning=readFileSync(resolve(root,"js/admin/learning.js"),"utf8");
const routes=readFileSync(resolve(root,"js/admin/routes.js"),"utf8");
const css=readFileSync(resolve(root,"css/admin-base.css"),"utf8");
const sw=readFileSync(resolve(root,"sw.js"),"utf8");
assert.ok(html.includes('id="diagRoute"')&&html.includes('id="diagDate"'));
assert.ok(!html.includes('id="diagVehicle"'));
assert.ok(!html.includes('id="learnStoreId"')&&!html.includes('id="learnManualToggle"'));
assert.ok(html.includes('class="diag-perf-details"'));
assert.ok(diag.includes('JSON.stringify(w,null,2)'),"copy must retain the complete waybill diagnostic object");
assert.ok(diag.includes('JSON.stringify(d,null,2)'),"ticket copy must retain complete processing ticket");
assert.ok(diag.includes('data-copy-index='));
assert.ok(diag.includes('<details class="diag-details">'));
assert.ok(learning.includes('请先从门店列表中选择门店'));
assert.ok(!learning.includes('手动输入')&&!learning.includes('learnStoreId'));
assert.ok(routes.includes('当前线路：')&&!routes.includes('线路ID：'));
assert.ok(css.includes('.diag-card')&&css.includes('.diag-timing')&&css.includes('var(--zp-'));
for(const [path,hash] of Object.entries({
 "js/admin/diagnostics.js":"fd81d158",
 "js/admin/learning.js":"22c21bc8",
 "js/admin/routes.js":"9963910a",
 "css/admin-base.css":"2ef99677"
})){
 assert.ok(html.includes('/'+path+'?v='+hash), 'HTML cache hash mismatch for '+path);
 assert.ok(sw.includes('/'+path+'?v='+hash), 'SW precache hash mismatch for '+path);
}
console.log("管理员诊断页紧凑布局、无手工ID输入、完整复制与全局主题回归：通过");
