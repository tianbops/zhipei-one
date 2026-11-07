/* js/home/head-float.js —— 首页上下两层浮岛的显隐（方向驱动 · 二态弹收）
   ------------------------------------------------------------------
   行为规格（唯一的真相源，改行为先改这里）
   1) 两个稳定态：p=1 展开 / p=0 收回。p 是顶部浮层的展开进度，只用 translateY
      表达：0% ↔ -100%，差值 100% 由浮层自身高度决定，不写死像素。
   2) 手势方向：
        · 上滑（内容上移，scrollTop 变大）→ 上方浮岛弹出、下方底栏隐藏；
        · 下滑（内容下移，scrollTop 变小）→ 上方浮岛隐藏、下方底栏弹出。
      同向位移累计 6px 即切换（屏幕一动就反应）；方向一反转立即清零，
      惯性回弹与手抖不会让浮岛来回闪。
   3) 底栏是互斥反向的一对：取同一个 p（p>=.5 → 沉下），共用同一对
      --zp-island-dur / --zp-island-ease，所以同帧起步、同帧停住。
   4) 浮岛是纯 overlay：只写 transform，不写任何文档流高度；名单的 scrollTop
      与行位置在弹收全程一格不动（「浮岛运动不推动门店列表」的红线）。
   5) 首帧按当前 scrollTop 定态，并临时关掉过渡，避免进首页时看到浮岛滑进来。

   实现要点
   · 滚动监听是 passive 的：滚动本身交给浏览器，本模块只在跨方向时改一次状态，
     其余帧只读一次 scrollTop —— 不逐帧写样式，也就不存在「挂在内容上滑」。
   · 不用 touch 事件：passive touchmove 会被浏览器接管滚动后的 touchcancel 截断，
     手势只能走十几像素就失效（历史问题）。方向由 scrollTop 差值判断，天然跟手。 */
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

  var p=1;                 /* 展开进度：二态，只会是 1 或 0（探针 setP 例外） */
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
  /* 顶底互斥反向：浮岛弹出（p=1）→ 底栏沉下；收回（p=0）→ 底栏升起。 */
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
  function apply(show){
    if(show===shown)return;
    shown=show;
    p=show?1:0;
    write();
    syncNav();
  }

  /* 方向驱动：屏幕一动就给反应。
     d>0 = 内容上移（手指往上推）→ 上方浮岛弹出、下方浮岛隐藏；
     d<0 = 内容下移（手指往下拉）→ 上方浮岛隐藏、下方浮岛弹出。 */
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
    /* 天花板高度写进 CSS 变量：浮层 top 取它，品牌区多高浮层就贴多高 */
    main.style.setProperty("--zp-ceiling-h",Math.max(0,br.bottom-mr.top)+"px");
    /* 首帧必须无过渡：CSS 初始是展开态（避免 JS 到位前先闪一下 -100%），
       首帧按当前 scrollTop 定态时若带 .14s，会看到浮岛「滑进来」一下。 */
    if(booted)return;
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
  }

  scroller.addEventListener("scroll",onScroll,{passive:true});

  /* 线上探针：只给验证脚本读状态 / 摆基线用，不参与产品逻辑。 */
  function setP(v,animate){
    v=clamp(v,0,1);
    shown=v>=.5;
    p=v;
    lastSt=scroller.scrollTop;
    acc=0;
    float.classList.toggle("is-scrolling",animate===false);
    write();
    syncNav();
  }

  /* 同时观察浮层与品牌区：浮层换行 / 品牌区增减状态点都会改变天花板高度，
     只观察其中一个会漏掉另一种尺寸变化。 */
  if(window.ResizeObserver){
    var ro=new ResizeObserver(function(){measure()});
    ro.observe(float);
    ro.observe(topbar);
  }else{
    window.addEventListener("resize",measure,{passive:true});
  }
  window.addEventListener("load",measure);
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure)}catch(e){}

  window.__zpHeadFloat={
    getP:function(){return p},
    isShown:function(){return shown},
    setP:setP
  };
  measure();
})();
