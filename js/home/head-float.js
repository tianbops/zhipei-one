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
   依赖 UI 层 nav.js 暴露的 zpNavSetHidden，故置于 home.bundle.js 末尾执行。 */
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

  var H=1,need=0,p=0,dragging=false,lastY=0,sx=0,sy=0,lock=null;

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
  }

  function navHide(hide){
    if(window.zpNavSetHidden)window.zpNavSetHidden(hide);
    else{var n=document.querySelector(".zp-nav");if(n)n.classList.toggle("is-nav-hidden",hide)}
  }
  function render(){
    float.style.transform="translateY("+(-(1-p)*100)+"%)";
    spacer.style.height=Math.round(need*p)+"px";
    navHide(p>=.5);
  }
  function setP(v,animate){
    p=Math.max(0,Math.min(1,v));
    float.classList.toggle("is-dragging",!animate);
    spacer.classList.toggle("is-dragging",!animate);
    render();
  }
  /* 松手就近吸附：慢速小幅滑动也有确定落点，不会出现「上滑没弹出」。 */
  function snap(){setP(p>=.5?1:0,true)}

  function ignore(e){
    var t=e.target;
    return !!(t&&t.closest&&t.closest("#uploadArea,[role=dialog],[aria-modal=true]"));
  }
  function down(x,y){dragging=true;lock=null;sx=x;sy=y;lastY=y}
  function move(x,y){
    if(!dragging)return;
    var dy=y-lastY;lastY=y;
    if(!lock){
      var ax=x-sx,ay=y-sy;
      if(Math.abs(ax)<8&&Math.abs(ay)<8)return;
      /* 只有明确纵向才接管；横向手势完全让给多单切页与门店行点击 */
      if(Math.abs(ay)<=Math.abs(ax)*1.2){dragging=false;return}
      lock="y";
    }
    if(Math.abs(dy)>0.5)setP(p-dy/(Math.max(1,H)*0.85),false);
  }
  function up(){if(!dragging)return;dragging=false;lock=null;snap()}

  /* touch 全程 passive：不 preventDefault，门店名单仍由 .zp-scroll 原生滚动承接，
     既能整页滚到统计卡，又让浮层跟手滑入滑出（列表从浮层下方穿过）。 */
  main.addEventListener("touchstart",function(e){
    if(ignore(e))return;
    var t=e.touches[0];if(t)down(t.clientX,t.clientY);
  },{passive:true});
  main.addEventListener("touchmove",function(e){
    if(!dragging||ignore(e))return;
    var t=e.touches[0];if(t)move(t.clientX,t.clientY);
  },{passive:true});
  main.addEventListener("touchend",up,{passive:true});
  main.addEventListener("touchcancel",up,{passive:true});

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
    if(!mouseDown)return;mouseDown=false;up();
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
