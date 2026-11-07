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
 *  4) 显隐是「二态弹收」（2026-11-07 第五轮）：只有 p=1/p=0 两个稳定态，跨阈值
 *     （回顶部 ≤8 弹出 / 离开 >48 收回）整块切一次，走 --zp-island-* 过渡；
 *     不做 scrollTop 比例跟随（用户：「不弹出和收回，只是随着屏幕滚动了」）；
 *     纯 overlay、不写任何文档流高度（列表零推动）；不用 touch 手势驱动；
 *     顶底互斥反向、与底栏同帧起步停住；
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
  t("不再有让位块节点（纯 overlay：名单直接从卡片首块开始）",
    iSpacer < 0 && !/zp-head-spacer/.test(HTML));
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
  t("样式表里也没有 .zp-head-spacer 残条（结构 / 样式同步删干净）",
    !/\.zp-head-spacer/.test(CSS));
  t("新增浮层不留任何把手线节点",
    !/zp-head-handle|head-handle/.test(CSS) && !/zp-head-handle|head-handle/.test(HTML));
}

console.log("\n三、驱动方式：方向驱动二态弹收（上滑顶出/下滑顶隐，一动就反应）（13 条）");
{
  t("只有 1/0 两个稳定态：apply(show) 一次写到底（p=show?1:0）",
    /function apply\(show\)\{/.test(FLOAT_JS) && /p=show\?1:0;/.test(FLOAT_JS));
  t("方向对调（2026-11-07 第七轮）：上滑 ≥6px 上方弹出、下滑 ≥6px 上方隐藏",
    /var TOP_AT=6, MOVE=6;/.test(FLOAT_JS) &&
    /if\(acc>=MOVE\)\{[\s\S]{0,120}?if\(!shown\)apply\(true\)/.test(FLOAT_JS) &&
    /if\(acc<=-MOVE\)\{[\s\S]{0,120}?if\(shown\)apply\(false\)/.test(FLOAT_JS));
  t("取消「回顶部必弹」的位置例外：顶部只用于首帧定态，之后完全由方向决定",
    !/if\(st<=TOP_AT\)\{[\s\S]{0,80}?apply\(true\)/.test(FLOAT_JS) &&
    /shown=scroller\.scrollTop>TOP_AT\?false:true/.test(FLOAT_JS));
  t("不做比例跟随：没有 scrollTop 线性映射（mapP / (st-base)/range 全部移除）",
    !/mapP|mapP\(/.test(FLOAT_JS) && !/\(st-base\)\/range/.test(FLOAT_JS));
  t("只累计同向位移，方向一反转立即清零（惯性回弹/手抖不来回闪）",
    /\(\(acc>0\)!==\(d>0\)\)acc=0;/.test(FLOAT_JS) && /var lastSt=0, acc=0;/.test(FLOAT_JS));
  t("滚动帧只在跨方向时改一次状态，其余帧只读 scrollTop",
    /function frame\(\)\{[\s\S]*?if\(!shown\)apply\(true\)[\s\S]*?if\(shown\)apply\(false\)[\s\S]*?\n  \}/.test(FLOAT_JS) &&
    !/frame\(\)\{[\s\S]*float\.style\.transform/.test(FLOAT_JS));
  const applyBody = (/function apply\(show\)\{([\s\S]*?)\n  \}/.exec(FLOAT_JS) || [])[1] || "";
  t("状态切换一律走 --zp-island-* 过渡（apply 内不关过渡，瞬时态只留给首帧 / 探针）",
    /\.zp-head-float\{[\s\S]*?transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(CSS) &&
    /\.zp-head-float\.is-scrolling\{transition:none\}/.test(CSS) &&
    applyBody.length > 20 && !/is-scrolling/.test(applyBody), applyBody.trim().slice(0, 80));
  t("监听 .zp-scroll 的 scroll（passive，不干预原生滚动与惯性）",
    /scroller\.addEventListener\("scroll",onScroll,\{passive:true\}\)/.test(FLOAT_JS));
  t("彻底不接管 touch（无 touch 监听、无 preventDefault）",
    !/addEventListener\("touch/.test(FLOAT_JS) && !/\.preventDefault\(/.test(FLOAT_JS));
  t("初始 p=1（scrollTop=0 时浮岛展开，与页面首帧一致）",
    /var p=1;/.test(FLOAT_JS) && /measure\(\);\s*\n\}\)\(\);/.test(FLOAT_JS));
  t("顶底呼应：底栏跟同一次状态切换走，同一帧起步停住",
    /function syncNav\(\)\{\s*\n\s*var want=p>=\.5;/.test(FLOAT_JS) && /syncNav\(\);/.test(FLOAT_JS));
  t("只写 transform，绝不写文档流高度（列表零推动）",
    /float\.style\.transform=/.test(FLOAT_JS) && !/style\.height/.test(FLOAT_JS));
  t("ResizeObserver 重算天花板高度（--zp-ceiling-h）",
    /new ResizeObserver/.test(FLOAT_JS) && /--zp-ceiling-h/.test(FLOAT_JS) && /topbar\.getBoundingClientRect/.test(FLOAT_JS));
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
