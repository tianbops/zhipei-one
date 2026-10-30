/* 智配One · 业务端常驻一级导航（原 js/ui-unified.js 拆分 · 4/6）
 * 底部 5 位导航的注入，以及「处理中离开」「点击已激活 tab」两道点击守卫。
 * 依赖：core.js（区域判定）、feedback.js（zpConfirm，运行时才用）
 */
(function(){
  if(window.__zpNavInstalled)return;
  window.__zpNavInstalled=true;
  const UI=window.__zpUi;

  /* ===== 业务端常驻一级导航 ===== */
  function zpEnsureBusinessBottomNav(){
    // 直接调 UI.detectZone() 而不读任何在本函数之后声明的 const：
    // 本文件在 readyState!=="loading"（defer / 动态注入）时，底部这两行会先于
    // 那些声明执行，读 const 会触发 TDZ ReferenceError，导致整个常驻导航静默消失。
    // UI.detectZone 由 core.js 提供，先于本文件加载，可安全提前调用。
    if(UI.detectZone()!=="business")return;
    document.body.classList.add("zp-business-nav-page");
    if(document.querySelector(".zp-nav"))return;
    const path=UI.normPath(location.pathname);
    const q=new URLSearchParams(location.search);
    let active="";
    if(path==="/home")active="home";
    else if(path==="/pages/history")active="history";
    else if(path==="/pages/dispatch"||path==="/pages/data"||path==="/pages/route_apply")active="route";
    else if(path==="/pages/account")active="account";
    else if(path==="/pages/order_detail")active=(q.get("source")==="history"||q.get("from")==="history")?"history":"home";
    else if(path==="/pages/today")active="home";
    // 5 位结构：首页 / 历史 / 中间上传加号 / 线路 / 我的。
    // 「上传」由普通 tab 改为中心凸起圆形加号（plus:true 无文字标签，仅图标）。
    const items=[
      {id:"home",label:"首页",href:"/home",cls:"zp-nav-home",icon:'<path d="M3.5 9.8 12 3.5l8.5 6.3V19a1.5 1.5 0 0 1-1.5 1.5h-3.2v-6H9.2v6H5A1.5 1.5 0 0 1 3.5 19z"/>'},
      {id:"history",label:"历史",href:"/pages/history?from=home",icon:'<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 5v4h4"/><path d="M12 7.5v5l3.2 1.9"/>'},
      {id:"upload",label:"上传",href:"/home?openUpload=1",plus:true,icon:'<path d="M12 5v14"/><path d="M5 12h14"/>'},
      {id:"route",label:"线路",href:"/pages/dispatch?from=home",icon:'<path d="M4 6h16v12H4z"/><path d="M8 10h8M8 14h5"/>'},
      {id:"account",label:"我的",href:"/pages/account?from=home",icon:'<circle cx="12" cy="8" r="3"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/>'}
    ];
    const nav=document.createElement("nav");
    nav.className="zp-nav";
    nav.setAttribute("aria-label","主要功能");
    nav.innerHTML=items.map(item=>{
      const cls="zp-nav-item"+(item.cls?" "+item.cls:"")+(item.plus?" zp-nav-plus":"")+(active===item.id?" is-active":"");
      const label=item.plus?"":'<span>'+item.label+'</span>';
      const dim=item.plus?'width="24" height="24" stroke-width="2.2"':'width="21" height="21" stroke-width="1.8"';
      return '<a class="'+cls+'" href="'+item.href+'"'+(active===item.id?' aria-current="page"':"")+(item.plus?' aria-label="'+item.label+'"':'')+'><span class="zp-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" '+dim+' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">'+item.icon+'</svg></span>'+label+'</a>';
    }).join("");
    document.body.appendChild(nav);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",zpEnsureBusinessBottomNav,{once:true});
  else zpEnsureBusinessBottomNav();

  // 业务处理进行中时，常驻导航不能无提示地把用户带离当前运单流程。
  document.addEventListener("click",async e=>{
    const link=e.target.closest?.(".zp-nav a");
    if(!link||typeof window.zpIsProcessing!=="function"||!window.zpIsProcessing())return;
    const href=link.getAttribute("href")||"";
    if(!href||link.dataset.zpNavGuarded==="1")return;
    e.preventDefault();
    e.stopPropagation();
    if(typeof window.zpConfirm==="function"){
      const ok=await window.zpConfirm("正在处理运单","当前运单仍在识别与规划中，离开将中断本次处理。确定离开吗？","离开");
      if(ok)location.replace(href);
    }else if(confirm("当前运单仍在处理中，离开将中断本次处理。确定离开吗？")){
      location.replace(href);
    }
  },true);

  // 一级导航：点击已激活的底部 tab 不再跳回首页（已有独立首页按钮，跳转属多余），
  // 而是停留在当前页并把内容滚回顶部（成熟 App 范式，如微信/Instagram）。
  // 点击未激活 tab 仍照常导航到对应页面（走 a 默认 href）。
  // 首页上传弹窗的 toggle 由 home.js 处理（#uploadAction，非 a 标签，不走本规则）。
  document.addEventListener("click",e=>{
    const active=e.target.closest?.(".zp-nav a.is-active");
    if(!active)return;
    if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing())return; // 处理中交由上方守卫确认
    e.preventDefault();
    const scroller=document.querySelector(".zp-scroll");
    if(scroller)scroller.scrollTop=0;
    window.scrollTo(0,0);
  },true);
})();
/* 业务端一级导航样式见 css/ui-overlay.css / css/ui-theme.css（.zp-business-nav-page 相关规则）。
   历史教训：曾有人把 CSS 整段粘贴进 JS，导致文件语法错误、整个 UI 层全部失效——
   现在已有 tests/js-syntax.test.mjs 在 CI 里挡住这一类改动。 */
