/* 智配One · 启动屏握手（webReady）
 * ------------------------------------------------------------------
 * 背景：安卓壳的启动屏由 MainActivity 的 setKeepOnScreenCondition 保持，条件是
 * 「网页首帧就绪」（ZhipeiNative.webReady() 被调用过）。本文件就是这个握手点的
 * 发送方。
 *
 * 为什么不能更早发：
 *   - 脚本一执行就发 → 页面还是白底，启动屏撤早了，等于回到「splash 已退、内容
 *     没来」的空窗；
 *   - DOMContentLoaded 就发 → 样式表可能还没应用，首帧是裸 HTML，会闪一下。
 *   唯一可靠的做法是等「下一帧已经画出去」：连续两次 requestAnimationFrame。
 *   第一次回调在本帧渲染前，第二次回调时上一帧已经上屏，此时页面上的骨架/登录卡
 *   用户已可见，撤下启动屏就是无缝衔接。
 *
 * 只在原生壳里生效：PWA/浏览器没有 ZhipeiNative，直接退出，零开销。
 * 每个页面都引入：启动页可能是登录页、也可能是首页（已登录直进），两者都要握手。
 */
(function () {
  "use strict";
  var nat = window.ZhipeiNative;
  if (!nat || typeof nat.webReady !== "function") return;

  var sent = false;
  function fire() {
    if (sent) return;
    sent = true;
    try {
      nat.webReady();
    } catch (e) {
      /* 桥异常不能影响页面本身 */
    }
  }

  try {
    requestAnimationFrame(function () {
      requestAnimationFrame(fire);
    });
  } catch (e) {
    fire();
  }

  /* 兜底：rAF 在个别内核/后台态可能被节流，页面已经可见却迟迟不撤启动屏是最糟的。
     原生侧还有 6s 硬超时，这里取更早的 1.2s，保证正常页面优先由页面状态决定。 */
  setTimeout(fire, 1200);
})();
