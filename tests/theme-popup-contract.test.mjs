import fs from "node:fs";
import assert from "node:assert/strict";

const read = path => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");
const base = read("css/ui-base.css");
const dark = read("css/ui-theme.css");
const overlay = read("css/ui-overlay.css");
const pickerCss = read("css/zp-picker.css");
const pickerJs = read("js/ui/zp-picker.js");
const themeSync = read("js/theme-sync.js");
const admin = read("admin.html");
const routeApply = read("pages/route_apply.html");

function pass(label) { console.log("✓ " + label); }
function has(re, source, label) { assert.match(source, re, label); pass(label); }

// The theme has one token source: light defaults in ui-base, dark overrides in ui-theme.
for (const token of ["--zp-bg", "--zp-surface", "--zp-text", "--zp-input-bg", "--zp-input-line", "--zp-scrim-dialog"]) {
  has(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:"), base, "浅色主题定义 " + token);
  has(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:"), dark, "深色主题覆盖 " + token);
}
has(/:root\s*\{[^}]*color-scheme\s*:\s*light/s, base, "浅色 WebView 控件配色声明");
has(/:root\[data-zp-theme="dark"\]\s*\{[^}]*color-scheme\s*:\s*dark/s, dark, "深色 WebView 控件配色声明");

// Native select/date UI must be replaced by page-owned surfaces that inherit tokens.
has(/zp-picker\.css/, admin, "管理员页加载统一选择器样式");
has(/zp-picker\.js/, admin, "管理员页加载统一选择器逻辑");
has(/zp-picker\.css/, routeApply, "线路申请页加载统一选择器样式");
has(/zp-picker\.js/, routeApply, "线路申请页加载统一选择器逻辑");
has(/<select\s+id="route"/, routeApply, "线路申请仍保留原生 select 数据语义");
has(/<select\s+id="duty"/, routeApply, "岗位申请仍保留原生 select 数据语义");
assert.equal((admin.match(/<select\b/g)||[]).length,3,"管理员页应只有 3 个原生选择控件，且统一升级");
assert.equal((routeApply.match(/<select\b/g)||[]).length,2,"线路申请页应只有 2 个原生选择控件，且统一升级");
pass("管理员与线路申请页全部 5 个 select 控件均纳入统一弹层");
has(/<select\s+id="diagRoute"/, admin, "管理员线路筛选仍保留原生 select 数据语义");
has(/<input\s+id="diagDate"\s+type="date"/, admin, "管理员日期筛选仍保留原生 date 数据语义");
has(/function upgradeSelect\s*\(/, pickerJs, "select 自动升级为页内选择器");
has(/function upgradeDate\s*\(/, pickerJs, "date 自动升级为页内日期选择器");
has(/dispatchEvent\(new Event\(["']change["']/, pickerJs, "选择后向原业务逻辑派发 change 事件");
has(/aria-modal["']\s*,\s*["']true/, pickerJs, "自建弹层声明模态语义");
has(/document\.addEventListener\(["']keydown["']/, pickerJs, "弹层接管键盘 Escape/Tab 交互");
has(/-webkit-appearance\s*:\s*none/ , pickerCss, "按钮控件关闭 WebView 原生白底绘制");
has(/\.zp-pk-sheet\s*\{[^}]*background\s*:\s*var\(--zp-surface\)/s, pickerCss, "选择弹层背景继承主题 surface 令牌");
has(/\.zp-pk-trigger\s*\{[^}]*background\s*:\s*var\(--zp-input-bg\)/s, pickerCss, "选择触发器背景继承主题 input 令牌");
has(/\.zp-pk-cell\[aria-selected="true"\][^}]*color\s*:\s*var\(--zp-accent\)/s, pickerCss, "日期选中态使用双主题可读强调色");
has(/\.order-dialog-panel[\s\S]*?background\s*:\s*var\(--zp-surface\)/, overlay, "业务弹窗面板继承主题 surface 令牌");
has(/\.order-dialog,[\s\S]*?background\s*:\s*var\(--zp-scrim-dialog\)/, overlay, "业务弹窗遮罩继承主题 scrim 令牌");

// The web theme must reach the native Android shell when changed at runtime.
has(/nat\.applyTheme\(color,\s*dark\)/, themeSync, "网页主题同步到 Android 原生桥");
has(/MutationObserver\(apply\)/, themeSync, "用户切换主题后自动重新同步系统栏和宿主 uiMode");
has(/attributeFilter\s*:\s*\["data-zp-theme"\]/, themeSync, "主题观察器只监听全局主题属性");

console.log("\n✓ Web 深浅主题 / 管理端弹窗 / Android 主题桥接契约完整");
