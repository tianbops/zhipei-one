/* js/home/head-float.js —— 首页顶部两层浮层的显隐（滚动位置驱动 · 静态让位）
   ------------------------------------------------------------------
   p∈[0,1]：顶部浮层展开进度。p=1 完整展开、p=0 整块钻到品牌区天花板背后。

   2026-11-07 第三轮（用户：「按住屏幕不放上下滑动，上下浮岛运动优化，参照 Shadowrocket」）：
   根因是「手势驱动」这条路本身走不通 —— touchstart/touchmove 必须 passive（否则列表
   滚不动），而浏览器一旦接管滚动就派发 touchcancel，逐帧的 touchmove 只来一两帧就断，
   浮层跟手 10–20px 就冻结，直到松手才按 accDy 一次性跳到端点。用户看到的是
   「拖的时候不动、松手啪一下」，而且松手方向判定偶尔与内容方向相反（上滑阅读时浮层
   反而弹出来遮住列表）。于是改成「滚动位置驱动」：浮层不是被手指拖着走，而是被内容
   推着走，列表滚多少、浮层收多少，一像素不多一像素不少。

   2026-11-07 第四轮（用户：「现在已经被改坏了」）：
   第三轮只做了「浮层跟着滚」，却把让位块一起撤成了 0，于是浮层变成一张永远压在名单
   上的玻璃，三个问题都出在「浮层与首行之间没有固定关系」：
     ① 首行被永久压住：scrollTop=0 时浮层盖住名单最上面 2–3 行；而只要往后滚一点点
        浮层就收、收完时这几行又已经滚过去了 —— 这几行任何滚动位置都看不到。第 1 单
        只有 2 家门店时，整份名单都在浮层底下，看起来像「空的」。
     ② 切行：浮层下沿与行边界没有对齐，滚动时门店行被从中间切断，像隔着一层玻璃看。
     ③ 松手跳：停手 150ms 把 p 吸附到端点（半开→整块消失/弹出），列表却原地不动，
        浮岛和名单各走各的，观感就是「改坏了」。
   这一轮的模型改成「静态让位 + 严格贴合」：
     · 让位块高度 = 浮层高 H − 首行自然偏移，只在 measure() 里写一次 CSS 变量，
       全程没有任何过渡与逐帧写入 —— 列表依旧零推动（第三轮的红线不变）；
     · p = 1 − scrollTop/range 严格 1:1，浮层下沿与首行顶边的间距是常数（约 12px），
       滚到哪里都不会切行；
     · 取消停手吸附：半开就是「头部滚了一半」这个真实状态，跟手、不回弹、不跳；
       展开时光层展开在让位块里，收起时让位块刚好滚出可视区，两头都不留空档。
   底部导航仍是顶底互斥反向（p 跨滞回阈值切换：p<.35 升起、p≥.65 沉下），
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

  var H=1;            /* 浮层高度（= transform 的 100% 行程） */
  var range=1;        /* 映射行程：收完所需的滚动距离 = min(H, 可滚动余量) */
  var inset=0;        /* 静态让位高度：首行永远落在浮层下沿下方 */
  var base=0;         /* 探针基准（正常滚动恒 0，只有 setP() 会平移它） */
  var p=1;
  var rafId=0, idleT=0, navHidden=null, booted=false;

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
  /* 滚动结束只做一件事：把过渡放回来（供切主题/换字号这类非滚动变化使用）。
     不吸附 —— 吸附会让浮层脱离内容跳一下，正是这一轮要修掉的观感。 */
  function onScroll(){
    if(!rafId)rafId=requestAnimationFrame(frame);
    if(idleT)clearTimeout(idleT);
    idleT=setTimeout(function(){idleT=0;float.classList.remove("is-scrolling")},120);
  }

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    main.style.setProperty("--zp-ceiling-h",Math.max(0,br.bottom-mr.top)+"px");
    var h=Math.round(float.getBoundingClientRect().height)||1;
    H=h;
    /* 静态让位：量出首行门店在内容坐标里的自然偏移（扣掉当前让位高度），
       让位高度取 H − 该偏移。这样 p=1 时浮层下沿正好停在首行上方十几像素，
       p=0 时这段让位又刚好滚出可视区、首行顶到上沿 —— 两头都不留空档，
       中间也不切行。只在 measure() 写一次，滚动过程中一格不动（列表零推动）。 */
    var rows=scroller.querySelectorAll(".today-store-row"),row=null;
    for(var i=0;i<rows.length;i++){if(rows[i].offsetParent!==null){row=rows[i];break}}
    if(!row)row=scroller.querySelector(".task-card");
    var natural=0;
    if(row){
      var sr=scroller.getBoundingClientRect();
      natural=Math.round(row.getBoundingClientRect().top-sr.top+scroller.scrollTop)-inset;
    }
    var wantInset=Math.max(0,H-natural);
    if(wantInset!==inset){
      inset=wantInset;
      main.style.setProperty("--zp-head-inset",inset+"px");
    }
    /* 短列表兜底：可滚动余量不足浮层高度时，把映射行程压到余量，
       否则滚到底也收不满（永远半开、底栏也不让位）。 */
    var maxSt=Math.max(0,(scroller.scrollHeight||0)-(scroller.clientHeight||0));
    var rg=Math.max(1,Math.min(h,maxSt>0?maxSt:h));
    if(rg!==range)range=rg;
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
    base=scroller.scrollTop-(1-v)*range;
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
    getInset:function(){return inset},
    setP:setP,
    show:function(){setP(1,true)},
    hide:function(){setP(0,true)}
  };
  measure();
})();
