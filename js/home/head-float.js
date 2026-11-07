/* js/home/head-float.js —— 首页顶部两层浮层的显隐手势
   ------------------------------------------------------------------
   忠实落地已通过真触摸验证的交互原型（home-island-prototype.html）：
     · p∈[0,1] 表示顶部浮层展开进度，p=0 完全隐藏、p=1 完整展开；
     · 隐藏态整块 translateY(-100%) 钻到品牌区天花板背后，不留把手线、不占位；
     · 门店名单让位块随 p 撑开，保证首行不被白卡片切成半截；
     · 底栏与顶部互斥反向：顶部出现 → 底栏隐藏，顶部隐藏 → 底栏出现；
     · 手指上滑（往下读）→ 顶部弹出；下滑（回看上方）→ 顶部完全隐藏。
   整屏任意位置生效；横向手势（多单切页 / 门店行点击）不介入；上传弹层内不拦截。
   不注入、不改写任何业务数据。
   依赖 UI 层 nav.js 暴露的 zpNavSetHidden，故置于 home.bundle.js 末尾执行。

   稳定性要点（2026-11-07 真机 CDP 复测）：touch 全程 passive、不 preventDefault，
   门店名单仍由 .zp-scroll 原生滚动承接；但浏览器一旦接管滚动就会提前派发
   touchcancel，逐帧累加的 p 往往只走到很小便被截断。故逐帧只用「起点绝对位移」
   算 p 做跟手过渡，松手统一按「本次累计位移方向」定端点：上滑→p=1、下滑→p=0，
   即使只剩一两个 touchmove 也能可靠弹出/隐藏，不出现「上滑没弹出」。

   抗抖动（2026-11-07，采用 Shadowrocket 滑动参数）：视频逐帧实测其「列表位置恒定、
   浮层纯 overlay、二态快速吸附（约 0.1–0.2s）」。原先 render() 每帧按 p 改
   .zp-head-spacer 的文档流高度，跟手 24 帧把门店列表往下顶 180px，与 .zp-scroll
   原生滚动叠加成抖动（真机残差极差 180px / 标准差 59.9）。第一轮改为「吸附时一次性
   提交让位」，但松手瞬间仍有 122px 的文档流位移，用户反馈「浮岛运动推动门店列表」。

   第二轮（2026-11-07，用户：「门店列表滚动要保持稳定，整改浮岛运动会推动门店列表」）：
   彻底取消让位 —— spacer 高度恒为 0，浮层回归纯 overlay。列表内容的文档流位置
   从头到尾不动（滚动位置、首行 y 都不变），浮层展开时盖住列表上半部，滚动时内容
   从浮层下沿穿过；收起后自然露出。这是 Shadowrocket 的做法，也是「稳定」的唯一解：
   只要还改文档流高度，无论有没有过渡，列表都会被推动。 */
