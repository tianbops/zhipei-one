/**
 * 首页「今日配送」高度行为契约（node tests/home-today-grow.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求（2026-11-06 用户改）：
 *   「人物小推车部分固定，下方门店名称部分滚动；多运单 tab 也固定在里面」，
 *   以及「头部在首页常显，不随门店滚动而上滚」——后者靠锁死外层滚动实现。
 *
 * 实现要点（易回归，必须锁死）：
 *   1) 基础段（@media 之外）：外层 .zp-scroll overflow:hidden（首页没有滚动量，
 *      头部从结构上锁死）；卡片高度 = 一屏（height:100% + border-box），
 *      卡片内 flex 列，标题 / 摘要+插画 / tab / 底部指标 flex:0 0 auto（不可被压缩，
 *      否则 tab 会被 flex 压成 22px、文字切一半）；
 *   2) 名单区 flex:1 1 auto + min-height:0 + overflow:hidden，纵向滚动落在
 *      .today-page 上（height:100% + overflow-y:auto），横向轨道仍由 view 裁切；
 *   3) 降级 A/B（矮屏/横屏/键盘）回退整页滚动：卡片 height:auto、列表
 *      overflow:visible、页内 overflow 关闭 —— 矮屏里绝不把卡片压成一条；
 *   4) 空态高度仍由 .zp-empty--tight 的 176px 定死（44 × 4），不依赖 JS 加类；
 *   5) zpSyncTodayHeight 只在降级版面锁高，正常版面必须清空内联高度，
 *      否则卡片被顶出屏幕。
 *   月度统计卡（#trendCard）在原位保留但被裁掉，属用户确认的代价，不在此断言。
 * 注意：基础规则与降级规则（@media 内）选择器同名，靠源码顺序层叠，
 *      故此处分别断言两段的取值。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("../css/home-dashboard.css", import.meta.url)), "utf8");
const JS = readFileSync(fileURLToPath(new URL("../js/home/today.js", import.meta.url)), "utf8");
const FIT = readFileSync(fileURLToPath(new URL("../js/home/fit.js", import.meta.url)), "utf8");
const NAV = readFileSync(fileURLToPath(new URL("../js/ui/nav.js", import.meta.url)), "utf8");

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
// 基础段：从「首页纵向布局」注释到降级 A（@media max-height:759px）之前。
const baseStart = CSS.indexOf("首页纵向布局");
const aIdx = CSS.indexOf("@media (max-height:759px)");
const BASE = CSS.slice(baseStart, aIdx < 0 ? CSS.length : aIdx);

console.log("首页今日配送一屏内滚契约（基础段 8 条）");
{
  const scroller = rule(BASE, "main.home-app .zp-scroll");
  t("滚动容器基础段 display:flex（整页竖链）",
    !!scroller && /display:flex/.test(scroller), scroller);
  t("滚动容器基础段 overflow:hidden（2026-11-06 锁一屏：外层无滚动量，头部常显）",
    !!scroller && /overflow:hidden/.test(scroller) && !/overflow-y:auto/.test(scroller), scroller);
  t("滚动容器基础段再叠 overflow:clip（连 focus / scrollIntoView 的程序滚动也禁止）",
    !!scroller && /overflow:clip/.test(scroller) && scroller.indexOf("overflow:clip") > scroller.indexOf("overflow:hidden"), scroller);
  t("滚动容器基础段 overscroll-behavior-y:none（不参与任何连锁）",
    !!scroller && /overscroll-behavior-y:none/.test(scroller), scroller);

  const card = rule(BASE, "main.home-app .task-card");
  t("卡片基础段 height:100%（= 滚动区一屏）",
    !!card && /height:100%/.test(card), card);
  t("卡片基础段 box-sizing:border-box（业务端无全局盒模型，否则 padding 会顶出屏幕）",
    !!card && /box-sizing:border-box/.test(card), card);
  t("卡片基础段 flex 列布局（头部固定、名单吃剩余）",
    !!card && /display:flex/.test(card) && /flex-direction:column/.test(card), card);

  const list = rule(BASE, "main.home-app .today-store-list");
  t("名单区基础段 flex:1 1 auto + min-height:0（吃掉卡片剩余高度并可收缩）",
    !!list && /flex:1 1 auto/.test(list) && /min-height:0/.test(list), list);
  t("名单区基础段 overflow:hidden（只裁横向相邻页，纵向滚动不在这一层）",
    !!list && /overflow:hidden/.test(list), list);

  /* 三条头是同一个规则组（逗号选择器），单独取某一条拿不到声明，故整组匹配。
     2026-11-06 定稿：标题/摘要/tab 已从 .task-card 直接子级搬进 .zp-head-island。 */
  const heads = /main\.home-app \.zp-head-island \.task-title,\s*main\.home-app \.zp-head-island \.task-main,\s*main\.home-app \.zp-head-island \.today-tabs\{flex:0 0 auto\}/.test(BASE)
    ? "flex:0 0 auto" : null;
  t("浮岛内三段（标题/摘要/tab）flex:0 0 auto，不被 flex 压缩",
    !!heads, heads);
}

