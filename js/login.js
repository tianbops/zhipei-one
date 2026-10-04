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
  const d=await r.json().catch(()=>({}));if(!r.ok){const code=d.code||("HTTP_"+r.status);throw new Error("["+code+"] "+(d.error||"登录失败"))}location.replace(d.user?.role==="system_admin"||d.user?.role==="admin"?"/admin.html?v="+Date.now():"/home.html?v="+Date.now())}catch(err){message.textContent=err.message||"登录失败";button.disabled=false;button.textContent="登录"}});