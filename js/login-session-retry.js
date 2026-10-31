/**
 * 登录页自动会话探测的窄范围弱网保护。
 * 仅拦截同源 GET /api/me?autoMe=...；不影响手动登录 POST 或其他 fetch。
 * 只对网络错误、内部超时、408、429、5xx 做一次安全重试。
 */
(function () {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  var nativeFetch = window.fetch.bind(window);
  var TIMEOUT_MS = 5000;
  var RETRY_DELAY_MS = 400;

  function isProbe(input, init) {
    try {
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method !== "GET") return false;
      var raw = typeof input === "string" ? input : (input && input.url);
      if (!raw) return false;
      var u = new URL(raw, window.location.href);
      return u.origin === window.location.origin &&
        u.pathname === "/api/me" &&
        u.searchParams.has("autoMe");
    } catch (e) {
      return false;
    }
  }

  function retryableStatus(status) {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }

  function retryDelay(response) {
    try {
      var value = response && response.headers && response.headers.get("retry-after");
      if (value) {
        var seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, Math.min(1500, seconds * 1000));
      }
    } catch (e) {}
    return RETRY_DELAY_MS;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function probeFetch(input, init) {
    init = Object.assign({}, init || {});
    var callerSignal = init.signal || null;
    var retries = 1;
    try {
      var connection = navigator.connection;
      if (connection && connection.saveData) retries = 0;
      else if (connection && /^(slow-2g|2g)$/.test(String(connection.effectiveType || ""))) retries = 1;
    } catch (e) {}

    for (var attempt = 0; ; attempt++) {
      if (callerSignal && callerSignal.aborted) {
        var aborted = new Error("The operation was aborted.");
        aborted.name = "AbortError";
        throw aborted;
      }
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      var onCallerAbort = function () { controller.abort(); };
      if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      var request = Object.assign({}, init, { signal: controller.signal });
      var response = null;
      var failure = null;
      try {
        response = await nativeFetch(input, request);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      }

      if (callerSignal && callerSignal.aborted) {
        var callerAbort = new Error("The operation was aborted.");
        callerAbort.name = "AbortError";
        throw callerAbort;
      }
      var shouldRetry = !response || retryableStatus(response.status);
      if (!shouldRetry || attempt >= retries || navigator.onLine === false) {
        if (failure) throw failure;
        return response;
      }
      await sleep(response ? retryDelay(response) : RETRY_DELAY_MS);
    }
  }

  window.fetch = function (input, init) {
    if (!isProbe(input, init)) return nativeFetch(input, init);
    return probeFetch(input, init);
  };
})();
