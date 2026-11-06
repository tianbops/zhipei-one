/* js/ui/store-name-scroll.js —— 门店名「单行 + 左滑看全名 + 静置自动回位」
   2026-11-06 抽出共享实现：首页今日配送、运单详情、今日配送独立页
   原来只有首页做了这套交互，运单里长名仍会折成两三行，列表节奏不齐。
   现在行为只维护这一份，三处必须完全一致，避免各改各的再次漂移。

   结构约定（由 zpStoreNameHtml 生成）：
     <span class="zp-store-name-wrap"><span class="zp-store-name">名称</span></span>
   - wrap：横向滚动容器，只占一行，右侧渐隐提示「后面还有字」；
   - name：nowrap，宽度超出时由 wrap 滚动，不用 line-clamp（只裁不给看）。

   交互约定：
   - 手指松开、滚动停止后静置 2.4s，320ms ease-out 平滑滑回起点；
   - 手指落下 / 焦点进入即取消回位；按住期间不抢；
   - 同一容器同时只留一行滑开，按另一行时前一行立即归零；
   - 横向拖动过的手势在 window 捕获阶段吞掉 click（否则看名字会跳出地图）；
   - 切到后台立即复位；系统「减弱动效」时直接跳回。 */
(function(){
  "use strict";
  if(window.zpStoreNameHtml)return;
  var DELAY=2400,DURATION=320;
  var timer=0,raf=0,returning=false;
  var pressing=false,startX=0,startY=0,lastSwipeAt=0;

  function esc(v){
    return String(v==null?"":v).replace(/[&<>"']/g,function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function sync(el){
    if(!el||!el.classList)return;
    var over=el.scrollWidth>el.clientWidth+1;
    el.classList.toggle("is-scrollable",over);
    el.classList.toggle("at-end",over&&el.scrollLeft+el.clientWidth>=el.scrollWidth-2);
  }
  function cancel(){
    if(timer){clearTimeout(timer);timer=0}
    if(raf){cancelAnimationFrame(raf);raf=0}
    returning=false;
  }
  /* instant=true：需要立刻让位（如另一行开始滑动），不播动画 */
  function back(el,instant){
    if(!el)return;
    cancel();
    var from=el.scrollLeft;
    if(from<=0){sync(el);return}
    var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(instant||reduce){el.scrollLeft=0;sync(el);return}
    var t0=performance.now();
    returning=true;
    var step=function(now){
      if(!el.isConnected){raf=0;returning=false;return}
      var p=Math.min(1,(now-t0)/DURATION);
      el.scrollLeft=Math.max(0,Math.round(from*(1-Math.pow(1-p,3))));
      if(p<1){raf=requestAnimationFrame(step);return}
      raf=0;returning=false;
      el.scrollLeft=0;sync(el);
    };
    raf=requestAnimationFrame(step);
  }
  function schedule(el){
    if(raf||!el)return;              /* 正在回位：让它走完，不重排 */
    if(timer)clearTimeout(timer);
    timer=setTimeout(function(){timer=0;back(el)},DELAY);
  }
  function wrapOf(target){
    return target&&target.closest?target.closest(".zp-store-name-wrap"):null;
  }
  /* 行容器带 data-zp-store-row：手指可能落在名称以外（序号、备注、状态徽标），
     但同样属于这一行的拖动/轻点，必须按「整行」判断，不能只看名称容器。 */
  function rowOf(target){
    if(!target||!target.closest)return null;
    return target.closest("[data-zp-store-row]");
  }
  function wrapInRow(row){
    return row&&row.querySelector?row.querySelector(".zp-store-name-wrap"):null;
  }

  /* 名称 → HTML（内部转义，调用方传原始文本） */
  window.zpStoreNameHtml=function(name){
    return '<span class="zp-store-name-wrap"><span class="zp-store-name">'+esc(name)+'</span></span>';
  };

  /* 渲染完成后调用：按实际宽度标记「可滑动 / 已到末尾」 */
  window.zpRefreshStoreNameScroll=function(root){
    if(!root)return;
    requestAnimationFrame(function(){
      var list=root.querySelectorAll(".zp-store-name-wrap");
      for(var i=0;i<list.length;i++)sync(list[i]);
    });
  };

  window.zpBindStoreNameScroll=function(root){
    if(!root||root.dataset.zpNameScroll==="1")return;
    root.dataset.zpNameScroll="1";
    /* scroll 不冒泡，用捕获阶段统一接住容器内每个名称 */
    root.addEventListener("scroll",function(e){
      var el=e.target;
      if(!el||!el.classList||!el.classList.contains("zp-store-name-wrap"))return;
      sync(el);
      if(returning)return;           /* 回位动画自身触发的 scroll，不得再排期（会死循环） */
      if(el.scrollLeft>0)schedule(el);
      else if(timer){clearTimeout(timer);timer=0}
    },true);
    root.addEventListener("pointerdown",function(e){
      if(e.pointerType==="mouse"&&e.button!==0)return;
      startX=e.clientX;startY=e.clientY;pressing=true;
      /* 手又落下来了：取消回位，并把其它还滑开着的行立刻归零（同时只留一行） */
      cancel();
      var row=rowOf(e.target);
      var self=(row&&wrapInRow(row))||wrapOf(e.target);
      var list=root.querySelectorAll(".zp-store-name-wrap");
      for(var i=0;i<list.length;i++){
        if(list[i]!==self&&list[i].scrollLeft>0)back(list[i],true);
      }
    },true);
    root.addEventListener("pointermove",function(e){
      if(!pressing)return;
      var dx=e.clientX-startX,dy=e.clientY-startY;
      if(Math.abs(dx)>8&&Math.abs(dx)>Math.abs(dy))lastSwipeAt=Date.now();
    },{capture:true,passive:true});
    /* 松手后再排一次：点一下不动（不产生 scroll）时也能把计时接上 */
    var endPress=function(e){
      pressing=false;
      var el=wrapOf(e.target);
      if(el&&el.scrollLeft>0)schedule(el);
    };
    root.addEventListener("pointerup",endPress,true);
    root.addEventListener("pointercancel",endPress,true);
    /* 键盘/读屏把焦点移到某行时不要回位：人正在读 */
    root.addEventListener("focusin",function(){
      if(timer){clearTimeout(timer);timer=0}
    },true);
    window.addEventListener("resize",function(){window.zpRefreshStoreNameScroll(root)},{passive:true});
  };

  /* 滑动过的手势不得弹菜单/跳链接。
     必须挂在 window 捕获阶段：地图导航的委托在 document 捕获阶段，
     挂在列表自身会晚于它执行，stopImmediatePropagation 已经来不及。 */
  window.addEventListener("click",function(e){
    if(!lastSwipeAt||Date.now()-lastSwipeAt>=600)return;
    var row=rowOf(e.target);
    if(!row||!wrapInRow(row))return;
    /* 一次滑动只吞掉它自己那一次 click：不清标记的话，紧接着的轻点也会被误吞 */
    e.preventDefault();e.stopImmediatePropagation();lastSwipeAt=0;
  },true);

  /* 切到后台立即复位，回来不会看到半截名字 */
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState!=="hidden")return;
    var list=document.querySelectorAll(".zp-store-name-wrap");
    for(var i=0;i<list.length;i++){
      if(list[i].scrollLeft>0)back(list[i],true);
    }
  });
})();
