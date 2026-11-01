import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const shell=readFileSync(resolve(root,"js/admin/shell.js"),"utf8");
const admin=readFileSync(resolve(root,"admin.html"),"utf8");
const sw=readFileSync(resolve(root,"sw.js"),"utf8");

assert.ok(shell.includes('document.querySelector(".shell")||vp'));
assert.ok(shell.includes('addEventListener("touchstart",down'));
assert.ok(shell.includes('addEventListener("touchmove",move'));
assert.ok(shell.includes('addEventListener("touchcancel",e=>end(e,false)'));

const end=shell.slice(shell.indexOf("function end(e,commit)"),shell.indexOf("const host="));
assert.ok(end.includes("if(!commit){"));
assert.ok(end.includes('pg.style.transition=""'));
assert.ok(end.includes('pg.style.transform="translateX(-"+from*20+"%)"'));
assert.ok(end.indexOf("pg.style.transform=")<end.indexOf("return;"),"取消手势必须先归位再退出");
assert.ok(admin.includes("/js/admin/shell.js?v="));
assert.ok(sw.includes("/js/admin/shell.js?v="));
console.log("管理员左右滑动 touchcancel 归位回归：通过");
