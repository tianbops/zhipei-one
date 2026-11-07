/* js/home/head-float.js —— 首页顶部两层浮层的显隐（滚动驱动）
   ------------------------------------------------------------------
   p∈[0,1]：顶部浮层展开进度。p=1 完整展开、p=0 整块钻到品牌区天花板背后。

   2026-11-07 第三轮（用户：「按住屏幕不放上下滑动，上下浮岛运动优化，参照 Shadowrocket」）：
   根因是「手势驱动」这条路本身走不通 —— touchstart/touchmove 必须 passive（否则列表
   滚不动），而浏览器一旦接管滚动就派发 touchcancel，逐帧的 touchmove 只来一两帧就断，
   浮层跟手 10–20px 就冻结，直到松手才按 accDy 一次性跳到端点。用户看到的是
   「拖的时候不动、松手啪一下」，而且松手方向判定偶尔与内容方向相反（上滑阅读时浮层
   反而弹出来遮住列表）。

   现在改为「滚动位置驱动」，与 Shadowrocket 同构：浮层不是被手指拖着走，而是被内容
   推着走 —— 列表滚多少，浮层就收多少，一像素不多一像素不少：
     p = 1 - clamp((scrollTop - base) / H, 0, 1)
   · 跟手自然发生：滚动是连续的，p 也连续，中间没有任何「松手才动」的断档；
   · 惯性滚动继续带着浮层走，甩一下就能收干净（比任何固定时长动画都干脆）；
   · 方向永远正确：上滑=内容上移=浮层收起，下滑=回看=浮层出现；
   · 完全不碰文档流：只写 transform，列表 scrollTop 与行位置不受任何影响（第二轮
     已取消让位块，这里继续保持）。

   滚动停止后若浮层停在半开位（卡片切一半最难看），150ms 后吸附到最近端点，并把
   映射基准 base 平移到当前位置 —— 这样吸附后不会出现「刚吸过去又被下一帧 scroll
   拉回半开」的回弹。吸附与底部让位共用 --zp-island-dur/.ease，同帧起停（上下呼应）。

   底部导航：p 跨滞回阈值时切换（<.35 收、>.65 出），滚动中即可同步，不需要等松手；
   阈值远离 .5，快速滚动来回时不会闪。 */
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

  var H=1;            /* 浮层高度 = 位移行程（transform 的 -100%） */
  var range=1;        /* 映射行程：浮层收完所需的滚动距离 = min(H, 可滚动余量) */
  var base=0;         /* 映射基准：scrollTop=base 时 p=1 */
  var p=1;
  var rafId=0, settleT=0, navHidden=null, booted=false;

  function clamp(v,a,b){return v<a?a:(v>b?b:v)}
  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  function mapP(st){return 1-clamp((st-base)/range,0,1)}

  /* 顶底互斥反向：浮层展开（p 高）→ 底栏沉下；浮层收起（p 低）→ 底栏升起。
     阈值 .65/.35 而非 .5：单点在快速滚动时会在中途反复穿越、底栏来回闪。 */
  function syncNav(){
    var want=navHidden;
    if(want===null)want=p>=.5;
    else if(!want&&p>=.65)want=true;     /* 浮层露到 65% 以上才沉 */
    else if(want&&p<.35)want=false;      /* 收到 35% 以下才升 */
    if(want!==navHidden){navHidden=want;navHide(want)}
  }
  function write(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
    /* 投影只在露出过半时出现，隐藏态保持干净底色（避免阴影溢出到品牌区下沿） */
    float.classList.toggle("is-open",p>=.5);
  }

  /* 滚动中：直接写 transform（.is-scrolling 禁过渡），p 与 scrollTop 严格 1:1，
     不引入任何动画时长 —— 跟手就是「内容走到哪，浮层到哪」。 */
  function frame(){
    rafId=0;
    var v=mapP(scroller.scrollTop);
    if(Math.abs(v-p)<0.0005)return;
    p=v;
    float.classList.add("is-scrolling");
    write();
    syncNav();
  }
  function onScroll(){
    if(!rafId)rafId=requestAnimationFrame(frame);
    if(settleT)clearTimeout(settleT);
    settleT=setTimeout(settle,150);
  }
  /* 停稳后吸附：半开位切一半最难看，吸到最近端点。base 一起平移，
     否则下一帧 scroll 会按旧基准把 p 拉回半开（回弹抖动）。 */
  function settle(){
    settleT=0;
    /* 吸附方向按「是否还在顶部」判，不按 p 就近：滚 30px 时 p 还有 0.78，
       若按就近会吸回展开 —— 用户明明是想看内容，浮层却又盖回来。
       只要离开顶部（>40px）就收到 0，回到顶部才展开，与「滚离顶部即隐藏」同义。 */
    var st=scroller.scrollTop;
    var to=st<=40?1:0;
    if(p>0.02&&p<0.98){
      base=to?clamp(st,0,range):clamp(st-range,0,range);
      float.classList.remove("is-scrolling");   /* 恢复 --zp-island-* 过渡 */
      requestAnimationFrame(function(){p=to;write();syncNav()});
    }else{
      float.classList.remove("is-scrolling");
      syncNav();
    }
  }

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    main.style.setProperty("--zp-ceiling-h",Math.max(0,br.bottom-mr.top)+"px");
    var h=Math.round(float.getBoundingClientRect().height)||1;
    /* 短列表兜底：可滚动余量不足浮层高度时，把映射行程压到余量，
       否则滚到底也收不满（永远半开、底栏也不让位）。 */
    var maxSt=Math.max(0,(scroller.scrollHeight||0)-(scroller.clientHeight||0));
    var rg=Math.max(1,Math.min(h,maxSt>0?maxSt:h));
    if(h!==H||rg!==range){H=h;range=rg;base=clamp(base,0,range)}
    /* 首帧必须无过渡：CSS 初始是展开态（避免 JS 到位前先闪一下 -100%），
       若此时按当前 scrollTop 修正还带 .14s，就会看到浮层「滑进来」一下。
       只在第一次 measure 关过渡，之后（切主题/字体/tab 显隐）都正常过渡。 */
    var first=!booted;
    if(first){booted=true;float.classList.add("is-scrolling")}
    p=mapP(scroller.scrollTop);
    write();
    /* 首帧就要把底栏摆到正确位置：初始 p=1（展开）→ 底栏沉下只留加号。
       否则要等第一次滚动才联动，首屏会看到「浮层展开 + 底栏还在」。 */
    if(first){
      /* 首帧联动也要「瞬间到位」：底栏从显示滑到沉下若带 .14s，进首页会看到
         底部自己滑一下。这里先掐掉过渡，下一帧恢复（之后所有联动照常动画）。 */
      var nv=document.querySelector(".zp-nav");
      if(nv)nv.style.transition="none";
      syncNav();
      requestAnimationFrame(function(){
        float.classList.remove("is-scrolling");
        if(nv)nv.style.transition="";
      });
    }
  }

  scroller.addEventListener("scroll",onScroll,{passive:true});

  /* 显式切换（供线上探针与桌面调试使用）。animate=false 时禁过渡，用于摆放基线。 */
  function setP(v,animate){
    v=clamp(v,0,1);
    var st=scroller.scrollTop;
    if(v>=1)base=clamp(st,0,range);
    else if(v<=0)base=clamp(st-range,0,range);
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
    setP:setP,
    show:function(){setP(1,true)},
    hide:function(){setP(0,true)}
  };
  measure();
})();
