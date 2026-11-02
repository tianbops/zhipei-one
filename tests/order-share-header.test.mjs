import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root=fileURLToPath(new URL("..",import.meta.url));
for(const page of ["pages/today.html","pages/order_detail.html"]){
 const html=readFileSync(root+page,"utf8");
 assert.match(html,/<button id="shareBtn"[^>]*aria-label="分享运单"/,page+" 顶部必须提供分享按钮");
 assert.match(html,/<circle cx="18" cy="5" r="2\.5"><\/circle>/,page+" 使用分享图标");
 assert.doesNotMatch(html,/id="menuBtn"|id="menuPanel"|id="editRouteBtn"|id="logoutBtn"/,page+" 不得保留旧菜单入口");
}
const boot=readFileSync(root+"js/order_detail/boot.js","utf8");
assert.match(boot,/if\(\$\('shareBtn'\)\)\$\('shareBtn'\)\.onclick=async/,"分享按钮绑定原有分享逻辑");
assert.match(boot,/navigator\.share\(\{title:'当日运单',text\}\)/,"优先使用系统分享面板");
assert.match(boot,/navigator\.clipboard\?\.writeText\(text\)/,"不支持系统分享时保留复制兜底");
assert.doesNotMatch(boot,/menuBtn|menuPanel|setMenu|editRouteBtn|logoutBtn/,"详情脚本不得再依赖旧菜单");
for(const file of ["js/order_detail/core.js","js/order_detail/render.js","js/order_detail/nav-menu.js"]){
 const src=readFileSync(root+file,"utf8");
 assert.doesNotMatch(src,/menuOpen|menuPanel|menuRoute|setMenu/,file+" 清除旧菜单状态和 DOM 依赖");
}
console.log("运单顶部分享入口：通过（今日运单 + 运单详情 / 系统分享 + 复制兜底 / 旧菜单依赖清除）");
