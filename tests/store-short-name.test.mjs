/**
 * 门店简称契约（2026-11-06）
 * ------------------------------------------------------------------
 * 需求：门店全名常带「特渠部…（临时）」等前后缀，运单列表被撑成两行。
 * 在数据中心编辑面板设置「门店简称」，只影响运单显示。
 *
 * 必须锁死的边界（这是本次设计唯一允许的用途）：
 *   1) 简称只用于显示：不参与 stableStoreId、不参与身份冲突校验、不写入学习库、不写 aliases；
 *   2) 手动别名入口已取消，面板也不再显示自动别名；
 *   3) 面板保存不得清空后台自动积累的 aliases；
 *   4) 运单读取时投影 displayName，快照里的 name 原样保留；
 *   5) 留空回退全名；上限 16 字符；首页列表单行省略。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(resolve(root, p), "utf8");

const display = read("functions/api/_store-display.js");
const base = read("functions/api/base.js");
const latest = read("functions/api/waybills/latest.js");
const historyRead = read("functions/api/_history-read.js");
const confirm = read("functions/api/waybills/confirm.js");
const learning = read("functions/api/_global-learning.js");
const dataHtml = read("pages/data.html");
const today = read("js/home/today.js");
const render = read("js/order_detail/render.js");
const css = read("css/home-dashboard.css");

/* 直接用生产实现跑逻辑：函数文件为 ESM，但项目 package.json 无 type:module，
   这里剥掉 export 后用 Function 求值，测的仍是同一份源码，不做二次实现。 */
function loadDisplay(){
 const body = display
  .replace(/export const SHORT_NAME_MAX/g, "const SHORT_NAME_MAX")
  .replace(/export function/g, "function");
 return new Function(body + ";return {normalizeShortName,displayNameOf,SHORT_NAME_MAX};")();
}
const { normalizeShortName, displayNameOf, SHORT_NAME_MAX } = loadDisplay();

/* 1. 归一化与回退 */
assert.equal(SHORT_NAME_MAX, 16, "简称上限必须是 16 字符");
assert.equal(normalizeShortName("  市卫健委  "), "市卫健委", "简称须去首尾空白");
assert.equal(normalizeShortName("市  卫健委\t"), "市 卫健委", "连续空白须折叠成一个空格");
assert.equal(normalizeShortName(""), "", "空简称保持为空（由显示侧回退全名）");
assert.equal(normalizeShortName("一二三四五六七八九十一二三四五六七八"), "一二三四五六七八九十一二三四五六", "超长须截断到 16 字符");
assert.equal(Array.from(normalizeShortName("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀")).length, 16, "表情符号不得被劈成半个字符");
assert.equal(normalizeShortName("含\u0000控制\u0007字符"), "含控制字符", "控制字符须剔除");
assert.equal(displayNameOf({ name: "特渠部重庆市卫生健康委员会（临时）" }, { shortName: "市卫健委" }), "市卫健委", "有简称时必须优先显示简称");
assert.equal(displayNameOf({ name: "某某便利店" }, { shortName: "" }), "某某便利店", "简称留空须回退运单全名");
assert.equal(displayNameOf({ name: "某某便利店" }, {}), "某某便利店", "基准库无简称字段时须回退全名");
assert.equal(displayNameOf({ name: "快照名" }, { name: "基准库全名" }), "快照名", "displayNameOf 不得用基准库全名覆盖快照名（改名口径另行处理）");

