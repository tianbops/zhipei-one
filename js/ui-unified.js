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
      observer.observe(document.body,{childList:true,subtree:true});
    }
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initPasswordToggles,{once:true});
  else initPasswordToggles();

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
      ok.onclick=()=>finish(true);cancel.onclick=()=>finish(false);
      box.onclick=e=>{if(e.target===box)finish(false)};
      document.addEventListener("keydown",onKey);
      setTimeout(()=>cancel.focus(),0);
    });
  };
  // 来源驱动返回：URL 带 from= 时按固定映射回到对应板块首页，不再用
  // document.referrer / history.length 猜测（避免不同入口返回行为不一致）。
  // 无 from= 时回落到调用方给定的 fallback（与各页返回按钮的 href 一致）。
  window.zpGoBack=function(fallback="/home.html"){
    const from=new URLSearchParams(location.search).get("from");
    const map={
      history:"/pages/history.html",
      today:"/pages/today.html",
      process:"/home.html",
      data:"/pages/data.html",
      account:"/pages/account.html",
      route:"/pages/route_apply.html",
      home:"/home.html"
    };
    location.replace((from&&map[from])?map[from]:fallback);
  };
  function bindPageBack(){
    document.querySelectorAll(".page2-back,.dispatch-back,.history-back,.data-page-back").forEach(el=>{
      if(el.dataset.zpBackBound==="1")return;
      el.dataset.zpBackBound="1";
      el.addEventListener("click",e=>{
        e.preventDefault();
        window.zpGoBack("/home.html");
      });
    });
  }
  window.addEventListener("pageshow",bindPageBack);
  bindPageBack();

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
    if(window.MutationObserver)new MutationObserver(update).observe(el===document.scrollingElement?document.body:el,{childList:true,subtree:true});
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