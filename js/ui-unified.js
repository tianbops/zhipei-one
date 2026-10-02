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
  window.zpGoBack=function(fallback="/home.html"){
    const ref=document.referrer||"";
    let sameOrigin=false;
    try{sameOrigin=!!ref&&new URL(ref,location.href).origin===location.origin}catch{}
    if(sameOrigin&&history.length>1){history.back();return}
    location.replace(fallback);
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
    if(!target)return;
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