/* js/home/head-float.js —— 首页顶部两层浮层的显隐（二态弹收）
   ------------------------------------------------------------------
   p∈[0,1]：顶部浮层展开进度。p=1 完整展开、p=0 整块钻到品牌区天花板背后。

   2026-11-07 第五轮（用户：「恢复到以前，现在浮岛的问题是不弹出和收回，只是随着
   屏幕滚动了」）：第四轮把 p 和 scrollTop 做成了严格 1:1，浮岛等于挂在内容上一起
   滑 —— 手指滚多少它挪多少，没有「弹出来 / 收回去」这个动作。用户要的是二态：
   跨过阈值就整块弹开、再跨回去整块收回，中间不做比例跟随。

   现在的模型（回到 460 的二态弹收，去掉跟手与吸附）：
     · 只有两个稳定态 p=1 / p=0，切换一律走 --zp-island-dur/.ease（.14s 同曲线），
       与底栏同帧起步同帧停住 —— 这就是「上下呼应」；
     · 触发只看滚动位置，带滞回：离开顶部（scrollTop>48）收回到 0，
       回到顶部（scrollTop<=8）弹出到 1。8/48 的间距是为了慢滚时不来回闪；
     · 滚动过程中不逐帧写 p，只在跨阈值那一帧写一次 → 不存在「跟着屏幕滑」；
     · 纯 overlay：不写任何文档流高度（spacer 恒 0），列表的 scrollTop 与行位置
       在弹收全程一格不动 —— 「浮岛运动会推动门店列表」的红线继续守住。
   底栏：浮岛弹出 → 底栏沉下；浮岛收回 → 底栏升起。两者共用同一对运动令牌。 */
(function(){
  var main=document.querySelector("main.home-app");
  if(!main)return;
  var float=document.getElementById("zpHeadFloat");
  var scroller=main.querySelector(":scope > .zp-scroll");
  var topbar=main.querySelector(":scope > .topbar");
  if(!float||!scroller||!topbar)return;

  /* 通知 nav.js：首页底栏显隐由本模块接管（互斥反向），停用其滚动自隐藏，
     否则两套逻辑会互相覆盖 .is-nav-hidden。 */
  window.__zpHeadFloatActive=true;

  var H=1;                 /* 浮层高度（= transform 的 100% 行程） */
  var p=1;                 /* 当前展开进度，二态：只会是 1 或 0（探针 setP 例外） */
  var shown=true;          /* 二态真值：true=弹出、false=收回 */
  var rafId=0, navHidden=null, booted=false;

  /* 阈值：回到几乎顶部才弹、离开 48px 才收。单点会在慢滚/抖动时反复穿越，
     两个值拉开距离就只为「确实回顶部了」弹一次。 */
  var SHOW_AT=8, HIDE_AT=48;

  function clamp(v,a,b){return v<a?a:(v>b?b:v)}
  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  /* 顶底互斥反向：浮岛弹出（p=1）→ 底栏沉下；收回（p=0）→ 底栏升起。
     与浮岛同一次状态切换、同一对运动令牌，所以同帧起步、同帧停住。 */
  function syncNav(){
    var want=p>=.5;
    if(want!==navHidden){navHidden=want;navHide(want)}
  }
  function write(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
    /* 投影只在弹出时出现：收回态保持干净底色，避免阴影溢出到品牌区下沿 */
    float.classList.toggle("is-open",p>=.5);
  }
  /* 二态切换：一次写到底，交给 CSS 的 .14s 过渡去弹/收。
     不逐帧写 —— 这正是「不跟着屏幕滑」与「弹出/收回」的分界。 */
  function apply(show,animate){
    if(show===shown)return;
    shown=show;
    p=show?1:0;
    float.classList.toggle("is-scrolling",animate===false);
    write();
    syncNav();
  }

  function frame(){
    rafId=0;
    var st=scroller.scrollTop;
    if(shown&&st>HIDE_AT)apply(false);        /* 离开顶部 → 收回 */
    else if(!shown&&st<=SHOW_AT)apply(true);  /* 回到顶部 → 弹出 */
  }
  /* 只在跨阈值那一帧真正改状态；其余滚动帧只是读一次 scrollTop。 */
  function onScroll(){
    if(!rafId)rafId=requestAnimationFrame(frame);
  }

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    main.style.setProperty("--zp-ceiling-h",Math.max(0,br.bottom-mr.top)+"px");
    H=Math.round(float.getBoundingClientRect().height)||1;
    /* 首帧必须无过渡：CSS 初始是展开态（避免 JS 到位前先闪一下 -100%），
       首帧按当前 scrollTop 定态时若带 .14s，会看到浮岛「滑进来」一下。 */
    var first=!booted;
    if(first){
      booted=true;
      shown=scroller.scrollTop>HIDE_AT?false:true;
      p=shown?1:0;
      float.classList.add("is-scrolling");
      /* 首帧底栏也要瞬间到位：弹出态底栏本来就该沉下，若带 .14s，
         进首页会看到底部自己滑一下。掐掉过渡，下一帧恢复。 */
      var nv=document.querySelector(".zp-nav");
      if(nv)nv.style.transition="none";
      navHidden=p>=.5;
      navHide(navHidden);
      write();
      requestAnimationFrame(function(){
        float.classList.remove("is-scrolling");
        if(nv)nv.style.transition="";
      });
    }else{
      write();
    }
  }

  scroller.addEventListener("scroll",onScroll,{passive:true});

  /* 显式切换（供线上探针与桌面调试使用）。animate=false 时禁过渡，用于摆放基线。 */
  function setP(v,animate){
    v=clamp(v,0,1);
    shown=v>=.5;
    p=v;
    if(animate===false)float.classList.add("is-scrolling");
    else float.classList.remove("is-scrolling");
    write();
    syncNav();
  }

  if(window.ResizeObserver){
    new ResizeObserver(function(){measure()}).observe(float);
  }else{
    window.addEventListener("resize",measure,{passive:true});
  }
  window.addEventListener("load",measure);
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure)}catch(e){}

  window.__zpHeadFloat={
    getP:function(){return p},
    getH:function(){return H},
    isShown:function(){return shown},
    setP:setP,
    show:function(){setP(1,true)},
    hide:function(){setP(0,true)}
  };
  measure();
})();
