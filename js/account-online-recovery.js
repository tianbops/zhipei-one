/* 设置页弱网恢复：只恢复 /api/me 只读资料，不触碰/重放任何设置变更。 */
(() => {
  const $ = (id) => document.getElementById(id);
  let recovering = false, lastAttemptAt = 0;

  function profileReadFailed() {
    const username = $("username")?.textContent || "";
    const message = $("message")?.textContent || "";
    if (username !== "读取中…" || !message) return false;
    const match = message.match(/\[(?:HTTP_)?(\d{3})\]/);
    if (!match) return true; // 网络错误/超时
    const status = Number(match[1]);
    return status === 408 || status === 429 || status >= 500;
  }

  async function recover() {
    if (navigator.onLine === false || document.hidden || recovering || Date.now() - lastAttemptAt < 5000 || !profileReadFailed()) return;
    const previousMessage = $("message")?.textContent || "";
    recovering = true;
    lastAttemptAt = Date.now();
    try {
      if (typeof window.load === "function") await window.load(); // load() 只 GET /api/me
      if ($("username")?.textContent !== "读取中…" && $("message")?.textContent === previousMessage) {
        $("message").textContent = "";
      }
    } catch {
      // 保留页面与编辑表单内容；不重放任何 POST。
    } finally {
      recovering = false;
    }
  }

  window.addEventListener("online", recover);
  window.addEventListener("focus", recover);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recover(); });
})();
