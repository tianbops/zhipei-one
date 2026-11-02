import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../pages/data.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/data.css", import.meta.url), "utf8");

const fixedStart = html.indexOf('<div class="data-fixed-area">');
const scrollStart = html.indexOf('<div class="zp-scroll">');
const listStart = html.indexOf('<section class="page2-card data-list-card">');
const fixedHtml = html.slice(fixedStart, scrollStart);
const scrollHtml = html.slice(scrollStart, html.indexOf('<div id="editBox"', scrollStart));

assert.ok(fixedStart >= 0 && scrollStart > fixedStart, "数据中心固定区域必须位于滚动容器之前");
for (const id of ["title", "summary", "hint", "replaceBtn", "appendBtn", "restoreBtn", "saveStoresTop"]) {
  assert.ok(fixedHtml.includes(`id="${id}"`), `${id} 必须位于固定区域`);
}
assert.ok(listStart > scrollStart && scrollHtml.includes('id="stores"'), "门店列表必须位于独立滚动区域");
assert.match(css, /\.data-fixed-area\s*\{[^}]*flex:\s*0 0 auto/s);
assert.match(css, /\.data-page\s*\{[^}]*padding-bottom/);
console.log("数据中心线路信息与四项维护操作固定；门店资料独立滚动：通过");
