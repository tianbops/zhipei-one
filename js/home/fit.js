/* home/fit.js —— 首页「一屏定盘」的自适应兜底
   ------------------------------------------------------------
   纯 CSS（css/home-dashboard.css 末段）已完成常规分配：flex 分配 + 一条断点。
   这里补两件 CSS 判断不了的事：

   1) 溢出降级：系统超大字号把行高撑开、门店列表不足 4 行时，切回整页滚动；
   2) 键盘冻结：可视区骤降时锁死布局会把卡片压成一条，用 .is-keyboard 回退。

   2026-10-29 调整：**不做整行吸附**。吸附会把列表截到「最后一个完整行」，
   长门店名（行高 49px）时卡片底部会留 40px 以上空白 —— 用户反馈
   「显示 5 排也不会超出，滚动框内留白太多」。现在改为填满可用高度，
   底部用 26px 渐隐处理被切的那半行：渐隐本身就是「还能往下滚」的暗示，
   同时把内容利用率提到最高。

   阈值与 CSS 的 min-height（4 行 × 44px）同源，两处不得各写一个数。
   降级是「粘性」的（进入后不自行退出），只有视口真正变化时才重新测量，
   否则会出现「降级 → 测量正常 → 恢复 → 再降级」的抖动循环。 */
(function () {
  var root = document.querySelector("main.home-app");
  if (!root) return;
  var scroller = root.querySelector(".zp-scroll");
  var list = document.getElementById("todayStoreList");
  if (!scroller || !list) return;

  var MIN_LIST_H = 172;  /* 4 行（176）减 4px 亚像素误差 */
  var lost = false;      /* 已降级：不再自动恢复，等视口变化重测 */
  var raf = 0;

  /* 底部渐隐：仅「可滚且未到底」时启用（滚动条全站隐藏，否则看不出能滚） */
  function syncFade() {
    /* 空态：整块区域垂直居中，避免「文案贴着分隔线、下面空一大片」 */
    list.classList.toggle("is-empty", list.children.length === 1 && !!list.querySelector(".zp-empty--tight"));
    var canScroll = list.scrollHeight - list.clientHeight > 2;
    var atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 2;
    list.classList.toggle("can-scroll", canScroll && !atEnd);
  }
  list.addEventListener("scroll", syncFade, { passive: true });

  function measure() {
    root.classList.remove("is-overflow");
    void scroller.offsetHeight;   /* 先按「未降级」重新排版，再取真实高度 */
    var overflowed = scroller.scrollHeight - scroller.clientHeight > 2;
    var listTooShort = list.clientHeight > 0 && list.clientHeight < MIN_LIST_H;

    if (overflowed || listTooShort) {
      root.classList.add("is-overflow");
      lost = true;
    }
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
