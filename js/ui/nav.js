/* 智配One · 业务端常驻一级导航（原 js/ui-unified.js 拆分 · 4/6）
 * 底部 5 位导航的注入、「处理中离开」「点击已激活 tab」两道点击守卫，
 * 以及底栏的滚动自隐藏（2026-11-04）。
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
    if(typeof window.zpLeaveProcessing==="function"){
      await window.zpLeaveProcessing(href);
    }else if(typeof window.zpConfirm==="function"){
      const ok=await window.zpConfirm("退出本次处理？","本次识别与规划将中止，尚未保存的结果不会保留。","退出本次处理");
      if(ok)location.replace(href);
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

  /* ===== 底栏滚动自隐藏（2026-11-04 用户提出缺此交互） =====
     浮岛化后底栏仍是常驻 fixed，长列表滚到中途会压住内容。规则取主流 App 口径：
       · 向下滚、离开顶部一段后，累计位移到阈值 → 收起
       · 向上滚累计到位 → 立刻回来（回滑即回，不等停手）
       · 滚到顶部 → 强制显示（回顶时底栏应在，避免「滚回去却空着」的突兀）
     注意：滚到【底部】不再强制弹起——与 Uber 一致：尾段若已收起就保持收起，
     用户继续上滑/回滑才回来。页面内容为底栏让的 88px 在底栏收起时本就留作末段余白，
     这是浮动底栏的固有取舍，Uber 同样如此。
     几条实现约束：
       · scroll 不冒泡，只能用捕获阶段监听；同时覆盖 .zp-scroll 内滚与整页滚动。
       · 首页底栏是 HTML 静态写的、其余页由上面注入，故一律按类名现取，不持有引用。
       · 只认「页面级主滚动容器」类名（.zp-scroll / .order-store-list），不靠占屏比例：
         首页「今日门店」内嵌列表、帮助弹层、导入面板等内嵌滚动不带这些类，天然被排除，
         在小区块里划两下不会把底栏收掉。改类名识别是为修「隐藏失效」——「占屏过半」
         这类比例判据在真机上不可靠：PWA standalone 顶部白条让视口高度与容器高度
         语义错位，数据中心固定工具区展开、order 页顶部卡片、分屏 / 系统大字号都会把
         主滚动区压到过半以下，一旦低于门槛整页怎么滚底栏都不收。
       · 阈值用累计位移而非单帧位移：惯性滚动每帧只有几 px，单帧判断收不起来。 */
  var NAV_HIDE_DELTA=8;    // 累计位移达到这个数才切换，抗抖动
  var NAV_SHOW_TOP=56;     // 距顶这个范围内永远显示（底栏不强显，随 Uber 口径）
  var navEl=null,navHidden=false,navLastY=-1,navAcc=0,navTicking=false;

  function navScrollTarget(e){
    var el=e.target;
    // 整页滚动（document/window 触发）→ 认文档滚动元素，覆盖「降级为整页滚动」的页面
    if(!el||el===document||el===window)return document.scrollingElement||document.documentElement;
    if(el.nodeType!==1)return null;
    // 只认页面级主滚动容器类名，且确实可滚动。不用「占屏过半」的比例判据：
    // 该类比例在真机（PWA 白条 / 固定区展开 / 大字号 / 分屏）会误判主滚动区为「小区块」，
    // 导致底栏完全不隐藏（数据中心隐藏失效的根因）。
    if((el.classList.contains("zp-scroll")||el.classList.contains("order-store-list"))&&
       el.scrollHeight-el.clientHeight>4)return el;
    return null;
  }
  function navApply(hide){
    if(!navEl||!navEl.isConnected){
      navEl=document.querySelector(".zp-nav");
      if(!navEl)return;
      navHidden=navEl.classList.contains("is-nav-hidden"); // 元素被替换过时以实际类名为准
    }
    if(navHidden===hide)return;
    navHidden=hide;
    navEl.classList.toggle("is-nav-hidden",hide);
    // inert 让收起后的底栏退出现行 Tab 序：位移出屏只是看不见，键盘/读屏仍会停在里面。
    if(hide)navEl.setAttribute("inert","");else navEl.removeAttribute("inert");
  }
  function navOnScroll(e){
    var el=navScrollTarget(e);
    if(!el||navTicking)return;
    navTicking=true;
    requestAnimationFrame(function(){
      navTicking=false;
      var y=el.scrollTop;
      if(navLastY<0){navLastY=y;return;}   // 首帧只记位置：恢复滚动位置跳进来时不当作「向下滚了很远」
      var max=el.scrollHeight-el.clientHeight;
      var dy=y-navLastY;
      navLastY=y;
      if(y<=NAV_SHOW_TOP){navAcc=0;navApply(false);return;}
      navAcc=dy>0?Math.max(0,navAcc)+dy:Math.min(0,navAcc)+dy;
      if(navAcc>=NAV_HIDE_DELTA){navAcc=0;navApply(true);}
      else if(navAcc<=-NAV_HIDE_DELTA){navAcc=0;navApply(false);}
    });
  }
  document.addEventListener("scroll",navOnScroll,{capture:true,passive:true});
})();
/* 业务端一级导航样式见 css/ui-overlay.css / css/ui-theme.css（.zp-business-nav-page 相关规则）。
   历史教训：曾有人把 CSS 整段粘贴进 JS，导致文件语法错误、整个 UI 层全部失效——
   现在已有 tests/js-syntax.test.mjs 在 CI 里挡住这一类改动。 */
