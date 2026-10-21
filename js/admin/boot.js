/* admin/boot.js —— 启动：管理员身份校验、数据加载 load()、全局事件挂载
 * 拆分自 admin.html（原 72KB 单体文件），功能等价、行为不变。
 * 顶部从命名空间解构出同名局部绑定，故函数体保持原始写法，未做标识符改写。
 */
(function(A){
const { $, S, esc, rn, api, toast, open, close, page, sw, closeSwipes, dlg, dt, dp, db, dc, do_ } = A;
async function load(){
  $("who").textContent="正在验证身份…";
  let m;
  try{
    m=await api("/api/me?adminCheck="+Date.now());
  }catch(e){
    $("who").textContent="身份验证失败："+(e.message||"请重新登录");
    // 未登录：清跨区退出标记，避免遗留标记在后续业务页误触发 history.back。
    try{sessionStorage.removeItem("zpExitAdmin")}catch(e){}
    // 401（会话失效）：清登录标记并直接回登录页，避免停留在报错界面
    if(e&&e.code==="HTTP_401"&&window.zpAuthFail){window.zpAuthFail("expired");return;}
    setTimeout(()=>location.replace("/"),1200);
    return;
  }
  if(m.user?.role!=="system_admin"&&m.user?.role!=="admin"){
    $("who").textContent="当前账号无管理员权限";
    // 2026-10-05 修复（登录页↔管理端来回跳动死循环）：能走到这里说明会话有效、
    // 当前登录的是业务账号 —— 正确去处是业务端首页 /home，而不是登录页。
    // 旧逻辑 replace("/") 会被登录页的角色自动直达再次送回 /admin；
    // 一旦 /api/me 对不同请求返回不一致角色（中间层按 URL 缓存旧响应等），
    // 两端就互相踢皮球无限循环。改为直达 /home：无论哪端读到陈旧角色，
    // 最坏也只多跳一次，循环在结构上不可能形成。
    // 关键：清掉 ui-unified 在「管理端非根进入」时置的跨区退出标记 zpExitAdmin，
    // 否则跳到 /home 后该标记会触发 history.back() 又弹回 /admin，重蹈循环覆辙
    // （在 PWA 历史栈 >1 的真实环境必现）。普通用户本就不需要跨区退出逻辑。
    try{sessionStorage.removeItem("zpExitAdmin")}catch(e){}
    // 明确本会话属于业务区，避免业务页门禁把司机误判成管理员又弹回 /admin
    try{sessionStorage.setItem("zpRole","user")}catch(e){}
    setTimeout(()=>location.replace("/home?v="+Date.now()),1200);
    return;
  }
  S.me=m.user;
  // 兜底：确认是管理员则固化本会话归属管理区（登录页已写，此处覆盖异常残留）
  try{sessionStorage.setItem("zpRole","admin")}catch(e){}
  $("who").innerHTML='<span class="role">管理员</span><span class="uname">'+esc(m.user.username)+'</span>';
  $("menuUsername").textContent=m.user.username;
  try{
    const r=await api("/api/routes?adminLoad="+Date.now());
    S.routes=r.routes||[];A.renderDiagnosticRoutes();
    const [u,q,i]=await Promise.all([
      api("/api/admin/users?adminLoad="+Date.now()),
      api("/api/admin/route-requests?adminLoad="+Date.now()),
      api("/api/invite-codes?adminLoad="+Date.now())
    ]);
    S.users=u.users||[];S.requests=q.requests||[];S.invites=i.codes||[];
    A.renderUsers();A.renderRoutes();A.renderDiagnosticRoutes();A.renderRequests();A.renderInvites();
  }catch(e){
    toast("管理员身份已验证，但部分数据读取失败："+(e.message||"请稍后重试"));
    A.renderUsers();A.renderRoutes();A.renderRequests();A.renderInvites();
  }
}$("search").oninput=A.renderUsers;document.addEventListener("click",e=>{if(!e.target.closest(".row,.route,.dialog"))closeSwipes()});document.querySelectorAll(".page").forEach(p=>p.addEventListener("scroll",closeSwipes,{passive:true}));$("addRoute").onclick=A.addRoute;$("menuBtn").onclick=()=>{const mb=$("menuBg");mb.hidden?A.openMenu():A.hideMenu()};$("menuBg").addEventListener("click",e=>{if(e.target===$("menuBg"))A.hideMenu()});document.addEventListener("keydown",e=>{if(e.key==="Escape")A.hideMenu()});/* popstate 已移交 ui-unified.js 中央控制器 zpHandleBack() */$("addInvite").onclick=A.addInvite;$("editUser").onclick=A.editUser;$("editPass").onclick=A.editPass;$("reset").onclick=A.resetData;$("diagQuery").onclick=A.renderDiagnostics;$("diagRefresh").onclick=A.renderDiagnostics;$("perfRefresh").onclick=A.renderPerfReport;
$("perfCopy").onclick=async()=>{const text=window.__zpPerfCopyText||"智配One 性能诊断报告\n尚无数据，请先刷新性能报告。";try{const ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();const ok=document.execCommand("copy");ta.remove();if(!ok)throw Error("copy failed");toast("诊断报告已复制，可直接粘贴发送")}catch(e){toast("复制失败，请刷新页面后重试")}};$("learnQuery")&&($("learnQuery").onclick=A.renderLearningIsolation);$("learnRefresh").onclick=A.renderLearningIsolation;$("learnIsolate").onclick=A.learnIsolate;$("logout").onclick=async()=>{A.hideMenu();if(!(await zpConfirm("退出登录","确定要退出当前管理员账号吗？","退出")))return;await fetch("/api/logout",{method:"POST",credentials:"same-origin",cache:"no-store"});location.replace("/")};document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>page(Number(b.dataset.i)));load();
A.load=load;
})(window.ZPAdmin);
