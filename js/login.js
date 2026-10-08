const passwordToggle=document.querySelector("[data-password-toggle]");
const passwordInput=document.getElementById("password");
if(passwordToggle&&passwordInput){
 const syncVisibility=()=>{passwordToggle.hidden=passwordInput.value.length===0;if(passwordToggle.hidden&&passwordInput.type==="text"){passwordInput.type="password";passwordToggle.setAttribute("aria-pressed","false");passwordToggle.setAttribute("aria-label","显示密码")}};
 syncVisibility();
 passwordInput.addEventListener("input",syncVisibility);
 passwordToggle.addEventListener("click",()=>{if(!passwordInput.value.length)return;const visible=passwordInput.type==="text";passwordInput.type=visible?"password":"text";passwordToggle.setAttribute("aria-pressed",String(!visible));passwordToggle.setAttribute("aria-label",visible?"显示密码":"隐藏密码")});
}

const form=document.getElementById("loginForm");const message=document.getElementById("loginMessage");const button=document.getElementById("loginButton");
form?.addEventListener("submit",async e=>{e.preventDefault();message.textContent="";button.disabled=true;button.textContent="登录中…";try{
  // 15 秒超时：网络被 VPN/防火墙黑洞时给出明确提示，而不是永远卡在「登录中…」
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),15000);
  let r;
  try{r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},credentials:"same-origin",signal:ctrl.signal,body:JSON.stringify({username:document.getElementById("username").value.trim(),password:document.getElementById("password").value})})}
  catch(netErr){throw new Error("网络连接失败或超时，请检查网络后重试（若开了 VPN，请尝试切换网络/关闭 VPN）")}
  finally{clearTimeout(timer)}
  const d=await r.json().catch(()=>({}));if(!r.ok){const code=d.code||("HTTP_"+r.status);throw new Error("["+code+"] "+(d.error||"登录失败"))}
  const _role=d.user&&d.user.role;
  const _isAdmin=_role==="system_admin"||_role==="admin";
  // 记录本会话所属工作区：业务页据此拒绝管理员会话停留（两个板块互不串线）
  try{window.zpSetRole?window.zpSetRole(_role):sessionStorage.setItem("zpRole",_isAdmin?"admin":"user")}catch(e){}
  // 管理员端与司机端同处一个 PWA 窗口：登录即栈底（location.replace 进入，背后无首页）。
  // 系统返回由 ui-unified.js 守卫接管——第一次左滑停留并提示「再按一次退出」，
  // 第二次左滑真正退出到手机桌面，绝不穿越到司机首页。
  location.replace(_isAdmin?"/admin.html?v="+Date.now():"/home.html?v="+Date.now())}catch(err){message.textContent=err.message||"登录失败";button.disabled=false;button.textContent="登录"}});