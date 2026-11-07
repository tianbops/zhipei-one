/**
 * 首页顶部两层浮层契约（node tests/home-head-float.test.mjs）
 * ------------------------------------------------------------------
 * 守护「Shadowrocket 式顶部浮层」的结构与显隐/反向联动不回归：
 *  1) 品牌区固定、内容不变；两层浮层是 main 直接子元素的 absolute overlay，
 *     不在 .zp-scroll 文档流内；横条=今日配送/日期，白卡片=数据/插画/多单 tab；
 *  2) 门店列表与统计卡留在 .task-card 文档流，趋势卡在更下方（整页可滚到）；
 *  3) CSS：天花板层级压过浮层、隐藏态 translateY(-100%) 完全消失、
 *     两层用全局令牌、spacer 隐藏态 0（不留把手线 / 不占位）；
 *  4) 手势：p=0 隐藏态起步、上滑弹出 / 下滑隐藏、松手吸附、横向不接管、
 *     顶底互斥反向、仍交给 .zp-scroll 原生滚动（不 preventDefault）；
 *  5) nav.js 暴露受控接口并在浮层启用时让位；构建链含新模块且置于末尾。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const HTML = rd("../home.html");
const CSS = rd("../css/home-dashboard.css");
const FLOAT_JS = rd("../js/home/head-float.js");
const NAV = rd("../js/ui/nav.js");
const BUILD = rd("../scripts/build-home-bundle.mjs");
const BUNDLE_JS = rd("../js/home.bundle.js");
const BUNDLE_CSS = rd("../css/home.bundle.css");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
function rule(src, sel) {
  const i = src.indexOf(sel + "{");
  if (i < 0) return null;
  const j = src.indexOf("\n}", i);
  return j < 0 ? null : src.slice(i, j + 2);
}

console.log("一、DOM 结构：品牌区固定 + 两层浮层 overlay + 名单/统计留在文档流（8 条）");
{
  const iFloat = HTML.indexOf('id="zpHeadFloat"');
  const iSpacer = HTML.indexOf('id="zpHeadSpacer"');
  const iScroll = HTML.indexOf('class="zp-scroll"');
  const iCard = HTML.indexOf('class="task-card"');
  const iTrend = HTML.indexOf('id="trendCard"');

  t("品牌区 topbar 保留且内容不变", /<header class="topbar">[\s\S]*?智配One[\s\S]*?运单处理 · 历史查询 · 路线经验/.test(HTML));
  t("存在两层浮层容器 #zpHeadFloat", iFloat > 0);
  t("浮层内分横条 .zp-head-bar 与白卡片 .zp-head-card",
    HTML.includes('class="task-title zp-head-bar"') && HTML.includes('class="zp-head-card"'));
  t("浮层是 zp-scroll 之外的兄弟节点（overlay，不占文档流）",
    iFloat > 0 && iFloat < iScroll);
  t("横条承载今日配送与日期，白卡片承载数据/插画/多单 tab",
    /zp-head-bar[\s\S]*?id="todayTitle"[\s\S]*?id="todayDate"[\s\S]*?zp-head-card/.test(HTML) &&
    /zp-head-card[\s\S]*?id="todayTabs"/.test(HTML));
  t("让位块 #zpHeadSpacer 在 .task-card 之前、文档流内",
    iSpacer > iScroll && iSpacer < iCard);
  t("门店列表与今日统计留在 .task-card 内",
    /class="task-card"[\s\S]*?id="todayStoreList"[\s\S]*?id="todayMetrics"[\s\S]*?<\/section>/.test(HTML));
  t("月度趋势卡在门店列表下方（整页可滚到统计卡）",
    iTrend > iCard && HTML.indexOf('id="todayStoreList"') < iTrend);
}

console.log("\n二、CSS：天花板裁切 + 隐藏态完全消失 + 令牌配色 + 补位（7 条）");
{
  const ceiling = rule(CSS, "main.home-app > .topbar");
  t("品牌区作天花板：同色底 + relative + 更高层级",
    !!ceiling && /background:var\(--zp-block\)/.test(ceiling) &&
    /position:relative/.test(ceiling) && /z-index:25/.test(ceiling));
  const float = rule(CSS, ".home-app .zp-head-float");
  t("浮层 absolute 定位、贴品牌区底部、层级低于天花板",
    !!float && /position:absolute/.test(float) &&
    /top:var\(--zp-ceiling-h/.test(float) && /z-index:20/.test(float));
  t("隐藏态整块 translateY(-100%)（完全消失、不留把手线）",
    !!float && /transform:translateY\(-100%\)/.test(float));
  const bar = rule(CSS, ".home-app .zp-head-bar");
  const card = rule(CSS, ".home-app .zp-head-card");
  t("横条与天花板同色（--zp-block）", !!bar && /background:var\(--zp-block\)/.test(bar));
  t("白卡片取 surface 令牌（深浅双主题自适应）", !!card && /background:var\(--zp-surface\)/.test(card));
  t("两层配色零字面量（无 #hex / rgb 硬编码）",
    !!bar && !!card && !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(bar + card + (float || "")));
  const spacer = rule(CSS, ".home-app .zp-head-spacer");
  t("让位块隐藏态 height:0（不占位）", !!spacer && /height:0/.test(spacer));
  t("新增浮层不留任何把手线节点",
    !/zp-head-handle|head-handle/.test(CSS) && !/zp-head-handle|head-handle/.test(HTML));
}

console.log("\n三、手势：隐藏态起步 / 顶底互斥反向 / 原生滚动共存（8 条）");
{
  t("p=0 隐藏态起步（打开时浮层收起、底栏出现，第一下上滑即可弹出）",
    /var H=1,need=0,p=0/.test(FLOAT_JS));
  t("跟手 p 用「起点绝对位移」计算（上滑→p 增大弹出 / 下滑→p 减小隐藏，不怕丢帧）",
    /setP\(pStart-ay\/\(Math\.max\(1,H\)\*0\.85\)/.test(FLOAT_JS));
  t("松手按累计位移方向定端点（上滑→p=1 / 下滑→p=0），抗浏览器提前 touchcancel",
    /accDy<0\?1:0/.test(FLOAT_JS) && /addEventListener\("touchcancel",end/.test(FLOAT_JS));
  t("位移过小时仍就近吸附到 0/1 端点", /p>=\.5\?1:0/.test(FLOAT_JS));
  t("横向手势不接管（让给多单切页 / 门店点击）",
    /Math\.abs\(ay\)<=Math\.abs\(ax\)\*1\.2/.test(FLOAT_JS));
  t("顶底互斥反向：顶部出现则底栏隐藏", /navHide\(p>=\.5\)/.test(FLOAT_JS));
  const touchAdds = FLOAT_JS.match(/addEventListener\("touch(?:start|move|end|cancel)"[\s\S]*?\{passive:true\}\)/g) || [];
  t("touch 四个监听全部 passive、无 .preventDefault() 调用（门店名单仍由 .zp-scroll 原生滚动，统计卡可达）",
    touchAdds.length >= 4 && !/\.preventDefault\(/.test(FLOAT_JS));
  t("启用时通知 nav.js 让位（避免两套逻辑互相覆盖底栏类）",
    /window\.__zpHeadFloatActive=true/.test(FLOAT_JS));
  t("ResizeObserver 按浮层实测高度重算让位（tab 显隐 / 字体 / 主题变化都跟随）",
    /new ResizeObserver/.test(FLOAT_JS));
}

console.log("\n四、联动与构建链：nav 受控接口 + bundle 同步（5 条）");
{
  t("nav.js 暴露 zpNavSetHidden 受控接口", /window\.zpNavSetHidden=function\(hide\)\{navApply\(hide\)\}/.test(NAV));
  t("nav.js 在浮层启用时让位（不再自行滚动自隐藏）",
    /function navOnScroll\(e\)\{\s*\n?\s*if\(window\.__zpHeadFloatActive\)return;/.test(NAV));
  t("构建链含 js/home/head-float.js", BUILD.includes('"js/home/head-float.js"'));
  t("新模块置于 nav.js / pwa.js 之后（依赖就绪才执行）",
    BUILD.indexOf('"js/home/head-float.js"') > BUILD.indexOf('"js/pwa.js"'));
  t("bundle 产物已同步（JS 含接管标记、CSS 含浮层规则）",
    BUNDLE_JS.includes("__zpHeadFloatActive=true") &&
    BUNDLE_CSS.includes(".home-app .zp-head-float{"));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 首页顶部浮层契约：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