(function(){
  var main=document.querySelector("main.home-app");
  if(!main)return;
  var float=document.getElementById("zpHeadFloat");
  var topbar=main.querySelector(":scope > .topbar");
  if(!float||!topbar)return;

  /* 通知 nav.js：首页底栏显隐由本模块接管（互斥反向），停用其滚动自隐藏，
     否则两套逻辑会互相覆盖 .is-nav-hidden。 */
  window.__zpHeadFloatActive=true;

  var H=1,p=0,dragging=false,sx=0,sy=0,pStart=0,lastY=0,accDy=0,lock=null;

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    var ceiling=Math.max(0,br.bottom-mr.top);
    main.style.setProperty("--zp-ceiling-h",ceiling+"px");
    H=Math.round(float.getBoundingClientRect().height)||1;
    /* 只更新天花板高度与跟手基准 H，不碰文档流：列表位置自始至终由 .zp-scroll
       自己决定，浮岛的任何显隐/尺寸变化都不会推动它。 */
    render();
  }

  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  function render(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
  }
  function setP(v,animate){
    p=Math.max(0,Math.min(1,v));
    /* 2026-11-07：底栏不再跟着 p>=.5 走 —— 跟手中一旦跨过一半就切换，
       用户来回拖时它会提前滑走/滑回（.24s 过渡还在跑又反向），看着「不跟手」。
       现在只在「松手吸附」这一刻切：顶部吸附与底栏让位同一帧起步，
       两者共用 --zp-island-dur/.ease，同刻停住 —— 这就是上下呼应。 */
    if(animate)navHide(p>=.5);
    float.classList.toggle("is-dragging",!animate);
    /* 投影只随浮层露出时出现：p=0 隐藏态去掉阴影，避免它溢出到品牌区下沿
       形成一条渐变虚化带（隐藏态浮层本就该「完全消失、不留痕迹」）。
       阈值与底栏反向、二态吸附同用 .5，保持一套语义。 */
    float.classList.toggle("is-open",p>=.5);
    render();
  }
  /* 结束手势：按「本次累计位移方向」定端点，而不是按最后一帧的进度吸附。
     passive + 原生滚动下浏览器可能提前 touchcancel，逐帧 p 会停在很小的值；
     用起点→终点方向兜底，慢速小幅滑动、只剩一两个 touchmove 都有确定落点。 */
  function end(){
    if(!dragging)return;
    dragging=false;
    var wasY=(lock==="y");
    lock=null;
    if(!wasY)return;                              /* 横向手势：浮层保持原态 */
    if(Math.abs(accDy)>=12)setP(accDy<0?1:0,true); /* 上滑→弹出 / 下滑→隐藏 */
    else setP(p>=.5?1:0,true);                    /* 位移过小：就近吸附 */
  }

  function ignore(e){
    var t=e.target;
    return !!(t&&t.closest&&t.closest("#uploadArea,[role=dialog],[aria-modal=true]"));
  }
  function down(x,y){dragging=true;lock=null;sx=x;sy=y;lastY=y;pStart=p;accDy=0}
  function move(x,y){
    if(!dragging)return;
    lastY=y;
    var ax=x-sx,ay=y-sy;
    accDy=ay;                                   /* 任何移动都记录累计位移，供 end 判方向 */
    if(!lock){
      if(Math.abs(ax)<8&&Math.abs(ay)<8)return;
      /* 只有明确纵向才接管；横向手势完全让给多单切页与门店行点击 */
      if(Math.abs(ay)<=Math.abs(ax)*1.2){dragging=false;return}
      lock="y";
    }
    /* 用「起点绝对位移」而非逐帧增量算 p：不怕丢帧，也不怕 H 在滚动中变化 */
    /* 跟手 1:1：手指走多少、浮层走多少。原 0.85 是放大系数（拖 117px 就全开），
       手感「滑」且与底栏的位移速率对不上；改回 1:1 后拖动更实，松手吸附更快。 */
    setP(pStart-ay/Math.max(1,H),false);
  }

  /* touch 全程 passive：不 preventDefault，门店名单仍由 .zp-scroll 原生滚动承接，
     既能整页滚到统计卡，又让浮层跟手滑入滑出（列表从浮层下方穿过）。
     touchcancel 与 touchend 共用 end()，浏览器接管滚动提前取消时方向依然确定。 */
  main.addEventListener("touchstart",function(e){
    if(ignore(e))return;
    var t=e.touches[0];if(t)down(t.clientX,t.clientY);
  },{passive:true});
  main.addEventListener("touchmove",function(e){
    if(!dragging||ignore(e))return;
    var t=e.touches[0];if(t)move(t.clientX,t.clientY);
  },{passive:true});
  main.addEventListener("touchend",end,{passive:true});
  main.addEventListener("touchcancel",end,{passive:true});

  /* 桌面 / 自动化验证：鼠标拖拽与滚轮走同一套 p */
  var mouseDown=false;
  main.addEventListener("mousedown",function(e){
    if(ignore(e)||e.button!==0)return;
    mouseDown=true;down(e.clientX,e.clientY);
  });
  window.addEventListener("mousemove",function(e){
    if(!mouseDown)return;move(e.clientX,e.clientY);
  });
  window.addEventListener("mouseup",function(){
    if(!mouseDown)return;mouseDown=false;end();
  });
  var lastWheel=0;
  main.addEventListener("wheel",function(e){
    if(ignore(e))return;
    var now=Date.now();
    if(now-lastWheel<400)return;   /* 抑制惯性滚轮连发导致浮层反复横跳 */
    lastWheel=now;
    setP(e.deltaY>0?1:0,true);
  },{passive:true});

  /* 浮层高度会随多单 tab 显隐 / 字体就绪 / 主题切换变化：实测重算让位高度。
     只观察浮层自身，不介入 zpSyncTodayHeight 的列表锁高。 */
  if(window.ResizeObserver){
    new ResizeObserver(function(){measure()}).observe(float);
  }else{
    window.addEventListener("resize",measure,{passive:true});
  }
  window.addEventListener("load",measure);
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(measure)}catch(e){}

  /* 只读状态 + 显式切换，供线上真触摸探针断言（不注入任何业务数据） */
  window.__zpHeadFloat={
    getP:function(){return p},
    getH:function(){return H},
    setP:setP,
    show:function(){setP(1,true)},
    hide:function(){setP(0,true)}
  };
  measure();
})();
