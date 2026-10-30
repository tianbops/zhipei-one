/* home/core.js —— 共享 DOM 引用、线路状态与徽标渲染
   必须是 js/home/ 的第一个模块：后续模块直接复用这里的 $ / todayCount / dispatchRouteId…
   可见性依据：经典脚本顶层 const/let 落在共享的全局词法环境，后续脚本可直接引用。 */
const $=id=>document.getElementById(id);
const overlay=$("uploadArea"),cancel=$("sourceCancel");
const todayOrders=$("todayOrders"),todayCount=$("todayCount"),todayWeight=$("todayWeight"),todayStoreList=$("todayStoreList"),todayMetrics=$("todayMetrics"),dot=$("statusDot");
let dispatchRouteId="";
let boundRouteId="";
const TEMP_ROUTE_PREFIX="__temp__:";
const subBadge=$("substituteBadge");
/* 代班态提示：用户当前调度线路是「真实线路」且与本人绑定线路不一致时，视为「代班中」。
   仅作展示（今日配送卡片里一个「代班」状态文字），不碰任何权限逻辑；
   线路名已由卡片 statusDot / 当前线路菜单项展示，这里只补一行状态文案。
   判定要点：
     - 新注册用户 boundRouteId 默认为 null（仅管理员绑定后才有值），且 dispatch GET 会给
       无绑定用户分配每人独立的临时线路 __temp__:<id> 作为「家」；故不能用「boundRouteId 非空」
       作为门槛（那会把所有未绑定账号挡掉，代班提示永远不出现）。
     - 临时线路（__temp__: 开头）算用户的「家」，不算代班；真实线路且非本人绑定线路才算代班。
     - 未绑定账号切到任意真实线路 -> 代班中（他本就没有「自己的线路」，此刻正在替班）。 */
const renderSubstituteBadge=()=>{
  if(!subBadge)return;
  const isSubstitute=!!dispatchRouteId&&!dispatchRouteId.startsWith(TEMP_ROUTE_PREFIX)&&dispatchRouteId!==boundRouteId;
  subBadge.hidden=!isSubstitute;
};
const setEmptyToday=()=>{if(todayOrders)todayOrders.textContent="";todayCount.textContent="暂无运单";todayWeight.textContent="";if(todayStoreList)todayStoreList.innerHTML='<div class="zp-empty zp-empty--tight">今日暂无配送门店</div>';if(todayMetrics)todayMetrics.innerHTML=""};
const setRouteBadge=(route)=>{if(!dot)return;const type=route?.type||"";const name=String(route?.name||"").trim();
  /* 全局标准：圆点内只显示线路数字（临时线路显示「临」），「X号线」全名用于文字位置 */
  const badge=(type==="temporary"||/临时/.test(name))?"临":(window.zpRouteShort?window.zpRouteShort(name):(name.match(/\d+/)?.[0]||name.replace(/\s+/g,"").slice(0,2)||"—"));
  dot.textContent=badge;dot.hidden=false};