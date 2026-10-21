/* ===== 页面跳转预取（2026-10-20 中国大陆慢网专项）=====
 * 背景：线上实测（不走 VPN）跨境链路每个新连接 TLS 握手要 2~13s，单次文档 TTFB
 * 0.35~7.4s，而页面又没有校验器可协商缓存 —— 这就是「页面之间跳转慢」的全部来源。
 * 客户端能补的一环：在用户点下去之前就把目标页的 HTML 和连接预热好，
 * 让「点击 → 看到页面」不再压着这段跨境往返。
 *
 * 三条铁律（勿改，tests/nav-prefetch.test.mjs 逐条断言）：
 *   1. 只预取**静态页面 HTML**。/api/*、第三方域名一律不碰（SW 也不缓存 API）。
 *   2. 弱网/省流量模式直接放弃（navigator.connection.saveData / 2g）。
 *   3. 全程 try/catch + 幂等去重，任何异常都不能影响主流程。
 *
 * （原 js/ui-unified.js 拆分 · 6/6，无依赖，可最后加载）
 */
(function(){
  if(typeof window==="undefined"||!window.document)return;
  if(window.__zpNavPrefetchInstalled)return;
  window.__zpNavPrefetchInstalled=true;

  /* 每个页面出发最可能去的地方。只填相对固定的全静态目标，
     带业务参数的详情页（如 order_detail?date=…）放它的基础路径即可：
     预取只是暖 HTTP 缓存，详情页自己仍会按参数重新取数据。 */
  const TARGETS={
    "/home":["/pages/today","/pages/history","/pages/dispatch","/pages/account"],
    "/home.html":["/pages/today","/pages/history","/pages/dispatch","/pages/account"],
    "/today":["/home","/pages/history"],
    "/pages/today":["/home","/pages/history"],
    "/history":["/home","/pages/order_detail"],
    "/pages/history":["/home","/pages/order_detail"],
    "/dispatch":["/home","/pages/history"],
    "/pages/dispatch":["/home","/pages/history"],
    "/account":["/home"],
    "/pages/account":["/home"],
    "/data":["/home"],
    "/pages/data":["/home"],
    "/admin":["/home"],
  };
  const DEFAULT_TARGETS=["/home"];
  const MAX=4;                       // 一次会话最多预取几个，别把弱网带宽挤光
  const done=new Set();

  const normalize=raw=>{
    try{const u=new URL(raw,location.href);
      if(u.origin!==location.origin)return null;             // 第三方不碰
      const p=u.pathname.replace(/\/+$/,"")||"/";
      if(p.indexOf("/api/")===0)return null;                 // 业务数据不碰
      return p;
    }catch(e){return null}
  };
  const allowed=()=>{
    try{const c=navigator.connection||navigator.mozConnection||null;
      if(c&&(c.saveData||/(^|-)2g$|^slow-2g$/.test(c.effectiveType||"")))return false;
    }catch(e){}
    return true;
  };
  const prefetch=raw=>{
    try{
      const path=normalize(raw);
      if(!path||done.has(path)||done.size>=MAX)return false;
      done.add(path);
      const link=document.createElement("link");
      link.rel="prefetch";            // 低优先级，不与当前页资源抢带宽
      link.as="document";
      link.href=path;
      link.crossOrigin="anonymous";
      (document.head||document.documentElement).appendChild(link);
      return true;
    }catch(e){return false}
  };
  /* 空闲时预热：把「下一批可能去的页面」的 TCP/TLS 连接先建立起来。
     即使浏览器策略没把结果放进 HTTP 缓存，连接预热本身也省掉了最贵的握手。 */
  const warmOnIdle=()=>{
    if(!allowed())return;
    const key=(location.pathname||"/").replace(/\/+$/,"")||"/";
    const list=TARGETS[key]||DEFAULT_TARGETS;
    list.forEach(prefetch);
  };
  try{
    if(window.requestIdleCallback)window.requestIdleCallback(warmOnIdle,{timeout:2500});
    else setTimeout(warmOnIdle,1500);
  }catch(e){try{setTimeout(warmOnIdle,1500)}catch(_){}}

  /* 意图预取：pointerdown/touchstart 比 click 早几十到几百毫秒，
     这段时间足够把目标页的连接甚至文档准备好。 */
  document.addEventListener("pointerdown",e=>{
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(a)prefetch(a.getAttribute("href"));
  },{passive:true,capture:true});
  document.addEventListener("touchstart",e=>{
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(a)prefetch(a.getAttribute("href"));
  },{passive:true,capture:true});
})();
