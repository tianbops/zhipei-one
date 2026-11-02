import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../pages/history.html", import.meta.url), "utf8");
// history.js 已拆分为 js/history/ 四模块（core→render→data→overlay），按序拼接后断言（与线上加载顺序一致）
const HIST_DIR = new URL("../js/history/", import.meta.url);
const source = ["core.js", "render.js", "data.js", "overlay.js"]
  .map((f) => readFileSync(new URL(f, HIST_DIR), "utf8")).join("\n");
const HIST_CSS = new URL("../css/", import.meta.url);
const css = ["history-shell.css", "history-list.css", "history-nav.css", "history-overlays.css"]
  .map((f) => readFileSync(new URL(f, HIST_CSS), "utf8")).join("\n");

// 历史页不再提供关键词搜索、搜索时间范围或搜索提交入口。
assert.doesNotMatch(html, /historySearchForm|historySearchInput|historySearchMonths|historySearchState|historySearchResults|搜索姓名、电话、地址、运单号或门店|近3个月/);
assert.doesNotMatch(source, /searchController|runHistorySearch|renderSearchResults|historySearchForm|historySearchInput|historySearchMonths/);
assert.doesNotMatch(css, /\.history-search(?:\b|-)/);

// 非搜索历史功能必须保留。
assert.match(html, /id="historyList"/);
assert.match(html, /id="historyPickerBtn" class="zp-btn zp-btn--secondary history-date-button"/);
const CSS_ORDER = ["history-shell", "history-list", "history-nav", "history-overlays"];
const histCssLinks = [...html.matchAll(/\/css\/(history-[a-z-]+)\.css\?v=[0-9a-f]+/g)].map((m) => m[1]);
assert.deepStrictEqual(histCssLinks, CSS_ORDER,
  `历史页 CSS 组件引用顺序必须是 ${CSS_ORDER.join("→")}（实际 ${histCssLinks.join("→")}）`);
assert.match(css, /\.history-date-button\s*\{[^}]*min-height:\s*48px/s);
assert.doesNotMatch(css.slice(css.lastIndexOf("/* 日期选择：沿用全站次级按钮风格")), /(?:^|[;{])\s*(?:background|border|border-radius|color)\s*:/m);
assert.match(html, /id="historyLookupBtn"/);
assert.match(html, /id="historyExportBtn"/);
assert.match(html, /id="historyTrashBtn"/);
const toolbarStart = html.indexOf('<div class="history-toolbar" aria-label="历史查询操作">');
const toolbarEnd = html.indexOf('</div><div id="historyState"', toolbarStart);
assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart, "操作区必须独立包裹在历史列表外侧");
const toolbarHtml = html.slice(toolbarStart, toolbarEnd);
assert.match(toolbarHtml, /id="historyLookupBtn"/);
assert.match(toolbarHtml, /id="historyExportBtn"/);
assert.match(toolbarHtml, /id="historyTrashBtn"/);
assert.match(toolbarHtml, /id="historyPickerBtn"/);
const toolbarAt = html.indexOf('<div class="history-toolbar" aria-label="历史查询操作">');
const scrollAt = html.indexOf('<div class="zp-scroll">');
assert.ok(toolbarAt >= 0 && scrollAt > toolbarAt, "工具栏必须位于唯一滚动容器之前");
assert.match(css, /\.history-toolbar\s*\{[^}]*position:\s*static;[^}]*flex:\s*0 0 auto/s);
assert.doesNotMatch(css, /\.history-toolbar\s*\{[^}]*position:\s*sticky/s);
assert.match(source, /confirmBtn\.onclick=async/);
console.log("历史页已移除关键词搜索；日期选择、历史列表、删除、客户快查、导出与回收站入口保留：通过");
