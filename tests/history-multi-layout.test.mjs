import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../js/order_detail.js", import.meta.url), "utf8");

// 多运单历史卡片必须将数量回退逻辑整体括起来，避免 + 与 || 优先级导致后续 HTML 被截断。
assert.match(source, /history-choice-main[^\n]*\+\(Number\(s\.finalCount\)\|\|Number\(s\.total\)\|\|\(Array\.isArray\(x\.stores\)\?x\.stores\.length:0\)\)\+'家 · '\+fmtWeight\(x\.totalWeight\)\+'t<\/span>'\+status/);
assert.doesNotMatch(source, /\+Number\(s\.finalCount\)\|\|Number\(s\.total\)\|\|x\.stores\?\.length\|\|0\+'家 · '/);
console.log("历史多运单卡片排列与摘要渲染回归测试：通过");