/* 2. 简称必须停在显示层：不进 ID、不进冲突校验、不进学习库 */
const stableFn = base.match(/function stableStoreId\(s\)\{.*/);
assert.ok(stableFn, "base.js 须保留 stableStoreId");
assert.ok(!/shortName|displayName/.test(stableFn[0]), "简称不得进入 stableStoreId 种子（否则改简称会生成新门店ID）");
assert.ok(/shortName:normalizeShortName\(s\.shortName\)/.test(base), "base.js 归一化须保留 shortName（否则保存即丢）");
assert.ok(/const names=\[s\.name,s\.originalName,\.\.\.s\.aliases\]/.test(base), "身份冲突校验只能看全名/原名/学习别名，简称不参与");
assert.ok(!/shortName/.test(learning), "简称不得写入全局学习库");

/* 3. 运单读取投影：只加 displayName，不改 name */
assert.ok(latest.includes("displayNameOf"), "latest.js 须用 displayNameOf 投影简称");
assert.ok(/\.\.\.\(useDisplay\?\{displayName\}:\{\}\)/.test(latest), "latest.js 须以 useDisplay 控制是否附带 displayName");
assert.ok(!/name:displayName/.test(latest), "latest.js 不得把 displayName 写回 name");
assert.ok(historyRead.includes("displayNameOf"), "历史读取（运单详情兜底数据源）须同样投影简称");
assert.ok(/\.\.\.\(useDisplay\?\{displayName\}:\{\}\)/.test(historyRead), "历史读取须与 latest 同口径");
assert.ok(/aliases:\[\],shortName:"",navigation:null/.test(confirm), "确认新增门店须带空简称字段，结构一致");

/* 4. 编辑面板：手动别名入口取消，别名连展示都不再出现 */
assert.ok(dataHtml.includes('id="editShortName"'), "编辑面板须有门店简称输入框");
assert.ok(/id="editShortName"[^>]*maxlength="16"/.test(dataHtml), "简称输入框须限制 16 字符");
assert.ok(dataHtml.includes("门店简称（仅用于运单显示）"), "简称字段须写明用途");
assert.ok(!dataHtml.includes("editAliasInput"), "手动输入别名的输入框必须移除");
assert.ok(!dataHtml.includes("editAliasAdd"), "手动添加别名按钮必须移除");
assert.ok(!dataHtml.includes('id="editAliases"'), "面板不得再渲染自动别名列表");
assert.ok(!/renderEditAliases|addEditAlias/.test(dataHtml), "别名渲染/追加逻辑须移除");
assert.ok(!/item\.aliases\s*=/.test(dataHtml), "保存时不得重写 aliases（否则会清空自动学习别名）");
assert.ok(/item\.shortName=\$\("editShortName"\)\.value\.trim\(\)\.slice\(0,16\)/.test(dataHtml), "保存须写入简称并截断");
assert.ok(/shortName:String\(x\.shortName\|\|""\)\.trim\(\)\.slice\(0,16\)/.test(dataHtml), "JSON 导入/恢复须保留简称");

/* 5. 显示：简称优先，列表单行 */
assert.ok(/const rawName=String\(x\?\.displayName\|\|""\)\.trim\(\)\|\|String\(x\?\.name/.test(today), "首页今日配送须优先取 displayName");
assert.ok(/const rawName=String\(x\.displayName\|\|''\)\.trim\(\)\|\|String\(x\.name/.test(render), "运单详情须优先取 displayName");
assert.ok(/\.today-store-name-wrap\{[\s\S]{0,220}overflow-x:auto/.test(css), "首页门店名须放进横向滚动容器（左滑看全名）");
assert.ok(/\.today-store-name\{[\s\S]{0,160}white-space:nowrap/.test(css), "首页门店名须强制单行");
assert.ok(!/\.today-store-name\{[\s\S]{0,120}-webkit-line-clamp/.test(css), "不得再用 line-clamp：它只裁不滚，看不到后半段");
assert.ok(/is-scrollable:not\(\.at-end\)/.test(css), "右侧渐隐只能出现在真的溢出且未滑到末尾时");
assert.ok(today.includes("is-scrollable") && today.includes("at-end"), "渲染后须按实际宽度标记可滑动/已到末尾");
assert.ok(/lastMoveAt>=600[\s\S]{0,400}stopImmediatePropagation/.test(today), "左滑手势须在 window 捕获阶段吞掉导航点击");
assert.ok(/pointermove[\s\S]{0,220}Math\.abs\(dx\)>8/.test(today), "须用位移阈值区分滑动与轻点");

/* 6. 滑开后自动回位 */
assert.ok(/ZP_NAME_RETURN_DELAY=2400/.test(today), "须有静置回位时长（2.4s，给足阅读时间）");
assert.ok(/function zpScheduleNameReturn\(el\)\{[\s\S]{0,260}setTimeout\(/.test(today), "离开起点后须排一次静置回位计时");
assert.ok(/function zpReturnTodayStoreName\(el,instant\)\{[\s\S]{0,900}requestAnimationFrame\(step\)/.test(today), "回位须平滑动画，不能瞬跳");
assert.ok(/el\.scrollLeft=0;zpSyncTodayStoreName\(el\);/.test(today), "回位结束须落在起点并刷新渐隐状态");
assert.ok(/zpNameReturning\)return;/.test(today), "回位动画自身触发的 scroll 不得再排期（否则死循环）");
assert.ok(/pointerdown[\s\S]{0,420}zpCancelNameReturn\(\)/.test(today), "手指落下须取消回位（人还在看就别抢）");
assert.ok(/prefers-reduced-motion: reduce/.test(today), "减弱动效时须直接复位，不做动画");
assert.ok(/visibilitychange[\s\S]{0,240}zpReturnTodayStoreName\(el,true\)/.test(today), "切到后台须立即复位，回来不看到半截名字");

console.log("store-short-name: all assertions passed");
