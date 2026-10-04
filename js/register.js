const form=document.getElementById("registerForm");
const message=document.getElementById("registerMessage");
const button=document.getElementById("registerButton");

document.querySelectorAll("[data-password-toggle]").forEach(toggle=>{
  const input=document.getElementById(toggle.dataset.passwordToggle);
  if(!input)return;

  const syncVisibility=()=>{
    toggle.hidden=input.value.length===0;
    if(toggle.hidden && input.type==="text"){
      input.type="password";
      toggle.setAttribute("aria-pressed","false");
      toggle.setAttribute("aria-label","显示密码");
    }
  };

  toggle.hidden=input.value.length===0;
  input.addEventListener("input",syncVisibility);

  toggle.addEventListener("click",()=>{
    if(input.value.length===0)return;
    const visible=input.type==="text";
    input.type=visible?"password":"text";
    toggle.setAttribute("aria-pressed",String(!visible));
    toggle.setAttribute("aria-label",visible?"显示密码":"隐藏密码");
  });
});

form?.addEventListener("submit",async e=>{
  e.preventDefault();
  message.textContent="";
  const password=document.getElementById("password").value;
  const confirm=document.getElementById("confirmPassword").value;
  if(password!==confirm){message.textContent="两次密码不一致";return}
  button.disabled=true;
  button.textContent="注册中…";
  try{
    // 15 秒超时：网络黑洞时给出明确提示，而不是永远卡在「注册中…」
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),15000);
    let r;
    try{
      r=await fetch("/api/register",{
        method:"POST",
        credentials:"same-origin",
        signal:ctrl.signal,
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          username:document.getElementById("username").value.trim(),
          password,
          inviteCode:document.getElementById("inviteCode").value.trim()
        })
      });
    }catch(netErr){throw new Error("网络连接失败或超时，请检查网络后重试（若开了 VPN，请尝试切换网络/关闭 VPN）")}
    finally{clearTimeout(timer)}
    const d=await r.json().catch(()=>({}));
    if(!r.ok){const code=d.code||("HTTP_"+r.status);const detail=d.detail?(" · "+d.detail):"";throw new Error("["+code+"] "+(d.error||"注册失败")+detail)}
    message.textContent=d.message||"注册成功，请返回登录";
    setTimeout(()=>location.replace("/"),900);
  }catch(err){
    message.textContent=err.message||"注册失败，请稍后重试";
    button.disabled=false;
    button.textContent="注册";
  }
});