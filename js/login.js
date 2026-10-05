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
  // 管理员端作为「独立工作区」打开：独立窗口拥有独立历史栈，系统返回只在管理员历史内
  // 生效，绝不穿越到司机首页；数据仍同源共享（cookie/localStorage/接口）。仅独立 PWA
  // 下启用，浏览器里沿用原 replace 行为（用户已认可「返回到浏览器页」为正常）。
  const _standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone===true;
  if(_isAdmin&&_standalone){
    let _w=null;try{_w=window.open("/admin.html?v="+Date.now(),"_blank")}catch(e){}
    if(_w)return; // 已切到独立的管理员窗口，当前登录窗口保持不动
    // 极少数被弹窗拦截：退回同窗口 replace，由 ui-unified 跨区防火墙兜底
  }
  location.replace(_isAdmin?"/admin.html?v="+Date.now():"/home.html?v="+Date.now())}catch(err){message.textContent=err.message||"登录失败";button.disabled=false;button.textContent="登录"}});