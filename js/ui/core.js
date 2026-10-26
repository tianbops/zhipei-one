/* 智配One · UI 内核（原 js/ui-unified.js 拆分 · 1/6）
 * ----------------------------------------------------------------------------
 * 只包含「被多个 UI 模块共用」的三件东西：路径规整、工作区判定、共享状态。
 * 不含任何副作用（不注册监听、不改 DOM）——所以它可以在测试里被单独求值。
 *
 * ⚠ 必须第一个加载：nav.js（底部常驻导航）与 back.js（返回控制器）都依赖这里。
 */
(function(){
  if(window.__zpUi)return;
  const UI={};

  /* 跨模块共享状态。feedback.js 的确认框把「关闭器」写进来，
     back.js 的返回 ladder 读它——两者不能互相依赖加载顺序，故由内核托管。 */
  UI.state={confirmDismisser:null};

  /* 路径规整。
     ⚠ Cloudflare Pages 会把 /admin 308 重定向到 /admin（pretty URL），
     因此线上 location.pathname 是「无扩展名」形态。所有判定必须先做规整化，
     否则管理员页会被误判为业务页：第一次左滑直接 location.replace("/home")
     穿越到司机首页（2026-10-05 生产事故根因）。 */
  UI.normPath=function(p){
    let s=String(p||"").split("?")[0];
    s=s.replace(/\.html$/,"");
    if(s.length>1&&s.endsWith("/"))s=s.slice(0,-1);
    return s||"/";
  };

  /* 工作区识别：业务端根 /home，管理员端根 /admin（独立工作区，互不串线）。 */
  UI.detectZone=function(){
    const p=UI.normPath(location.pathname);
    const od=(document.body&&document.body.dataset&&document.body.dataset.zpZone)||"";
    if(od==="none")return null;
    if(od)return od;
    if(p==="/admin")return "admin";
    if(p==="/"||p==="/index"||p==="/register"||p==="/setup"||p==="/offline"||p==="/admin-bootstrap")return null; // 登录/引导页不装守卫
    return "business";
  };

  /* 来源归一化：兜底历史链接 / 旧缓存页里形如 from=pages%2Fdispatch 的「路径碎片」写法，
     剥成模块名后再查表，避免这类链接一律掉回首页。 */
  UI.normFrom=function(v){
    if(!v)return "";
    let s=String(v).replace(/^\/+/,"").replace(/\.html$/,"");
    if(s.startsWith("pages/"))s=s.slice(6);
    return s;
  };

  /* ===== 模态焦点管理（P3 对话框焦点陷阱）=====
     对话框（aria-modal）打开后，Tab/Shift+Tab 应在层内循环，键盘焦点不逃出遮罩。
     决策拆成纯函数（便于单测），DOM 装配留给调用方（back.js 的 ESC/Tab 分发器）。

     收集容器内可聚焦元素：跳过 disabled、tabindex="-1"、隐藏祖先、aria-hidden 与不可见项。 */
  UI.focusables=function(root){
    if(!root||typeof root.querySelectorAll!=="function")return [];
    const sel='a[href],button,input,select,textarea,[tabindex]';
    const out=[];
    Array.prototype.forEach.call(root.querySelectorAll(sel),el=>{
      if(!el||el.disabled)return;
      if(el.getAttribute&&el.getAttribute("tabindex")==="-1")return;
      if(el.closest&&el.closest("[hidden]"))return;
      if(el.getAttribute&&el.getAttribute("aria-hidden")==="true")return;
      // offsetParent 对 position:fixed 元素恒为 null，故同时看 getClientRects
      const visible=(el.offsetParent!=null)||(typeof el.getClientRects==="function"&&el.getClientRects().length>0);
      if(!visible)return;
      out.push(el);
    });
    return out;
  };

  /* 焦点陷阱的纯决策：给定可聚焦元素列表、当前焦点元素与 Shift 状态，
     返回应获得焦点的元素；返回 null 表示本次不干预（焦点在层内中间，照常移动）。 */
  UI.trapFocusTarget=function(list,active,shiftKey){
    if(!list||!list.length)return null;
    const first=list[0],last=list[list.length-1];
    if(shiftKey)return active===first?last:null;
    return active===last?first:null;
  };

  /* 把焦点锁在容器内：Tab/Shift+Tab 在首尾循环。返回是否发生了焦点搬运。
     焦点已逸出容器（如切到隐藏面板后浏览器把焦点落在 body）时，Tab 把它拉回层内首/尾，
     否则焦点会从文档开头继续走，直接跳出弹层。 */
  UI.trapTab=function(root,e){
    if(!root||!e)return false;
    const list=UI.focusables(root);
    if(!list.length)return false;
    const active=(typeof document!=="undefined")?document.activeElement:null;
    const inside=!!(active&&root.contains&&root.contains(active));
    let target=null;
    if(!inside)target=e.shiftKey?list[list.length-1]:list[0];
    else target=UI.trapFocusTarget(list,active,!!e.shiftKey);
    if(!target)return false;
    if(typeof e.preventDefault==="function")e.preventDefault();
    try{target.focus()}catch(_){}
    return true;
  };

  window.__zpUi=UI;
})();
