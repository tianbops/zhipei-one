/* 智配One · 全局返回控制器（原 js/ui-unified.js 拆分 · 5/6）
 * ----------------------------------------------------------------------------
 * 顶部返回按钮 与 Android 系统返回执行同一套逻辑 zphandleBack()，按
 * 「上一级业务上下文」逐级返回。业务来源一律由 URL 的 from= 明确携带，
 * 严禁使用 document.referrer / history.length 推断。
 *
 * 层级解析顺序（rank 小者优先）：
 *   10 Dialog/Bottom Sheet  20 Drawer/菜单  30 未保存编辑
 *   40 左滑展开行          50 页面导航     60 工作区根(两次返回退出)
 *
 * zpHandleBack 返回值：
 *   "handled"    页面内消费掉一层 UI（或拒绝关闭），调用方需补压 guard 历史项
 *   "exit-armed" 工作区根首次返回，已 toast 提示；不补压，下次返回交给系统退出
 *   "exit"       工作区根第二次返回，确认退出应用；调用方必须执行 zpDoExit()
 *   "leave"      非根页面的普通返回，已 location.replace 发起页面导航；
 *                调用方不要再做任何历史动作，否则一次返回会变成退两层
 *
 * 依赖：core.js（normPath / detectZone / normFrom / 共享状态）
 * 被依赖：无（各业务页在运行时调用 window.zpHandleBack / zpRegisterBackHook）
 */
