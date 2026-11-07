/* js/home/head-float.js —— 首页顶部两层浮层的显隐（方向驱动二态弹收）
   ------------------------------------------------------------------
   p∈[0,1]：顶部浮层展开进度。p=1 完整展开、p=0 整块钻到品牌区天花板背后。

   2026-11-07 第七轮（用户：「上滑屏幕下方浮岛隐藏、上方浮岛弹出；下滑屏幕下方浮岛
   弹出、上方浮岛隐藏。目前刚好反了，请修正」）：
   把方向映射对调 —— 上一轮是「上滑 → 上方收回、底栏升起」，正好相反。
   现在：
     · 上滑（内容上移，scrollTop 变大）→ 上方浮岛弹出 + 下方浮岛隐藏；
     · 下滑（内容下移，scrollTop 变小）→ 上方浮岛隐藏 + 下方浮岛弹出；
     · 只累计同向位移 6px 即切换（屏幕一动就反应），方向反转立刻清零
       （惯性回弹、手抖不会来回闪）；
     · 不再有「回到顶部必弹」的位置例外：回顶是一次下滑，按下滑规则走。

   其余不变：
     · 只有两个稳定态 p=1 / p=0，切换走 --zp-island-dur/.ease（.14s 同曲线），
       与底栏同帧起步同帧停住 —— 这就是「上下呼应」；
     · 滚动帧只在跨方向时写一次 p，不做比例跟随 → 没有「挂在内容上滑」；
     · 允许遮挡：纯 overlay，不写任何文档流高度（spacer 恒 0），列表的 scrollTop
       与行位置在弹收全程一格不动 —— 「浮岛运动会推动门店列表」的红线继续守住。
   底栏：上方浮岛弹出 → 下方浮岛沉下；上方浮岛隐藏 → 下方浮岛升起。
   两者是互斥反向的一对，共用同一对运动令牌，所以同帧起步、同帧停住。 */
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

  /* MOVE=同向累计位移多少即切换（6px 基本等于「屏幕一动就反应」，方向反转清零
     让回弹不误触）。TOP_AT 只用于首帧定态：进首页时在顶部就展开配送卡，
     之后方向完全由手指决定（回到顶部是一次下滑，按下滑规则隐藏上方浮岛）。 */
  var TOP_AT=6, MOVE=6;
  var lastSt=0, acc=0;

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

  /* 方向驱动：屏幕一动就给反应。
     d>0 = 内容上移（手指往上推）→ 上方浮岛弹出、下方浮岛隐藏；
     d<0 = 内容下移（手指往下拉）→ 上方浮岛隐藏、下方浮岛弹出。
     只累计与当前方向相同的位移，反向立刻清零（惯性回弹不误触）。 */
  function frame(){
    rafId=0;
    var st=scroller.scrollTop;
    var d=st-lastSt;
    lastSt=st;
    if(!d)return;
    if((acc>0)!==(d>0))acc=0;
    acc+=d;
    if(acc>=MOVE){                        /* 上滑 → 上方弹出（下方随互斥隐藏） */
      acc=0;
      if(!shown)apply(true);
    }else if(acc<=-MOVE){                 /* 下滑 → 上方隐藏（下方随互斥弹出） */
      acc=0;
      if(shown)apply(false);
    }
  }
  /* 滚动帧只在跨方向时真正改状态；其余帧只是读一次 scrollTop。 */
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
      shown=scroller.scrollTop>TOP_AT?false:true;
      p=shown?1:0;
      lastSt=scroller.scrollTop;
      acc=0;
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
    lastSt=scroller.scrollTop;
    acc=0;
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
