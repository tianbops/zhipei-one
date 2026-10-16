import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../pages/history.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../js/history.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/history.css", import.meta.url), "utf8");

// 历史页不再提供关键词搜索、搜索时间范围或搜索提交入口。
assert.doesNotMatch(html, /historySearchForm|historySearchInput|historySearchMonths|historySearchState|historySearchResults|搜索姓名、电话、地址、运单号或门店|近3个月/);
assert.doesNotMatch(source, /searchController|runHistorySearch|renderSearchResults|historySearchForm|historySearchInput|historySearchMonths/);
assert.doesNotMatch(css, /\.history-search(?:\\b|-)/);

// 非搜索历史功能必须保留。
assert.match(html, /id="historyList"/);
assert.match(html, /id="historyPickerBtn"/);
assert.match(html, /id="historyLookupBtn"/);
assert.match(html, /id="historyExportBtn"/);
assert.match(html, /id="historyTrashBtn"/);
assert.match(source, /confirmBtn\.onclick=async/);
console.log("历史页已移除关键词搜索；日期选择、历史列表、删除、客户快查、导出与回收站入口保留：通过");
