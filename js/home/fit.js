/* home/fit.js —— 首页「一屏定盘」的自适应兜底
   ------------------------------------------------------------
   纯 CSS（css/home-dashboard.css 末段）已经完成常规分配：flex 分配 + 一条断点。
   这里补三件 CSS 判断不了的事：

   1) 整行吸附：flex 分配后列表底部常露出「半行」，长门店名被拦腰切断会像 bug。
      这里把它吸附到「能完整显示的整行」高度，宁可在卡片底部留白，也不切字。
   2) 溢出降级：系统超大字号把行高撑开，列表不足 2 行时切回整页滚动。
   3) 键盘冻结：可视区骤降时锁死布局会把卡片压成一条，用 .is-keyboard 回退。

   阈值与 CSS 的 min-height:88px（2 行 × 44px）保持一致，两处不得各写一个数。
   降级是「粘性」的（进入后不自行退出），只有视口真正变化时才重新测量，
   否则会出现「降级 → 测量正常 → 恢复 → 再降级」的抖动循环。 */
(function () {
  var root = document.querySelector("main.home-app");
  if (!root) return;
  var scroller = root.querySelector(".zp-scroll");
  var list = document.getElementById("todayStoreList");
  if (!scroller || !list) return;

  var MIN_LIST_H = 86;   /* 88px 减去 2px 亚像素误差 */
  var lost = false;      /* 已降级：不再自动恢复，等视口变化重测 */
  var raf = 0;

  function clearSnap() {
    list.style.flex = "";
    list.style.height = "";
  }

  /* 把列表高度吸附到「完整行」的累计高度。
     只在列表确实可滚（内容多于可视）时才做——内容装得下时留白反而更怪。 */
  function snapList() {
    clearSnap();
    var avail = list.clientHeight;
    if (avail <= 0) return;
    /* 加载态（骨架/占位，还没有真实门店行）不吸附：数据到位后行数会变，
       提前吸附会让用户看到一次「列表高度跳变」。 */
    if (!list.querySelector(".today-store-row")) return;
    if (list.scrollHeight - avail <= 2) return;   /* 不溢出，保持自然高度 */

    var kids = list.children;
    var used = 0, fit = 0;
    for (var i = 0; i < kids.length; i++) {
      var h = kids[i].getBoundingClientRect().height;
      if (used + h > avail + 0.5) break;
      used += h;
      fit++;
    }
    if (fit <= 0) return;                          /* 一行都放不下：交给降级逻辑 */
    if (used >= avail - 0.5) return;                /* 刚好整行，不用吸 */

    list.style.flex = "0 0 auto";
    list.style.height = Math.ceil(used) + "px";
    syncFade();
  }

  /* 底部渐隐：仅「可滚且未到底」时启用，提示下面还有门店（滚动条全站隐藏，
     否则完全看不出列表能滚）。 */
  function syncFade() {
    /* 空态：整块区域垂直居中，避免「文案贴着分隔线、下面空一大片」 */
    list.classList.toggle("is-empty", list.children.length === 1 && !!list.querySelector(".today-store-empty"));
    var canScroll = list.scrollHeight - list.clientHeight > 2;
    var atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    list.classList.toggle("can-scroll", canScroll && !atEnd);
  }
  list.addEventListener("scroll", syncFade, { passive: true });

  function measure() {
    root.classList.remove("is-overflow");
    /* 强制同步布局：先让浏览器按「未降级、未吸附」重新排版，再取真实高度 */
    clearSnap();
    void scroller.offsetHeight;
    var overflowed = scroller.scrollHeight - scroller.clientHeight > 2;
    var listTooShort = list.clientHeight > 0 && list.clientHeight < MIN_LIST_H;

    if (overflowed || listTooShort) {
      root.classList.add("is-overflow");
      lost = true;
      syncFade();
      return;
    }
    if (!lost) snapList();
    syncFade();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; measure(); });
  }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () {
      if (lost) return;   /* 粘性：降级后忽略自身引发的尺寸变化 */
      schedule();
    });
    ro.observe(scroller);
  }

  window.addEventListener("resize", function () { lost = false; schedule(); });
  window.addEventListener("orientationchange", function () { lost = false; schedule(); });

  /* 键盘：两种 WebView 行为都要覆盖 ——
     A. 键盘把 WebView 整体压矮（innerHeight 变小）；
     B. 只有 visualViewport 变小（innerHeight 不变）。
     地址栏伸缩通常 60–90px，键盘 250px+，用 160px 区分。 */
  var baseH = window.innerHeight;
  var vv = window.visualViewport;
  function syncKeyboard() {
    var byViewport = baseH - window.innerHeight > 160;
    var byVisual = !!vv && window.innerHeight - vv.height > 160;
    root.classList.toggle("is-keyboard", byViewport || byVisual);
  }
  if (vv) {
    vv.addEventListener("resize", syncKeyboard);
    vv.addEventListener("scroll", syncKeyboard);
  }
  window.addEventListener("orientationchange", function () { baseH = window.innerHeight; syncKeyboard(); });

  schedule();
  /* 数据到位后列表行数会变（"加载中" → 真实门店），复核两次，覆盖慢网 */
  setTimeout(schedule, 600);
  setTimeout(schedule, 2000);
})();
