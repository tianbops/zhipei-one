/* home/fit.js —— 首页空态对齐 + 键盘回退
   ------------------------------------------------------------
   列表高度已完全由 CSS 内容驱动（css/home-dashboard.css）：门店几家就铺几家，
   超出一屏由整页滚动承接，既不封顶也不在窗内滚动。因此本文件不再测量高度，
   也不再切换 can-scroll / has-content / is-overflow 等布局类，只剩两件事：

   1) 空态对齐：列表里只剩唯一的 .zp-empty--tight 时挂 .is-empty，让提示文案
      贴顶居中。高度由该元素的 min-height 在纯 CSS 里定死，加不加类都不改变
      卡片高度（所以不会出现「先回缩、再展开」的抖动）；
   2) 键盘冻结：可视区骤降 160px+ 时挂 .is-keyboard，版面回退整页滚动，
      避免卡片被压成一条。

   为什么仍需 MutationObserver：today.js 用 innerHTML 整体替换列表，而
   ResizeObserver 观察的 .zp-scroll 尺寸不随列表内容变化，必须直接监听列表
   子节点变化，.is-empty 才能即时切换（否则要等 600ms 定时器）。 */
(function () {
  var root = document.querySelector("main.home-app");
  if (!root) return;
  var list = document.getElementById("todayStoreList");
  if (!list) return;

  var raf = 0;

  function syncEmpty() {
    var isEmpty = list.children.length === 1 && !!list.querySelector(".zp-empty--tight");
    list.classList.toggle("is-empty", isEmpty);
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; syncEmpty(); });
  }

  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(list, { childList: true });
  }

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
  /* 数据到位后重放一次，覆盖慢网（列表被 innerHTML 替换的时机不固定） */
  setTimeout(schedule, 600);
  setTimeout(schedule, 2000);
})();