(function(){
  if(window.zpHandleBack)return;
  const UI=window.__zpUi||(window.__zpUi={state:{}});
  const sharedState=UI.state||(UI.state={});

  // 收口模型（ZP-NAV-2026-002 · 修订 F，2026-10-30 定稿）：
  // 不再按 from= 回跳来源页。业务区任何页面返回 → /home；管理员区任何页面返回 → /admin。
  // 旧 BACK_MAP（history→history、dispatch→dispatch、order→原运单）已删除：
  // 来源驱动会让「历史→详情→返回」回到历史，与本方案「唯一根为首页」冲突。
  const zpZone=UI.detectZone();
  // 区根用无扩展名形态（省一次 308 跳转；带 .html 的旧写法依赖重定向也能到）
  const zpRoot=zpZone==="admin"?"/admin":"/home";
  const zpIsWorkspaceRoot=UI.normPath(location.pathname)===UI.normPath(zpRoot);

  // 删除类操作（如删完当天最后一张运单）之后调用：把 URL 上的 id/date 摘掉，
  // 避免刷新或 bfcache 恢复时又落回已删除的对象（详情页变「读取失败」空态）。
  // 单根模型下返回目标已恒为本区根，此处只剩历史项清洗职责。
  window.zpMarkStale=function(){
    // 同时把当前历史项里的失效 id/date 摘掉，避免刷新或 bfcache 恢复时又回到死链
    try{
      const u=new URL(location.href);
      u.searchParams.delete("id");u.searchParams.delete("date");
      history.replaceState(history.state,"",u.pathname+u.search);
    }catch{}
  };
  // 返回目标解析（单根）。
  window.zpResolveBack=function(){
    // 单根模型：与来源、与上下文是否失效都无关，一律回本区根。
    // 跨区防火墙由此天然成立——业务区只可能得到 /home，管理员区只可能得到 /admin。
    return zpRoot;
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

  window.zpDismissConfirm=function(){if(sharedState.confirmDismisser)sharedState.confirmDismisser()};

  // 内置层级①：通用确认框（zp-confirm）。rank 5 低于所有页面钩子，
  // 保证「确认框一定是最先响应返回的那层」，避免被页面弹层抢先导致二次弹窗。
  window.zpBackHooks.push({rank:5,
    probe:()=>document.querySelector("#zpUiLayer .zp-confirm"),
    close:()=>{
      if(sharedState.confirmDismisser){sharedState.confirmDismisser();return true}
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

  /* ===== 不可中断操作守卫（ZP-NAV-2026-002 第五节）=====
     运单正在 OCR/规划（首页）与核对页正在提交确认，都属于「已经发出写请求」的状态：
     此时返回键既不能关弹层、也不能离开页面——离开会留下服务端已落库但用户以为放弃的运单，
     或让客户端提前释放上传引用却不知道结果。统一在这里拦下并提示，只有一个出口：等结果。
     请求本身有服务端超时兜底（OCR_TIMEOUT / PROCESS_*），不会永久卡死。 */
  function zpBusyMessage(){
    try{
      if(typeof window.zpIsProcessing==="function"&&window.zpIsProcessing())return "运单正在处理，请稍候";
      if(typeof window.zpIsConfirming==="function"&&window.zpIsConfirming())return "正在保存，请稍候";
    }catch{}
    return "";
  }

  // 自上而下关闭一层 UI；返回 true 表示本次返回已被页面内消化
  async function zpCloseTopLayer(){
    const busy=zpBusyMessage();
    if(busy){
      try{window.zpToast?window.zpToast(busy,"error"):0}catch{}
      return true;   // 消费本次返回：不关弹层、不穿透、不导航
    }
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

  // 自上而下找出最上层可见弹层（ESC/Tab 分发器用）。返回 null 表示当前没有弹层。
  function zpTopHook(){
    for(const h of zpSortedHooks()){
      let el=null;try{el=h.probe()}catch{continue}
      if(!el||!zpIsVisible(el))continue;
      return h;
    }
    return null;
  }
  window.zpCloseTopLayer=zpCloseTopLayer;

  /* ===== ESC 关闭 + Tab 焦点陷阱（与 Android 返回键共用同一分层阶梯）=====
     - ESC：只关闭最上层的页面内弹层；当前没有弹层时什么都不做——不退出应用、不导航，
       与系统返回键「越界退出」的语义刻意区分开。
     - Tab：把焦点锁在最上层弹层内（容器由该层的 hook.trap 提供）。自带陷阱的层
       （如确认框 zpConfirm）不提供 trap，沿用它自己的实现。
     ⚠ ESC 必须与 Android 返回键走同一套 rank 阶梯，否则两层弹层叠放时会出现
       「ESC 关掉下层、上层还挂着」的错位（历史浮层与确认框曾因此互相抢层级）。 */
  document.addEventListener("keydown",async e=>{
    if(e.key==="Escape"){
      if(e.defaultPrevented)return; // 上层组件已自行处理（如 zp-picker 在捕获阶段拦截）
      const top=zpTopHook();
      if(!top)return;               // 无弹层：ESC 不越界退出
      e.preventDefault();           // 同步阻止默认行为（须在事件派发结束前）
      await zpCloseTopLayer();
      return;
    }
    if(e.key!=="Tab")return;
    const h=zpTopHook();
    if(!h||typeof h.trap!=="function")return;
    let root=null;try{root=h.trap()}catch{return}
    if(!root)return;
    const UI=window.__zpUi||{};
    if(typeof UI.trapTab!=="function")return;
    UI.trapTab(root,e);
  });

  window.zpHandleBack=async function(){
    if(await zpCloseTopLayer())return "handled";
    if(zpIsWorkspaceRoot){
      // 管理员空间：先把模块收口到管理员首页（模块 0），再走「两次返回退桌面」。
      // 2026-10-30 起返回键不再注销会话：旧实现在这里 POST /api/logout 直接回登录页，
      // 既违反「返回键永不登出」，也无法满足 A1「管理员首页返回 = 退桌面、不进入业务首页」。
      if(zpZone==="admin"){
        const A=window.ZPAdmin;
        const cur=A&&A.S&&typeof A.S.page==="number"?A.S.page:0;
        if(cur>0&&A&&typeof A.page==="function"){
          A.page(0);
          return "handled";
        }
      }
      if(zpExitArmed)return "exit"; // 工作区根（业务首页 / 管理员首页）第二次返回：退桌面，调用方必须执行 zpDoExit()
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
    location.replace(zpResolveBack("/home"));
    return "leave";
  };

  // 真正离开应用：越过首条历史记录，由系统退出 PWA（浏览器里退回上一站）。
  // 顶部返回按钮 与 Android 物理/手势返回共用这一出口，保证两者行为完全一致。
  // 安卓独立 PWA 下 window.close() 对「主页启动的顶层上下文」是空操作，唯一可靠的退出
  // 方式是让浏览器越过首条记录去关掉 PWA；武装期间刻意不补占位，此刻当前页正停在首条
  // 记录上，再 back() 一步即越过去。即便历史里残留业务端首页，这一步会一并越过。
  function zpDoExit(){
    zpLeaving=true;
    // 原生壳内：直接结束 Activity。v1.0.19 起壳层返回键已不看 canGoBack、不走 goBack，
    // WebView 里的 history.back() 只会把页面退回上一页而退不出应用，唯一可靠出口是
    // ZhipeiNative.exitApp()（原生 finish()）。存在壳就立即返回，不再碰历史。
    try{
      const N=window.ZhipeiNative;
      if(N&&typeof N.exitApp==="function"){N.exitApp();return}
    }catch{}
    // 独立 PWA / 浏览器：越过首条历史记录，由系统退出（退回上一站/桌面）。
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
    // 只有「关掉一层后下面还压着弹层」才补占位。
    // 顶部按钮与原生返回键都不消费历史记录（它们不触发 popstate），无脑补压会平白
    // 多出一条记录：离开本页时 location.replace 只替换当前项，这条多余记录就成了
    // 指向内页的孤儿，连按返回又会退回已经离开的页面（v1.0.18 之前的老毛病）。
    if(r==="handled"){if(zpTopHook())zpPushGuard();return}
    if(r==="exit"){zpDoExit();return}
    // "leave"：非根页面的普通返回，location.replace 已发起页面导航，此处不做任何额外动作
  }

  /* 原生壳在 WebView「无历史可退」时调用 window.zpSystemBack()（MainActivity 的
     OnBackPressedCallback）。拆分 ui-unified.js 时这个入口被漏掉，导致登录/引导页按
     返回毫无反应——这里补回来：登录页（未识别工作区）返回即退出 App；工作区页则完整
     走一遍 zpBackButton（根页两次返回退桌面）。 */
  /* 子页面不压占位（见 zpBindPageBack 里的说明），所以「不可中断操作」开始时
     必须显式申请一条：否则保存中按返回会直接离开页面，绕过 zpBusyMessage。
     业务侧在 confirming=true / 长任务开始处调用；重复调用无副作用。 */
  window.zpArmGuard=function(){
    try{if(!(history.state&&history.state.zpGuard))zpPushGuard()}catch{}
  };

  window.zpSystemBack=function(){
    if(!zpZone){
      try{
        const N=window.ZhipeiNative;
        if(N&&typeof N.exitApp==="function"){N.exitApp();return}
      }catch{}
      return;
    }
    return zpBackButton();
  };

  /* ===== 站内导航一律 replace（2026-10-30） =====
     多页架构下每个 <a href> 都会 push 一条历史。收口模型要求「任何页面返回都回首页」，
     但历史里仍压着历史页、详情页……于是首页按返回出现「首页 → 详情 → 历史 → 首页」
     的反复横跳，用户连按多次才退得出去，方向完全不可预期。
     单根模型下历史栈没有意义：站内跳转统一 replace，栈里只留当前页一条正式记录
     （外加本控制器压的占位），返回方向恒为「往桌面走」，绝不回内页。
     判定：同源 + 以 / 开头 + 无 target/download/修饰键；外链、下载、mailto/tel、
     纯锚点一律放行。用冒泡阶段并检查 defaultPrevented，不抢业务自己处理的点击
     （如处理中的离开确认、选中 tab 滚回顶部）。 */
  document.addEventListener("click",function(e){
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(!a||(a.target&&a.target!=="_self")||a.hasAttribute("download"))return;
    const raw=a.getAttribute("href")||"";
    if(!raw||raw.charAt(0)==="#"||/^(mailto:|tel:|javascript:)/i.test(raw))return;
    let url;try{url=new URL(raw,a.baseURI)}catch{return}
    if(url.origin!==location.origin)return;
    e.preventDefault();
    // 同页链接（当前 tab、页内跳转）：不重复导航，否则又会压一条同样的历史
    if(url.pathname===location.pathname&&url.search===location.search)return;
    location.replace(url.href);
  },false);

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
  // 登录态同步标记：业务页头部守卫据此在「渲染前」即时判定放行/拦截，避免未登录先渲染再跳转（可被返回绕过）。
  window.zpAuthOK=function(){try{sessionStorage.setItem("zpAuth","1")}catch(e){}};
  window.zpAuthClear=function(){try{sessionStorage.removeItem("zpAuth")}catch(e){}};
  // 会话失效（401）兜底：清标记并回登录页。供各页 /api/me 失败时调用。
  window.zpAuthFail=function(reason){try{sessionStorage.removeItem("zpAuth")}catch(e){}try{localStorage.removeItem("zpLastAuth");localStorage.removeItem("zpLastRole")}catch(e){}try{location.replace("/?reason="+(reason||"expired"))}catch(e){}};
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
    // 只有「工作区根」压占位（2026-10-30 修正）。
    // 根页需要它：第一次系统返回先被本控制器接管，才有「再按一次退桌面」。
    // 子页面**不能**压：location.replace 只替换「当前项」，多压一条占位会让
    // 上一个页面的正式记录永久残留在栈里，连按返回就退回已经离开的内页
    // （线上实测序列：首页 → 首页 → 历史查询 → 首页）。
    // 子页面按返回直接落到栈里的根页，正是单根模型要的结果，不需要占位。
    if(zpIsWorkspaceRoot&&!(history.state&&history.state.zpGuard))zpPushGuard();
    window.addEventListener("popstate",async()=>{
      if(window.zpSuppressPop){window.zpSuppressPop=false;return} // 自己触发的 back，吃掉
      // 业务端页上（含 bfcache 恢复）：消费跨区退出标记，继续后退直到真正退出
      if(zpZone==="business"){
        var _f2=null;try{_f2=sessionStorage.getItem("zpExitAdmin")}catch{}
        if(_f2){try{sessionStorage.removeItem("zpExitAdmin")}catch{};try{history.back()}catch{};return}
      }
      const r=await zpHandleBack();
      if(zpLeaving)return;
      if(r==="handled"){if(zpTopHook())zpPushGuard();return} // 还有下一层要关才补占位；层关光了就不再补，免得堆出孤儿记录
      if(r==="exit-armed")return;               // 处于「再按一次退出」窗口：窗口内再按即离开
      // "leave" = 非根页面的普通返回。此时 location.replace 已把当前历史项换成目标页，
      // 绝不能再置跨区退出标记、也不能再 back() 一步：那会把「一次返回」变成退两层，
      // 甚至在详情页按返回时连带退出 PWA。只有工作区根确认退出（"exit"）才走 zpDoExit。
      if(r==="exit")zpDoExit();
    });
  })();
})();
