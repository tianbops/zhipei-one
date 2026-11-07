/**
 * 首页顶部两层浮层契约（node tests/home-head-float.test.mjs）
 * ------------------------------------------------------------------
 * 守护「Shadowrocket 式顶部浮层」的结构与显隐/反向联动不回归：
 *  1) 品牌区固定、内容不变；两层浮层是 main 直接子元素的 absolute overlay，
 *     不在 .zp-scroll 文档流内；横条=今日配送/日期，白卡片=数据/插画/多单 tab；
 *  2) 门店列表与统计卡留在 .task-card 文档流，趋势卡在更下方（整页可滚到）；
 *  3) CSS：品牌区取页面底色 --zp-bg 与整页融合、仍作不透明天花板压过浮层、
 *     隐藏态 translateY(-100%) 完全消失、横条 block / 白卡片 surface 两层分层、
 *     spacer 隐藏态 0（不留把手线 / 不占位）；
 *  4) 显隐由「滚动位置」驱动（2026-11-07 第三轮）：p = 1 - clamp((scrollTop-base)/H)，
 *     滚动中禁过渡做 1:1 跟手、停稳吸附到端点并平移 base；不再用 touch 手势驱动
 *     （passive 监听必被 touchcancel 截断，跟手只走十几像素就跳变）；
 *     顶底互斥反向、底栏阈值带滞回；
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

console.log("\n二、CSS：天花板裁切 + 隐藏态完全消失 + 令牌配色 + 补位（9 条）");
{
  const ceiling = rule(CSS, "main.home-app > .topbar");
  t("品牌区作天花板：页面底色 --zp-bg 实底 + relative + 更高层级",
    !!ceiling && /background:var\(--zp-bg\)/.test(ceiling) &&
    /position:relative/.test(ceiling) && /z-index:25/.test(ceiling));
  const float = rule(CSS, ".home-app .zp-head-float");
  t("浮层 absolute 定位、贴品牌区底部、层级低于天花板",
    !!float && /position:absolute/.test(float) &&
    /top:var\(--zp-ceiling-h/.test(float) && /z-index:20/.test(float));
  t("初始按展开态渲染（translateY(0)，JS 就位前不会先闪一下隐藏）",
    !!float && /transform:translateY\(0\)/.test(float) &&
    /\(-\(1-p\)\*100\)/.test(FLOAT_JS));
  const bar = rule(CSS, ".home-app .zp-head-bar");
  const card = rule(CSS, ".home-app .zp-head-card");
  t("横条浮层顶段取 block 令牌（与白卡片分层）", !!bar && /background:var\(--zp-block\)/.test(bar));
  t("品牌区=页面底色、横条=block 刻意分层（浅色下两层不融成全白）",
    !!ceiling && !!bar && /background:var\(--zp-bg\)/.test(ceiling) &&
    /background:var\(--zp-block\)/.test(bar));
  t("白卡片取 surface 令牌（深浅双主题自适应）", !!card && /background:var\(--zp-surface\)/.test(card));
  t("两层配色零字面量（无 #hex / rgb 硬编码）",
    !!bar && !!card && !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(bar + card + (float || "")));
  const spacer = rule(CSS, ".home-app .zp-head-spacer");
  t("让位块隐藏态 height:0（不占位）", !!spacer && /height:0/.test(spacer));
  t("新增浮层不留任何把手线节点",
    !/zp-head-handle|head-handle/.test(CSS) && !/zp-head-handle|head-handle/.test(HTML));
}

console.log("\n三、驱动方式：滚动位置驱动、1:1 跟手、停稳吸附（10 条）");
{
  t("p 由 scrollTop 线性映射：p = 1 - clamp((st-base)/H, 0, 1)",
    /return 1-clamp\(\(st-base\)\/range,0,1\)/.test(FLOAT_JS));
  t("监听 .zp-scroll 的 scroll（passive，不干预原生滚动与惯性）",
    /scroller\.addEventListener\("scroll",onScroll,\{passive:true\}\)/.test(FLOAT_JS));
  t("滚动中直接写 transform、禁过渡（.is-scrolling），严格 1:1 无滞后",
    /float\.classList\.add\("is-scrolling"\)/.test(FLOAT_JS) &&
    /\.zp-head-float\.is-scrolling\{transition:none\}/.test(CSS));
  t("停稳 150ms 后按「是否还在顶部」吸附（st≤40 展开 / 否则收起，不留半开）",
    /setTimeout\(settle,150\)/.test(FLOAT_JS) && /var to=st<=40\?1:0/.test(FLOAT_JS));
  t("吸附时平移 base，避免下一帧 scroll 把 p 拉回半开（回弹）",
    /base=to\?clamp\(st,0,range\):clamp\(st-range,0,range\)/.test(FLOAT_JS));
  t("不再用 touch 驱动显隐（touchstart/move 监听已移除）",
    !/addEventListener\("touch/.test(FLOAT_JS) && !/accDy=ay/.test(FLOAT_JS));
  t("初始 p=1（scrollTop=0 时浮层展开，与页面首帧一致）",
    /var p=1;/.test(FLOAT_JS) && /measure\(\);\s*\n\}\)\(\);/.test(FLOAT_JS));
  t("顶底互斥反向：浮层展开（p≥.65）则底栏沉下、收起（p<.35）则升起（滞回不闪）",
    /p>=\.65/.test(FLOAT_JS) && /p<\.35/.test(FLOAT_JS) && /navHide\(want\)/.test(FLOAT_JS));
  t("只写 transform，绝不改文档流高度（列表零推动）",
    /float\.style\.transform=/.test(FLOAT_JS) && !/style\.height/.test(FLOAT_JS));
  t("ResizeObserver 按浮层实测高度重算天花板与行程 H",
    /new ResizeObserver/.test(FLOAT_JS) && /--zp-ceiling-h/.test(FLOAT_JS) && /H=h/.test(FLOAT_JS));
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