console.log("\n浮岛收放契约（9 条）");
{
  /* 用户定稿：品牌不入浮岛；数据区独立成浮岛，下滑隐藏、上滑弹出；
     门店去浮岛（无圆角/无底色，直接铺页面）。 */
  const wrap = rule(BASE, "main.home-app .zp-head-wrap");
  t("浮岛外壳高度取 --zp-head-h（JS 量出的自然高，单/多单自动适配）",
    !!wrap && /height:var\(--zp-head-h/.test(wrap), wrap);
  t("浮岛外壳高度不加过渡（与 scrollTop 补偿必须同帧，否则列表先跳后回）",
    !!wrap && !/transition:\s*height/.test(wrap), wrap);

  const offWrap = rule(CSS, "main.home-app.is-head-hidden .zp-head-wrap");
  t("收起态外壳高度收到 10px（留着放把手线）",
    !!offWrap && /height:10px/.test(offWrap), offWrap);

  const island = rule(BASE, "main.home-app .zp-head-island");
  t("浮岛绝对定位 + z-index:2（盖在列表之上，滑出时遮住列表的瞬时上移）",
    !!island && /position:absolute/.test(island) && /z-index:2/.test(island), island);
  t("浮岛只在 transform 上做过渡（滑动由它承担）",
    !!island && /transition:transform/.test(island), island);

  const offIsland = rule(CSS, "main.home-app.is-head-hidden .zp-head-island");
  t("收起态浮岛 translateY(-100%) 滑出卡片顶边",
    !!offIsland && /transform:translateY\(-100%\)/.test(offIsland), offIsland);

  const handle = rule(BASE, "main.home-app .zp-head-handle");
  t("把手线默认透明、收起后可见（提示可上滑唤出）",
    !!handle && /opacity:0/.test(handle) &&
    /\.is-head-hidden \.zp-head-handle\{opacity:\.42/.test(CSS), handle);

  const list = rule(BASE, "main.home-app .today-store-list");
  t("门店区去浮岛：无背景、无描边、无圆角",
    !!list && !/background:/.test(list) && !/border:/.test(list) && !/border-radius/.test(list), list);
  t("门店左右缩进放在页内（列表容器 clientWidth 是轨道位移基准，不能带 padding）",
    !!list && /padding:0;/.test(list) && /\.today-page\{padding:0 12px\}/.test(CSS), list);
}

console.log("\n名单页内滚动契约（5 条）");
{
  const view = rule(CSS, ".today-view");
  t("view 基础段 flex:1 1 auto + min-height:0",
    !!view && /flex:1 1 auto/.test(view) && /min-height:0/.test(view), view);
  const page = rule(CSS, ".today-page");
  t("page height:100%（相对 track，撑满名单区）",
    !!page && /height:100%/.test(page), page);
  t("page overflow-y:auto（纵向滚动落在页内，横向仍归 JS 手势）",
    !!page && /overflow-y:auto/.test(page), page);
  /* 2026-11-06 用户录屏「固定没实现」：名单滚到底后滚动链把外层带走 226px，
     摘要从 top:148 漂到 -78。修法是 .is-scrollable 时切断连锁 ——
     这条必须锁死，回退成 auto 会当场复现「头部被顶走」。 */
  const pageScrollable = rule(CSS, ".today-page.is-scrollable");
  t("可滚名单 .is-scrollable 时 overscroll-behavior-y:contain（切断滚动链，头部不被顶走）",
    !!pageScrollable && /overscroll-behavior-y:contain/.test(pageScrollable), pageScrollable);
  t("基础 .today-page 默认允许连锁（只在确实溢出时才加 contain，不做无条件拦截）",
    !!page && /overscroll-behavior-y:auto/.test(page), page);
}

console.log("\n空态 4 排列契约（2 条）");
{
  // 高度改由「内容结构」在纯 CSS 里定死：列表内唯一的 .zp-empty--tight 自带 176px。
  const tight = rule(CSS, "main.home-app .today-store-list > .zp-empty--tight");
  t("空态高度由内容元素 CSS 定死 min-height:176px（= 44px × 4，不依赖 JS 加类）",
    !!tight && /min-height:176px/.test(tight), tight);
  const empty = rule(CSS, "main.home-app .today-store-list.is-empty");
  t("空态文案贴顶（align-items:flex-start，非垂直居中）",
    !!empty && /align-items:flex-start/.test(empty) && !/align-items:center/.test(empty), empty);
}

console.log("\n降级段回退整页滚动（4 条）");
{
  /* 矮屏 / 横屏 / 键盘：卡片若继续锁一屏会被压成一条，必须回退块级 + 整页滚动。 */
  const aBlock = CSS.slice(aIdx < 0 ? 0 : aIdx, CSS.indexOf("降级 B"));
  t("降级 A 卡片 height:auto（不锁一屏）",
    aIdx > 0 && /main\.home-app \.task-card\{display:block;height:auto\}/.test(aBlock), aBlock.slice(0, 200));
  t("降级 A 名单区 overflow:visible + 页内 overflow 关闭（恢复内容高度）",
    aIdx > 0 && /\.today-store-list\{display:block;overflow:visible\}/.test(aBlock) &&
    /\.today-page\{height:auto;overflow:visible\}/.test(aBlock), aBlock.slice(0, 240));

  const bStart = CSS.indexOf("main.home-app.is-keyboard .zp-scroll");
  const BJ = CSS.slice(bStart, CSS.indexOf("空态（今日暂无配送门店）"));
  t("降级 B 卡片 height:auto",
    bStart > 0 && /main\.home-app\.is-keyboard \.task-card\{display:block;height:auto\}/.test(BJ), BJ.slice(0, 200));
  t("降级 B 名单区同样回到内容高度（overflow:visible）",
    bStart > 0 && /\.today-store-list\{display:block;overflow:visible\}/.test(BJ) &&
    /\.today-page\{height:auto;overflow:visible\}/.test(BJ), BJ.slice(0, 240));
}

console.log("\n高度同步 JS 契约（5 条）");
{
  t("zpSyncTodayHeight 只在降级版面锁高，正常版面清空内联高度",
    /zpTodayFallbackLayout/.test(JS) && /style\.height=""/.test(JS));
  t("降级判定同时覆盖矮屏/横屏与键盘（matchMedia + is-keyboard）",
    /max-height:759px/.test(JS) && /is-keyboard/.test(JS));
  /* 名单能不能滚要按「是否真的溢出」判断：一律 contain 会让短名单的卡片滑不动，
     滚不到下方月度统计；一律 auto 则长名单到底会把头部顶走。 */
  t("zpMarkTodayScrollable 按溢出量打标（scrollHeight - clientHeight > 2）",
    /function zpMarkTodayScrollable/.test(JS) && /scrollHeight-p\.clientHeight>2/.test(JS));
  t("标记在 zpSyncTodayHeight 里刷新（渲染/切页/resize 都会走到）",
    /zpMarkTodayScrollable\(\);\s*\n\s*if\(todayStoreList\.classList\.contains\("is-empty"\)\)/.test(JS));
  t("行情变化由 MutationObserver 兜住（克隆/换行等不走高度同步路径时也重算）",
    /new MutationObserver\([\s\S]{0,240}?zpMarkTodayScrollable/.test(JS));
}

console.log("\n浮岛收放 JS 契约（5 条）");
{
  t("对外暴露 zpHeadShow（切单/切 tab 时强制弹回）",
    /window\.zpHeadShow\s*=/.test(JS));
  t("切单路径调用 zpHeadShow（go 内，切完能看到换成了哪一单）",
    /zpSetTodaySelId\(list\[i\]\.id\);[\s\S]{0,200}?zpHeadShow/.test(JS));
  t("收起时补偿 scrollTop（内容原地不动，否则门店整体上跳 150px）",
    /page\.scrollTop=page\.scrollTop-s/.test(JS));
  t("补偿后锁方向判定 280ms（否则补偿触发的 scroll 被当成反向手势，来回抖死循环）",
    /lockUntil=Date\.now\(\)\+280/.test(JS) && /Date\.now\(\)<lockUntil/.test(JS));
  t("滚动监听用 capture 且只认 .today-page（scroll 不冒泡，必须捕获）",
    /\{capture:true,passive:true\}/.test(JS) && /classList\.contains\("today-page"\)/.test(JS));
}

console.log("\n顶底浮岛联动契约（5 条）");
{
  /* 用户 2026-11-06：「顶部浮岛也是要像底部浮岛一样自动隐藏功能」。
     首页锁一屏后名单在 .today-page 内滚，nav.js 的滚动判定收不到，
     底栏不会动 —— 必须由 today.js 在收/放顶部浮岛时显式通知。 */
  t("nav.js 对外暴露 zpNavSetHidden（内部走 navApply，状态与类名不脱节）",
    /window\.zpNavSetHidden=function\(hide\)\{navApply\(!!hide\)\}/.test(NAV));
  t("today.js 收起顶部浮岛时同步收起底栏", /navSync\(true\)/.test(JS));
  t("today.js 弹出顶部浮岛时同步放回底栏", /navSync\(false\)/.test(JS));
  t("底栏通知包在 try 里（nav.js 未加载时首页照常工作）",
    /try\{window\.zpNavSetHidden&&window\.zpNavSetHidden\(hide\)\}catch\{\}/.test(JS));
  /* 月卡紧接卡片、落在底部 88px 留白里会露出半个卡头。用同色遮挡盖住，
     不能用 clip-path：Chromium 会把 fixed 的底栏一起裁掉（加号随之消失）。 */
  const mask = CSS.slice(CSS.indexOf("main.home-app .zp-scroll::after"));
  t("底部留白用同色遮挡盖住月度卡露头（background 取 --zp-bg，不另造色）",
    /main\.home-app \.zp-scroll::after\{[\s\S]{0,240}?background:var\(--zp-bg\)/.test(CSS) &&
    /position:absolute/.test(mask) && /pointer-events:none/.test(mask));
}

console.log("\nfit.js 契约（3 条）");
{
  t("fit.js 只维护空态对齐类 .is-empty（不再维护 has-content / can-scroll）",
    /classList\.toggle\("is-empty"/.test(FIT) &&
    !/classList\.toggle\("has-content"/.test(FIT) && !/classList\.toggle\("can-scroll"/.test(FIT));
  t("fit.js 不做高度测量 / 不回退 is-overflow（高度由 CSS 决定）",
    !/classList\.[a-z]+\("is-overflow"/.test(FIT) && !/scrollHeight/.test(FIT));
  t("fit.js 用 MutationObserver 监听列表 childList，数据到达即时复核",
    /new MutationObserver\([\s\S]*?\)\.observe\(list,\s*\{\s*childList:\s*true\s*\}\)/.test(FIT));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
