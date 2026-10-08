/* 智配One · 全局 UI 反馈 2.1
   只处理弹窗/Toast，不包含业务逻辑。 */
(function(){
  if(window.zpConfirm)return;
  function esc(v){return String(v??"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]))}
  function ensure(){
    let el=document.getElementById("zpUiLayer");
    if(el)return el;
    el=document.createElement("div");
    el.id="zpUiLayer";
    el.innerHTML='<div class="zp-confirm" hidden><div class="zp-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="zpConfirmTitle"><h3 id="zpConfirmTitle"></h3><p id="zpConfirmText"></p><div class="zp-confirm-actions"><button type="button" data-zp-cancel>取消</button><button type="button" data-zp-ok>确定</button></div></div></div><div class="ui-toast" id="zpToast" aria-live="polite"></div>';
    document.body.appendChild(el);
    return el;
  }
  const eyeOpen='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 12s3.2-5 9.8-5 9.8 5 9.8 5-3.2 5-9.8 5-9.8-5-9.8-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
  const eyeClosed='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.2A10.9 10.9 0 0 1 12 6c6.6 0 9.8 6 9.8 6a16.5 16.5 0 0 1-3 3.5M6.2 6.3C3.5 8 2.2 12 2.2 12s3.2 6 9.8 6c1 0 1.9-.2 2.7-.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function setupPasswordToggles(root=document){
    const inputs=[];
    if(root.matches?.('input[type="password"]'))inputs.push(root);
    root.querySelectorAll?.('input[type="password"]').forEach(input=>inputs.push(input));
    inputs.forEach(input=>{
      if(input.dataset.zpPasswordEyeBound==="1")return;
      let control=input.parentElement;
      if(!control?.classList.contains("zp-password-control")&&!control?.classList.contains("reset-password-control")){
        control=document.createElement("div");
        control.className="zp-password-control";
        input.parentNode.insertBefore(control,input);
        control.appendChild(input);
      }else control.classList.add("zp-password-control");
      let button=control.querySelector(":scope > .zp-password-eye");
      if(!button){
        button=document.createElement("button");
        button.type="button";
        button.className="zp-password-eye";
        button.setAttribute("aria-label","显示密码");
        button.setAttribute("aria-pressed","false");
        control.appendChild(button);
      }
      input.dataset.zpPasswordEyeBound="1";
      const sync=()=>{
        const hasValue=input.value.length>0;
        button.hidden=!hasValue;
        if(!hasValue&&input.type!=="password")input.type="password";
        const visible=input.type==="text";
        button.innerHTML=visible?eyeClosed:eyeOpen;
        button.setAttribute("aria-pressed",String(visible));
        button.setAttribute("aria-label",visible?"隐藏密码":"显示密码");
      };
      input.addEventListener("input",sync);
      input.addEventListener("change",sync);
      button.addEventListener("click",()=>{
        if(!input.value.length)return;
        input.type=input.type==="password"?"text":"password";
        sync();
        input.focus();
      });
      sync();
    });
  }
  window.zpSetupPasswordToggles=setupPasswordToggles;
  function initPasswordToggles(){
    setupPasswordToggles(document);
    if(document.body&&window.MutationObserver){
      const observer=new MutationObserver(records=>{
        records.forEach(record=>record.addedNodes.forEach(node=>{
          if(node.nodeType===1)setupPasswordToggles(node);
        }));
      });
      // 收敛（阶段 8 P3）：去掉 subtree:true —— 回调对新增节点递归查密码框，subtree 冗余；
      // 密码框或其容器是 body 直接子 addedNode 即被 childList 捕获（验证见 tests/tools/visual/inspect_observer.js）。
      observer.observe(document.body,{childList:true});
    }
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initPasswordToggles,{once:true});
  else initPasswordToggles();

  /* ===== 业务端常驻一级导航 ===== */
  function zpEnsureBusinessBottomNav(){
    // 直接调 zpDetectZone() 而不读下面的 const zpZone：本文件在 readyState!=="loading"
    // （defer / 动态注入）时，底部这两行会先于 zpZone 的声明执行，读 const 会触发
    // TDZ ReferenceError，导致整个常驻导航静默消失。zpDetectZone 是函数声明，可安全提前调用。
    if(zpDetectZone()!=="business")return;
    document.body.classList.add("zp-business-nav-page");
    if(document.querySelector(".bottom-nav"))return;
    const path=zpNormPath(location.pathname);
    const q=new URLSearchParams(location.search);
    let active="";
    if(path==="/home")active="upload";
    else if(path==="/pages/history")active="history";
    else if(path==="/pages/dispatch"||path==="/pages/data"||path==="/pages/route_apply")active="route";
    else if(path==="/pages/account")active="account";
    else if(path==="/pages/order_detail")active=(q.get("source")==="history"||q.get("from")==="history")?"history":"upload";
    else if(path==="/pages/today")active="upload";
    const items=[
      {id:"upload",label:"上传",href:"/home.html?openUpload=1",icon:'<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'},
      {id:"history",label:"历史",href:"/pages/history.html?from=home",icon:'<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 5v4h4"/><path d="M12 7.5v5l3.2 1.9"/>'},
      {id:"route",label:"线路",href:"/pages/dispatch.html?from=home",icon:'<path d="M4 6h16v12H4z"/><path d="M8 10h8M8 14h5"/>'},
      {id:"account",label:"我的",href:"/pages/account.html?from=home",icon:'<circle cx="12" cy="8" r="3"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/>'}
    ];
    const nav=document.createElement("nav");
    nav.className="bottom-nav";
    nav.setAttribute("aria-label","主要功能");
    nav.innerHTML=items.map(item=>'<a class="bottom-nav-item'+(active===item.id?" is-active":"")+'" href="'+item.href+'"'+(active===item.id?' aria-current="page"':"")+'><span class="bottom-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24">'+item.icon+'</svg></span><span>'+item.label+'</span></a>').join("");
    document.body.appendChild(nav);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",zpEnsureBusinessBottomNav,{once:true});
  else zpEnsureBusinessBottomNav();

  // 业务处理进行中时，常驻导航不能无提示地把用户带离当前运单流程。
  document.addEventListener("click",async e=>{
    const link=e.target.closest?.(".bottom-nav a");
    if(!link||typeof window.zpIsProcessing!=="function"||!window.zpIsProcessing())return;
    const href=link.getAttribute("href")||"";
    if(!href||link.dataset.zpNavGuarded==="1")return;
    e.preventDefault();
    e.stopPropagation();
    if(typeof window.zpConfirm==="function"){
      const ok=await window.zpConfirm("正在处理运单","当前运单仍在识别与规划中，离开将中断本次处理。确定离开吗？","离开");
      if(ok)location.href=href;
    }else if(confirm("当前运单仍在处理中，离开将中断本次处理。确定离开吗？")){
      location.href=href;
    }
  },true);

  // 一级导航 toggle（以首页为标准点）：点击当前所在页对应的 tab（is-active）时，
  // 不再重载本页而是回到首页；点击非激活 tab 照常首次进入对应页面。
  // 首页静态 nav 无 is-active 类，不受影响；首页上传弹窗的 toggle 由 home.js 处理。
  document.addEventListener("click",e=>{
    const active=e.target.closest?.(".bottom-nav a.is-active");
    if(!active)return;
    if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing())return; // 处理中交由上方守卫确认
    e.preventDefault();
    location.href="/home";
  },true);

  window.zpConfirm=function(title,text,okText){
    return new Promise(resolve=>{
      const root=ensure(),box=root.querySelector(".zp-confirm"),ok=root.querySelector("[data-zp-ok]"),cancel=root.querySelector("[data-zp-cancel]");
      root.querySelector("#zpConfirmTitle").textContent=title||"确认操作";
      root.querySelector("#zpConfirmText").textContent=text||"确定继续吗？";
      ok.textContent=okText||"确定";
      box.hidden=false;
      const previousOverflow=document.body.style.overflow;
      document.body.style.overflow="hidden";
      let done=false;
      const onKey=e=>{if(e.key==="Escape"){e.preventDefault();finish(false)}};
      const finish=v=>{if(done)return;done=true;box.hidden=true;ok.onclick=null;cancel.onclick=null;box.onclick=null;document.removeEventListener("keydown",onKey);document.body.style.overflow=previousOverflow;resolve(v)};
      zpSetConfirmDismisser(()=>finish(false)); // 供 Android 返回键关闭：必须走 finish 才能解锁滚动并结束 Promise
      ok.onclick=()=>finish(true);cancel.onclick=()=>finish(false);
      box.onclick=e=>{if(e.target===box)finish(false)};
      document.addEventListener("keydown",onKey);
      setTimeout(()=>cancel.focus(),0);
    });
  };
  /* ===== 全局 Android App 返回机制 =====
     顶部返回按钮 与 Android 系统返回执行同一套逻辑 zphandleBack()，按
     「上一级业务上下文」逐级返回。业务来源一律由 URL 的 from= 明确携带，
     严禁使用 document.referrer / history.length 推断。

     层级解析顺序（rank 小者优先）：
       10 Dialog/Bottom Sheet  20 Drawer/菜单  30 未保存编辑
       40 左滑展开行          50 页面导航     60 工作区根(两次返回退出)

     zpHandleBack 返回值：
       "handled"    页面内消费掉一层 UI（或拒绝关闭），调用方需补压 guard 历史项
       "exit-armed" 工作区根首次返回，已 toast 提示；不补压，下次返回交给系统退出
       "exit"       工作区根第二次返回，确认退出应用；调用方必须执行 zpDoExit()
       "leave"      非根页面的普通返回，已 location.replace 发起页面导航；
                    调用方不要再做任何历史动作，否则一次返回会变成退两层
  */
  // 来源 → 返回目标。值可为字符串，也可为函数（携带上下文 id 精确回跳）
  const BACK_MAP={
    history:q=>{const d=q.get("date");return d?"/pages/history?date="+encodeURIComponent(d):"/pages/history"},
    today:"/pages/today",
    process:"/home",
    data:"/pages/data",
    account:"/pages/account",
    route:"/pages/route_apply",
    // 线路页是一级页，其四个出口（数据资料/历史/我的/线路申请）返回必须回到线路页，
    // 此前缺这个键，全部掉回首页。
    dispatch:"/pages/dispatch",
    home:"/home",
    // 运单详情 → 数据资料 → 必须回到「原来那一张」运单：只带 from 不够，必须带 id
    order:q=>"/pages/order_detail?id="+encodeURIComponent(q.get("id")||"")+"&source=process&from=process"
  };

  // 工作区识别：业务端根 /home.html，管理员端根 /admin.html（独立工作区，互不串线）。
  // ⚠ Cloudflare Pages 会把 /admin.html 308 重定向到 /admin（pretty URL），
  // 因此线上 location.pathname 是「无扩展名」形态。所有判定必须先做规整化，
  // 否则管理员页会被误判为业务页：第一次左滑直接 location.replace("/home.html")
  // 穿越到司机首页（2026-10-05 生产事故根因）。
  function zpNormPath(p){
    let s=String(p||"").split("?")[0];
    s=s.replace(/\.html$/,"");
    if(s.length>1&&s.endsWith("/"))s=s.slice(0,-1);
    return s||"/";
  }
  function zpDetectZone(){
    const p=zpNormPath(location.pathname);
    const od=(document.body&&document.body.dataset&&document.body.dataset.zpZone)||"";
    if(od==="none")return null;
    if(od)return od;
    if(p==="/admin")return "admin";
    if(p==="/"||p==="/index"||p==="/register"||p==="/setup"||p==="/offline"||p==="/admin-bootstrap")return null; // 登录/引导页不装守卫
    return "business";
  }
  const zpZone=zpDetectZone();
  // 区根用无扩展名形态（省一次 308 跳转；带 .html 的旧写法依赖重定向也能到）
  const zpRoot=zpZone==="admin"?"/admin":"/home";
  const zpIsWorkspaceRoot=zpNormPath(location.pathname)===zpNormPath(zpRoot);

  // 一次性「本页上下文已失效」标记。删除类操作（如删完当天最后一张运单）之后，
  // 按来源回跳会落到已删除的对象上——详情页变成「运单读取失败」空态、历史页落在
  // 已删日期。置位后 zpResolveBack 一律短路回本区根（跨区防火墙天然仍成立）。
  let zpStale=false;
  window.zpMarkStale=function(){
    zpStale=true;
    // 同时把当前历史项里的失效 id/date 摘掉，避免刷新或 bfcache 恢复时又回到死链
    try{
      const u=new URL(location.href);
      u.searchParams.delete("id");u.searchParams.delete("date");
      history.replaceState(history.state,"",u.pathname+u.search);
    }catch{}
  };
  // 来源归一化：兜底历史链接 / 旧缓存页里形如 from=pages%2Fdispatch 的「路径碎片」写法，
  // 剥成模块名后再查表，避免这类链接一律掉回首页。
  function zpNormFrom(v){
    if(!v)return "";
    let s=String(v).replace(/^\/+/,"").replace(/\.html$/,"");
    if(s.startsWith("pages/"))s=s.slice(6);
    return s;
  }
  // 来源驱动返回。跨区防火墙：管理员端任何解析结果（含 fallback）若不是管理页，一律作废回落到本区根
  window.zpResolveBack=function(fallback){
    if(zpStale)return zpRoot; // 上下文已失效：不再按来源回跳，直接回本区根
    const q=new URLSearchParams(location.search);
    // 用 hasOwnProperty 取值：归一化后的任意字符串都可能撞上 Object 原型键（如 constructor），
    // 直接 BACK_MAP[key] 会取到原型上的函数并被当成「返回目标函数」执行。
    const key=zpNormFrom(q.get("from"));
    const v=Object.prototype.hasOwnProperty.call(BACK_MAP,key)?BACK_MAP[key]:undefined;
    let target=typeof v==="function"?v(q):v;
    let out=target||fallback||zpRoot;
    // 防火墙放在最后（判定用规整化路径，兼容 /admin 与 /admin.html 两种形态）：
    // 管理员端永远不回落到业务端，业务端也永不进入管理端
    if(zpZone==="admin"&&zpNormPath(out)!=="/admin")out=zpRoot;
    if(zpZone!=="admin"&&zpNormPath(out)==="/admin")out=zpRoot;
    if(zpNormPath(out)===zpNormPath(location.pathname))out=zpRoot; // 兜底：绝不自我返回造成死循环
    return out;
  };
  window.zpGoBack=function(fallback){location.replace(zpResolveBack(fallback))};

  // 可见性探测：同时覆盖 [hidden] 元素 与 内联 style.display 的弹层
  function zpIsVisible(el){
    if(!el||el.hidden)return false;
    if(el.closest&&el.closest("[hidden]"))return false;
    let cs;try{cs=getComputedStyle(el)}catch{return false}
    if(!cs||cs.display==="none"||cs.visibility==="hidden"||cs.opacity==="0")return false;
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0;
  }

  // 返回层级钩子。页面脚本先于本文件加载，故用「自初始化 push」写法。
  // 注意：push 不会排序，必须在每次消费前统一按 rank 升序，否则本文件追加的
  // 内置钩子会排到页面钩子之后，优先级失效。
  function zpSortedHooks(){
    const h=window.zpBackHooks||[];
    h.sort((a,b)=>((a&&a.rank)|0)-((b&&b.rank)|0));
    return h;
  }
  window.zpBackHooks=window.zpBackHooks||[];
  window.zpRegisterBackHook=function(h){
    if(!h||typeof h.probe!=="function")return;
    window.zpBackHooks.push(h);
    zpSortedHooks();
  };
  // 页面级未保存拦截（无弹层时的编辑态，如数据页暂存修改）
  window.zpDirtyProbes=window.zpDirtyProbes||[];

  let zpConfirmDismisser=null;
  function zpSetConfirmDismisser(fn){zpConfirmDismisser=fn}
  window.zpDismissConfirm=function(){if(zpConfirmDismisser)zpConfirmDismisser()};

  // 内置层级①：通用确认框（zp-confirm）。rank 5 低于所有页面钩子，
  // 保证「确认框一定是最先响应返回的那层」，避免被页面弹层抢先导致二次弹窗。
  window.zpBackHooks.push({rank:5,
    probe:()=>document.querySelector("#zpUiLayer .zp-confirm"),
    close:()=>{
      if(zpConfirmDismisser){zpConfirmDismisser();return true}
      const el=document.querySelector("#zpUiLayer .zp-confirm");
      if(el){el.hidden=true;document.body.style.overflow=""} // 兜底务必解锁滚动
      return true;
    }});

  let zpExitArmed=false,zpExitTimer=0,zpLeaving=false,zpAdminNonRoot=false;
  // 压一条「占位历史」，使第一次系统返回先触发 popstate（被本控制器接管），
  // 而不是直接越过首条记录由系统关掉 PWA（那样就没有「再按一次」提示了）。
  function zpPushGuard(){
    try{history.pushState({zpGuard:((history.state&&history.state.zpGuard)|0)+1},"")}catch{}
  }

  async function zpConfirmDiscard(){
    const ok=await window.zpConfirm("放弃修改？","当前修改尚未提交，返回后将丢失。","放弃");
    return ok;
  }

  // 自上而下关闭一层 UI；返回 true 表示本次返回已被页面内消化
  async function zpCloseTopLayer(){
    const hooks=zpSortedHooks();
    for(const h of hooks){
      let el=null;try{el=h.probe()}catch{continue}
      if(!el||!zpIsVisible(el))continue;
      if(typeof h.dirty==="function"){
        let dirty=false;try{dirty=!!h.dirty()}catch{}
        if(dirty&&!await zpConfirmDiscard())return true; // 留在编辑，不穿透
      }
      try{await h.close()}catch{}
      // 已消费一层。注意：close 的返回值不参与判定——无论它返回什么，本次返回都算被页面内
      // 消化、不再向下穿透。所谓"拒绝关闭"（如首页上传进行中）的语义就等价于"不穿透"，
      // 具体提示由 close 内部自行 toast，不需要靠返回值表达。
      return true;
    }
    return false;
  }

  window.zpHandleBack=async function(){
    if(await zpCloseTopLayer())return "handled";
    if(zpIsWorkspaceRoot){
      if(zpExitArmed)return "exit"; // 第二次返回：确认退出应用，调用方必须执行 zpDoExit()
      zpExitArmed=true;
      try{window.zpToast?window.zpToast("再按一次退出","info"):0}catch{}
      clearTimeout(zpExitTimer);
      // 窗口过期：仅复位武装标记，不再补占位。
      // 安卓独立 PWA 下 window.close() 对「主页启动的顶层上下文」是空操作，
      // 真正退出只能靠「越过首条记录让系统关掉 PWA」。武装期间刻意不补占位，
      // 第二次返回才能退到首条记录之前、由系统退回桌面；补占位反而会让第二次
      // 返回卡在管理端、要多按几次才滑出去（旧版就表现为「穿越到业务首页」）。
      // 窗口过期：复位武装标记。仅当管理员端「非根」（同窗口进入、底下压着业务端首页）
      // 时补回占位——这样停顿后再按会重新武装而非直接滑到司机首页；管理员端「根」
      // （独立窗口，底下无业务页）则不补，保证停顿后下一次返回能越过首条记录由系统退出。
      zpExitTimer=setTimeout(()=>{zpExitArmed=false;if(zpZone==="admin"&&zpAdminNonRoot)zpPushGuard()},2000);
      return "exit-armed";
    }
    // 离开页面前：页面级未保存拦截
    for(const fn of (window.zpDirtyProbes||[])){
      let dirty=false;try{dirty=!!fn()}catch{}
      if(dirty&&!await zpConfirmDiscard())return "handled";
    }
    location.replace(zpResolveBack("/home.html"));
    return "leave";
  };

  // 真正离开应用：越过首条历史记录，由系统退出 PWA（浏览器里退回上一站）。
  // 顶部返回按钮 与 Android 物理/手势返回共用这一出口，保证两者行为完全一致。
  // 安卓独立 PWA 下 window.close() 对「主页启动的顶层上下文」是空操作，唯一可靠的退出
  // 方式是让浏览器越过首条记录去关掉 PWA；武装期间刻意不补占位，此刻当前页正停在首条
  // 记录上，再 back() 一步即越过去。即便历史里残留业务端首页，这一步会一并越过。
  function zpDoExit(){
    zpLeaving=true;
    // 置位一次性退出标记：若历史里残留业务端首页，下一页加载时会继续后退，绝不停在司机首页
    try{sessionStorage.setItem("zpExitAdmin","1")}catch{}
    try{history.back()}catch{}
    try{
      const standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone===true;
      if(standalone)window.close(); // 部分环境可真正收起；失败则上面的 back 已越界退出
    }catch{}
  }
  // 顶部返回按钮专用出口：必须消费 zpHandleBack 的返回值。以前直接丢弃返回值，
  // 根页第二次点返回拿到"退出"却什么都不做——顶部按钮永远退不出应用，只有物理键能退。
  async function zpBackButton(){
    const r=await zpHandleBack();
    if(zpLeaving)return;
    if(r==="handled"){zpPushGuard();return} // 关掉了一层 UI：补回占位，别让下一次返回滑出本页
    if(r==="exit"){zpDoExit();return}
    // "leave"：非根页面的普通返回，location.replace 已发起页面导航，此处不做任何额外动作
  }

  function zpBindPageBack(){
    document.querySelectorAll(".app-back,#backBtn").forEach(el=>{
      if(el.dataset.zpBackBound==="1")return;
      el.dataset.zpBackBound="1";
      el.addEventListener("click",e=>{e.preventDefault();zpBackButton()});
    });
  }

  /* ===== 工作区隔离：管理员端与业务端互不串线 =====
     角色由登录页 / 管理端写入 sessionStorage（zpRole），业务页据此做门禁：
       1) 正在执行「退出应用」流程（zpExitAdmin 置位）→ 放行并继续后退，绝不停留；
       2) 管理员会话却落在业务页 → 立刻送回管理端，业务界面一帧都不露出。
     退出登录一律先回到登录页，登录页进入即清空 zpRole，因此换账号登录司机后不会被误判。 */
  window.zpSetRole=function(role){
    try{sessionStorage.setItem("zpRole",(role==="admin"||role==="system_admin")?"admin":"user")}catch{}
  };
  window.zpClearRole=function(){try{sessionStorage.removeItem("zpRole")}catch{}};
  function zpIsAdminSession(){
    try{return sessionStorage.getItem("zpRole")==="admin"}catch{return false}
  }
  // 返回 true 表示本页已被隔离逻辑接管，调用方应停止后续初始化
  function zpZoneGuard(){
    if(zpZone!=="business")return false;
    let exiting=false;
    try{exiting=!!sessionStorage.getItem("zpExitAdmin")}catch{}
    if(exiting){
      // 正在退出：继续后退直到真正退出 PWA。此刻绝不能弹回管理端，
      // 否则「两次返回退出」会变成回到管理端，永远退不出去。
      try{sessionStorage.removeItem("zpExitAdmin")}catch{}
      try{history.back()}catch{}
      return true;
    }
    if(zpIsAdminSession()){try{location.replace("/admin")}catch{};return true}
    return false;
  }

  (function zpInstallBack(){
    // 管理员端与司机端同处一个 PWA 窗口。登录即栈底（location.replace 进入，背后无首页），
    // 故正常进入时 admin 就是历史首条记录；极少数「司机会话→退出→再登录管理员」路径下，
    // 历史里会残留业务端首页（非根）。下面的跨区退出标记负责兜底：离开管理员端时（或进入时
    // 若已非根）置一次性标记，业务端页（全新加载 / bfcache 恢复都会触发）消费标记继续后退，
    // 直到真正退出 PWA，绝不停在司机首页。
    // 非根判定：admin.html 加载时历史长度 >1，说明它底下还压着别的文档（如司机首页）。
    zpAdminNonRoot=(zpZone==="admin")&&(function(){try{return history.length>1}catch{return false}})();
    if(zpZone==="business"){
      // 业务区门禁：管理员会话不在此停留；正在退出则继续后退（内部已处理标记）
      if(zpZoneGuard())return;
    }else{
      try{sessionStorage.removeItem("zpExitAdmin")}catch{} // 非业务页：清残留，防误触
    }
    // 管理员端「非根」进入（历史里残留业务端首页，如司机会话→退出→再登录管理员）：
    // 进入即置跨区退出标记，保证任何一次离开都能越过业务端首页，直接退到桌面。
    if(zpZone==="admin"&&zpAdminNonRoot){
      try{sessionStorage.setItem("zpExitAdmin","1")}catch{}
    }
    zpBindPageBack();
    // bfcache 恢复不会重跑本 IIFE，但系统返回完全可能把用户带回到一个缓存的业务页
    // （管理员端最容易踩到），因此恢复时再过一次门禁。
    window.addEventListener("pageshow",e=>{zpBindPageBack();if(e.persisted)zpZoneGuard()});
    if(!zpZone)return; // 登录/引导页只统一按钮行为，不安装系统返回守卫
    // 每次进入都要有 guard：没有它，「系统返回」会直接滑出本站（落在历史里
    // 的上一页，管理员端就会被甩到业务首页），而不是先交给下面这段处理。
    if(!(history.state&&history.state.zpGuard))zpPushGuard();
    window.addEventListener("popstate",async()=>{
      if(window.zpSuppressPop){window.zpSuppressPop=false;return} // 自己触发的 back，吃掉
      // 业务端页上（含 bfcache 恢复）：消费跨区退出标记，继续后退直到真正退出
      if(zpZone==="business"){
        var _f2=null;try{_f2=sessionStorage.getItem("zpExitAdmin")}catch{}
        if(_f2){try{sessionStorage.removeItem("zpExitAdmin")}catch{};try{history.back()}catch{};return}
      }
      const r=await zpHandleBack();
      if(zpLeaving)return;
      if(r==="handled"){zpPushGuard();return}   // 关掉了一层 UI：补回占位，别让下一次返回滑出本页
      if(r==="exit-armed")return;               // 处于「再按一次退出」窗口：窗口内再按即离开
      // "leave" = 非根页面的普通返回。此时 location.replace 已把当前历史项换成目标页，
      // 绝不能再置跨区退出标记、也不能再 back() 一步：那会把「一次返回」变成退两层，
      // 甚至在详情页按返回时连带退出 PWA。只有工作区根确认退出（"exit"）才走 zpDoExit。
      if(r==="exit")zpDoExit();
    });
  })();

  function setupGlobalScrollButtons(){
    if(document.querySelector(".data-float-scroll,.zp-float-scroll"))return;
    const candidates=[document.scrollingElement,...document.querySelectorAll("main,.page2,.history-shell,.order-store-list,.dispatch-list,.data-store-list")].filter(Boolean);
    const target=candidates.reduce((best,el)=>{
      const can=el===document.scrollingElement ? el.scrollHeight-el.clientHeight>240 :
        getComputedStyle(el).overflowY!=="visible" && el.scrollHeight-el.clientHeight>240;
      if(!can)return best;
      const score=el.scrollHeight-el.clientHeight;
      return !best||score>best.score?{el,score}:best;
    },null);
    if(!target){
      // 运单详情/今日运单/历史等页面的列表由 API 异步渲染，首次判定时还是空的。
      // 轮询等待内容出现（最多 ~16s），避免箭头永不出现。
      if((setupGlobalScrollButtons._tries=(setupGlobalScrollButtons._tries||0)+1)<=40)
        setTimeout(setupGlobalScrollButtons,400);
      return;
    }
    const el=target.el,root=document.createElement("div");
    root.className="zp-float-scroll-wrap";
    root.innerHTML='<button class="zp-float-scroll zp-float-up" type="button" aria-label="快速回到顶部">↑</button><button class="zp-float-scroll zp-float-down" type="button" aria-label="快速到底部">↓</button>';
    document.body.appendChild(root);
    const up=root.querySelector(".zp-float-up"),down=root.querySelector(".zp-float-down");
    const getY=()=>el===document.scrollingElement?window.scrollY:el.scrollTop;
    const getMax=()=>Math.max(0,(el===document.scrollingElement?document.documentElement.scrollHeight:el.scrollHeight)-(el===document.scrollingElement?window.innerHeight:el.clientHeight));
    const update=()=>{
      const y=getY(),max=getMax();
      up.classList.toggle("show",y>180);
      down.classList.toggle("show",y<max-180);
    };
    const move=(top)=>el===document.scrollingElement?window.scrollTo({top,behavior:"smooth"}):el.scrollTo({top,behavior:"smooth"});
    up.onclick=()=>move(0);
    down.onclick=()=>move(getMax());
    const eventTarget=el===document.scrollingElement?window:el;
    eventTarget.addEventListener("scroll",update,{passive:true});
    window.addEventListener("resize",update);
    // 列表内容后续重渲染/增减时重测是否继续显示箭头（内容长高不改变盒子尺寸，须监听子节点变化）
    // 收敛（阶段 8 P3）：保存 observer 引用（消除「实例未保存无法 disconnect」代码异味）；
    // 监听目标统一为 el（整页滚动时 el 即 scrollingElement，范围与原 observe body 一致；列表容器滚动时本就小）。
    if(window.MutationObserver){const mo=new MutationObserver(update);mo.observe(el,{childList:true,subtree:true});}
    setTimeout(update,80);
  }
  window.addEventListener("load",setupGlobalScrollButtons,{once:true});
  setTimeout(setupGlobalScrollButtons,120);

  window.zpToast=function(message,type="success"){
    const root=ensure(),toast=root.querySelector("#zpToast");
    toast.textContent=message||"";
    toast.className="ui-toast "+(type||"")+" show";
    clearTimeout(window.zpToast._timer);
    window.zpToast._timer=setTimeout(()=>toast.classList.remove("show"),2200);
  };
})();
/* 业务端一级导航样式见 css/ui-unified.css（.zp-business-nav-page 相关规则），
   此处曾误将 CSS 直接粘贴进 JS，导致整文件语法错误、ui-unified 全部功能失效。
   导航常驻逻辑见上方 IIFE（document.body.classList.add("zp-business-nav-page")）。 */
