import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../js/admin/diagnostics.js", import.meta.url), "utf8");

assert.match(source, /const eventText=e=>/);
assert.match(source, /e\?\.reuse\?"复用运单ID："/);
assert.match(source, /e\?\.dedupe\?"去重方式："/);
assert.match(source, /\.map\(e=>esc\(eventText\(e\)\)\)/);
assert.match(source, /\.map\(eventText\)/);

console.log("管理员运单诊断：事件列表与复制内容均展示复用运单ID和去重方式");
