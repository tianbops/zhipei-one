/* 数据中心返回上级 = 线路维护页（2026-11-05 产品设定）
 * ------------------------------------------------------------------
 * 数据中心是「线路维护」页里的二级入口，返回必须回到线路维护，而不是丢回首页
 * 丢掉刚选的线路上下文。改动落在三处，任何一处漏了都会让线上表现不一致：
 *   1) js/ui/back.js 的 zpStaticParent（返回目标单一真源）；
 *   2) js/home.bundle.js 打包副本（漏重建 = 首页等页面行为与数据中心分叉）；
 *   3) pages/data.html 顶栏箭头的 href（JS 未加载时的兜底 + 语义声明）。
 * 同时守住两条不能破坏的既有能力：运单详情编辑往返、返回安全阀。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const back = readFileSync(new URL("../js/ui/back.js", import.meta.url), "utf8");
const bundle = readFileSync(new URL("../js/home.bundle.js", import.meta.url), "utf8");
const data = readFileSync(new URL("../pages/data.html", import.meta.url), "utf8");
const dispatch = readFileSync(new URL("../pages/dispatch.html", import.meta.url), "utf8");

const PARENT = /"\/pages\/data"\s*:\s*"\/pages\/dispatch"/;
assert.ok(PARENT.test(back), "back.js 静态父级须把 /pages/data 归到 /pages/dispatch");
assert.ok(PARENT.test(bundle), "home.bundle.js 打包副本须同步该映射（改 back.js 后要重建 bundle）");

assert.ok(/<a class="app-back" href="\/pages\/dispatch"/.test(data), "数据中心顶栏返回箭头应指向线路维护");
assert.ok(!/class="app-back" href="\/home"/.test(data), "顶栏箭头不得再指向首页");
assert.ok(dispatch.includes("/pages/data?from=dispatch"), "线路维护页的数据中心入口仍须带 from=dispatch");

/* 编辑往返优先于静态父级：从运单详情进数据中心，返回要回那张运单 */
const parentOf = back.slice(back.indexOf("function zpParentOf"), back.indexOf("window.zpResolveBack"));
assert.ok(parentOf.includes('params.get("from")==="order"'), "必须保留运单详情→数据中心→回原运单");
assert.ok(
  parentOf.indexOf('params.get("from")==="order"') < parentOf.indexOf("zpStaticParent[path]"),
  "编辑往返分支必须排在静态父级兜底之前"
);

/* 静态父级不能绕过既有安全阀：深度严格递减、跨区防火墙 */
assert.ok(back.includes('"/pages/data":2'), "数据中心仍是 depth 2 的细节页");
assert.ok(back.includes("if(!sameDepth&&zpDepthOf(tpath)>=depth)return zpRoot"), "深度安全阀仍在");
assert.ok(back.includes('zpZone==="admin"&&tpath!=="/admin"'), "管理区跨区防火墙仍在");

console.log("数据中心返回上级 = 线路维护：静态契约通过");
