/* 全局错误守卫 —— 落实「不静默失败」原则
 *
 * 背景：审核报告 P0-4 指出前端缺少全局错误捕获，未处理的 Promise 拒绝会导致
 * 白屏/卡死且无任何提示。本模块为全站兜底，职责单一、无依赖、可在任意页面独立加载。
 *
 * 不做的事：
 * - 不吞掉错误（捕获后仍原样 console 输出，不 preventDefault）
 * - 不修改业务逻辑、不劫持 fetch
 * - 上报失败不影响页面（全部 try/catch 包裹）
 */
(function () {
  "use strict";

  var RING_KEY = "zp:client-errors";
  var RING_MAX = 20;              // 环形缓冲上限，避免 localStorage 膨胀
  var TOAST_MIN_INTERVAL = 3000;  // toast 节流窗口
  var TOAST_MAX_PER_PAGE = 3;     // 单页最多提示次数，避免刷屏

  var toastCount = 0;
  var lastToastAt = 0;
  var seen = Object.create(null); // 同页内相同指纹只计一次明细
  var seenOrder = [];

  function now() {
    return Date.now();
  }

  function traceId() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().slice(0, 8);
    } catch (e) { /* 忽略：非安全上下文可能不可用 */ }
    return Math.random().toString(36).slice(2, 10);
  }

  function safeString(value) {
    try {
      if (value == null) return "";
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.message || value.name;
      return String(value);
    } catch (e) {
      return "[unstringifiable]";
    }
  }

  function pageName() {
    var p = location.pathname || "/";
    if (p === "/" || p === "/index.html") return "index";
    return p.replace(/^\//, "").replace(/\.html$/, "").replace(/\//g, "_").slice(0, 40);
  }

  /* 环形缓冲：只保留最近 RING_MAX 条，写失败（隐私模式/配额满）静默降级 */
  function push(entry) {
    try {
      var raw = localStorage.getItem(RING_KEY);
      var list = [];
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Object.prototype.toString.call(parsed) === "[object Array]") list = parsed;
      }
      list.push(entry);
      if (list.length > RING_MAX) list = list.slice(list.length - RING_MAX);
      localStorage.setItem(RING_KEY, JSON.stringify(list));
    } catch (e) { /* 配额/隐私模式：忽略 */ }
  }

  function toast(message) {
    if (toastCount >= TOAST_MAX_PER_PAGE) return;
    var t = now();
    if (t - lastToastAt < TOAST_MIN_INTERVAL) return;
    lastToastAt = t;
    toastCount += 1;
    try {
      if (typeof window.zpToast === "function") window.zpToast(message, "error");
    } catch (e) { /* toast 组件未加载或抛错：忽略 */ }
  }

  /* 去重：同一消息+来源在单页内只记录一次明细，仅累加计数 */
  function shouldRecordDetail(fingerprint) {
    if (seen[fingerprint]) {
      seen[fingerprint] += 1;
      return false;
    }
    seen[fingerprint] = 1;
    seenOrder.push(fingerprint);
    if (seenOrder.length > 200) {
      var drop = seenOrder.shift();
      delete seen[drop];
    }
    return true;
  }

  function record(kind, message, extra) {
    var fingerprint = kind + "|" + message.slice(0, 120);
    var isNew = shouldRecordDetail(fingerprint);
    if (!isNew) return;

    var entry = {
      id: traceId(),
      t: new Date().toISOString(),
      kind: kind,
      page: pageName(),
      message: message.slice(0, 300),
      ua: navigator.userAgent ? navigator.userAgent.slice(0, 120) : ""
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) entry[k] = extra[k];
      }
    }

    // 结构化日志，便于后续接入日志聚合（P2 可观测性复用）
    try {
      console.error("[zp-error]", JSON.stringify(entry));
    } catch (e) {
      console.error("[zp-error]", entry);
    }

    push(entry);

    // 用户可见：脚本异常提示「页面出现异常」，资源加载失败不打扰用户
    if (kind === "error" || kind === "unhandledrejection") {
      toast("页面出现异常，已记录，可继续使用");
    }
  }

  /* 1) 同步运行时错误 */
  window.addEventListener("error", function (event) {
    try {
      var target = event.target;
      // 资源加载失败（img/script/link）：event 上没有 message，target 是元素
      if (target && target !== window && target.tagName) {
        var src = target.src || target.href || "";
        record("resource", "资源加载失败: " + (target.tagName || "?").toLowerCase() + " " + src, { src: src.slice(0, 200) });
        return;
      }
      var msg = safeString(event.message) || "未知错误";
      var loc = event.filename ? event.filename + ":" + event.lineno + ":" + event.colno : "";
      record("error", msg, { at: loc, stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 300) : "" });
    } catch (e) { /* 守卫自身绝不能抛错 */ }
  }, true); // 捕获阶段：才能收到资源加载错误

  /* 2) 未处理的 Promise 拒绝 —— 最容易导致白屏且最常被忽略 */
  window.addEventListener("unhandledrejection", function (event) {
    try {
      var reason = event.reason;
      var msg;
      if (reason && reason.message) msg = safeString(reason.message);
      else if (typeof reason === "object" && reason !== null) {
        try { msg = JSON.stringify(reason).slice(0, 300); } catch (e) { msg = safeString(reason); }
      } else msg = safeString(reason);
      record("unhandledrejection", msg || "未处理的 Promise 拒绝", {
        stack: reason && reason.stack ? String(reason.stack).slice(0, 300) : ""
      });
    } catch (e) { /* 忽略 */ }
  });

  /* 供调试/后续上报使用 */
  window.zpErrors = {
    list: function () {
      try {
        var raw = localStorage.getItem(RING_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    },
    clear: function () {
      try { localStorage.removeItem(RING_KEY); } catch (e) { /* 忽略 */ }
    }
  };
})();
