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
   原生滚动叠加成抖动（真机残差极差 180px / 标准差 59.9）。现改为：跟手阶段只改
   浮层 transform（合成层，不占文档流），让位块高度冻结、列表位置恒定；仅松手二态
   吸附时一次性提交 0/need，配 .18s 过渡。列表只在吸附瞬间平滑让位一次，滑动全程零抖动。 */
(function(){
  var main=document.querySelector("main.home-app");
  if(!main)return;
  var float=document.getElementById("zpHeadFloat");
  var spacer=document.getElementById("zpHeadSpacer");
  var topbar=main.querySelector(":scope > .topbar");
  var scroller=main.querySelector(":scope > .zp-scroll");
  if(!float||!spacer||!topbar||!scroller)return;

  /* 通知 nav.js：首页底栏显隐由本模块接管（互斥反向），停用其滚动自隐藏，
     否则两套逻辑会互相覆盖 .is-nav-hidden。 */
  window.__zpHeadFloatActive=true;

  var H=1,need=0,p=0,dragging=false,sx=0,sy=0,pStart=0,lastY=0,accDy=0,lock=null;

  function measure(){
    var mr=main.getBoundingClientRect(),br=topbar.getBoundingClientRect();
    var ceiling=Math.max(0,br.bottom-mr.top);
    main.style.setProperty("--zp-ceiling-h",ceiling+"px");
    H=Math.round(float.getBoundingClientRect().height)||1;
    /* 让位高度：使门店首行落在浮层下沿之外，避免被白卡片切半。
       名单首行相对外壳 = 滚动区顶 + 上内边距 + spacer；
       浮层下沿相对外壳 = 天花板底 + H。 */
    var sr=scroller.getBoundingClientRect();
    var padTop=parseFloat(getComputedStyle(scroller).paddingTop)||0;
    var gap=10;
    need=Math.max(0,Math.ceil(H+gap-(sr.top-br.bottom)-padTop));
    render();
    /* 浮层尺寸变化（tab 显隐 / 字体 / 主题）时按新 need 重提交让位；
       跟手过程中跳过，保持布局冻结、列表位置恒定。 */
    if(!dragging&&p>=.5)commitSpacer();
  }

  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  function render(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
    navHide(p>=.5);
  }
  /* 让位块只在「二态吸附」时提交（p>=.5 → need，否则 0），配 .18s 过渡。
     跟手阶段不调用：spacer 高度冻结 → 门店列表位置恒定、跟手全程零重排。
     这是 Shadowrocket「列表位置恒定 + 浮层纯 overlay + 二态快速吸附」的落地，
     消除原先逐帧改文档流高度（跟手 24 帧顶动 180px）与原生滚动叠加造成的抖动；
     列表只在松手吸附时平滑让位一次，是预期的吸附动画，不再与滚动打架。 */
  function commitSpacer(){
    spacer.style.height=(p>=.5?Math.round(need):0)+"px";
  }
  function setP(v,animate){
    p=Math.max(0,Math.min(1,v));
    float.classList.toggle("is-dragging",!animate);
    /* 投影只随浮层露出时出现：p=0 隐藏态去掉阴影，避免它溢出到品牌区下沿
       形成一条渐变虚化带（隐藏态浮层本就该「完全消失、不留痕迹」）。
       阈值与底栏反向、二态吸附同用 .5，保持一套语义。 */
    float.classList.toggle("is-open",p>=.5);
    spacer.classList.toggle("is-dragging",!animate);
    render();
    if(animate)commitSpacer();   /* 仅吸附时提交让位；跟手时冻结布局 */
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
    setP(pStart-ay/(Math.max(1,H)*0.85),false);
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
