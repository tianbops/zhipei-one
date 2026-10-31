import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>readFileSync(resolve(root,p),"utf8");
const css=read("css/admin-base.css"),boot=read("js/admin/boot.js"),admin=read("admin.html"),home=read("home.html"),login=read("js/login.js"),index=read("index.html"),sw=read("sw.js");
assert.match(css,/html:not\(\[data-zp-admin-authorized="1"\]\) body>\.shell\{visibility:hidden\}/);
assert.match(boot,/document\.documentElement\.setAttribute\("data-zp-admin-authorized","1"\)/);
// 首屏门禁必须在页面脚本执行前识别已知角色，避免跨工作区 UI 闪现。
assert.match(admin,/sessionStorage\.getItem\("zpRole"\)==="user"/);
assert.match(admin,/function goHome\(\)\{hide\(\);location\.replace\("\/home"\);\}/);
assert.match(admin,/if\(ev\.persisted\)guard\(\)/);
assert.match(home,/role==="admin"\|\|role==="system_admin"/);
assert.match(home,/function goAdmin\(\)\{hide\(\);location\.replace\("\/admin"\);\}/);
assert.match(home,/if\(ev\.persisted\)guard\(\)/);
assert.ok(admin.indexOf("function guard()")<admin.indexOf("/js/admin/boot.js"));
assert.ok(home.indexOf("function guard()")<home.indexOf("/js/home.bundle.js"));
assert.ok(boot.indexOf('m.user?.role!=="system_admin"&&m.user?.role!=="admin"')<boot.indexOf('setAttribute("data-zp-admin-authorized","1")'));
assert.match(boot,/sessionStorage\.removeItem\("zpAuth"\);sessionStorage\.removeItem\("zpRole"\);sessionStorage\.removeItem\("zpExitAdmin"\);sessionStorage\.removeItem\("zpAutoHop"\)/);
assert.match(boot,/location\.replace\("\/\?reason=logout&manual=1"\)/);
assert.match(login,/sessionStorage\.removeItem\("zpExitAdmin"\);sessionStorage\.removeItem\("zpAutoHop"\)/);
assert.match(boot,/addEventListener\("pagehide",\(\)=>document\.documentElement\.removeAttribute\("data-zp-admin-authorized"\)\)/);
assert.match(boot,/addEventListener\("pageshow",ev=>\{if\(!ev\.persisted\)return;document\.documentElement\.removeAttribute\("data-zp-admin-authorized"\);load\(\)\}\)/);
// 资产哈希由 scripts/bump_asset_versions.py 每次刷新，只校验格式不写死数值，
// 否则每 bump 一次本测试就红一次（模式与 sw-precache.test.mjs 保持一致）。
assert.match(index,/\/js\/login\.js\?v=[0-9a-f]{8}/);
assert.match(admin,/\/css\/admin-base\.css\?v=[0-9a-f]{8}/);
assert.match(admin,/\/js\/admin\/boot\.js\?v=[0-9a-f]{8}/);\nassert.match(home,/\/js\/home\.bundle\.js\?v=[0-9a-f]{8}/);
// SW 版本号由 scripts/bump_asset_versions.py 每次刷新，只校验格式不写死数值，
// 否则每 bump 一次本测试就红一次（模式与 sw-precache.test.mjs 保持一致）。
assert.match(sw,/const VERSION = "zp-pwa-\d+";/);
console.log("管理员/普通用户会话隔离静态回归：全部通过");
