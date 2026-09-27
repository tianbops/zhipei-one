const form=document.getElementById("registerForm");
const message=document.getElementById("registerMessage");
const button=document.getElementById("registerButton");

document.querySelectorAll("[data-password-toggle]").forEach(toggle=>{
  toggle.addEventListener("click",()=>{
    const input=document.getElementById(toggle.dataset.passwordToggle);
    if(!input)return;
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
    const r=await fetch("/api/register",{
      method:"POST",
      credentials:"same-origin",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        username:document.getElementById("username").value.trim(),
        name:document.getElementById("name").value.trim(),
        password,
        inviteCode:document.getElementById("inviteCode").value.trim()
      })
    });
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||"注册失败，请稍后重试");
    message.textContent=d.message||"注册成功，请返回登录";
    setTimeout(()=>location.replace("/"),900);
  }catch(err){
    message.textContent=err.message||"注册失败，请稍后重试";
    button.disabled=false;
    button.textContent="注册";
  }
});