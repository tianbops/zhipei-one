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
    tryRecord();
    try {
      nat.webReady();
    } catch (e) {
      /* 桥异常不能影响页面本身 */
    }
  }

  /* 启动时序遥测：此刻 ≈ 首帧已上屏，performance.now() 就是「导航开始 → 可见」。
   * 这个数才是用户实际等待；既有的 page-load（load 事件）早于它，单看 page-load
   * 会低估启动耗时，两者之差是「资源已齐、画面未上屏」的渲染尾巴。
   * 反过来也有用：某次启动只有 page-load 没有 boot-ready，说明双 rAF 没被调度
   * （页面隐藏/后台恢复等），那一次启动屏只能靠原生超时撤 —— 这个失败模式
   * 以前是完全静默的。
   * 上报必须 fire-and-forget：任何异常都不得影响握手本身。 */
  function tryRecord() {
    try {
      if (typeof window.zpPerfRecord !== "function") return;
      window.zpPerfRecord("boot-ready", 200, performance.now(), null);
    } catch (e) {
      /* 遥测失败不影响启动 */
    }
  }

  try {
    requestAnimationFrame(function () {
      requestAnimationFrame(fire);
    });
  } catch (e) {
    fire();
  }

})();
