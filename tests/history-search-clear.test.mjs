import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const source = readFileSync(new URL("../js/history.js", import.meta.url), "utf8");
assert.match(source, /if\(searchController\)\{searchController\.abort\(\);searchController=null\}/);
assert.match(source, /searchResults\.innerHTML="";searchResults\.hidden=true/);
assert.equal((source.match(/confirmBtn\.onclick=async/g)||[]).length, 1, "删除确认按钮只能绑定一次处理器");
console.log("历史搜索清空与删除处理器回归测试：通过");
