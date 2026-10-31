/* 线路申请页弱网恢复：只重试失败的只读加载，不重放提交/解绑操作。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const route = $("route"), duty = $("duty");
  const nameEl = $("applicantName"), phoneEl = $("applicantPhone");
  const requests = $("requests");
  let recovering = false, lastAttemptAt = 0;
  let routeDirty = false, dutyDirty = false, nameDirty = false, phoneDirty = false;
  let routeDraft = route?.value || "", dutyDraft = duty?.value || "driver";
  let nameDraft = nameEl?.value || "", phoneDraft = phoneEl?.value || "";

  route?.addEventListener("change", () => { routeDirty = true; routeDraft = route.value; });
  duty?.addEventListener("change", () => { dutyDirty = true; dutyDraft = duty.value; });
  nameEl?.addEventListener("input", () => { nameDirty = true; nameDraft = nameEl.value; });
  phoneEl?.addEventListener("input", () => { phoneDirty = true; phoneDraft = phoneEl.value; });

  function retryableReadError(text) {
    const match = String(text || "").match(/\[(?:HTTP_)?(\d{3})\]/);
    if (!match) return true; // 网络断开/超时等无 HTTP 状态的失败
    const status = Number(match[1]);
    return status === 408 || status === 429 || status >= 500;
  }

  function hasFailedRead() {
    const routeFailed = !!route && [...route.options].some(option => /线路加载失败/.test(option.textContent || ""));
    const requestText = requests?.textContent || "";
    const requestFailed = /^(申请记录加载失败|线路加载失败)：/.test(requestText);
    return (routeFailed || requestFailed) && retryableReadError(requestText);
  }

  async function recover() {
    if (navigator.onLine === false || document.hidden || recovering || Date.now() - lastAttemptAt < 5000 || !hasFailedRead()) return;
    const routeBefore = route?.value || "";
    const dutyBefore = duty?.value || "driver";
    const nameBefore = nameEl?.value || "";
    const phoneBefore = phoneEl?.value || "";
    recovering = true;
    lastAttemptAt = Date.now();
    try {
      if (typeof window.load === "function") await window.load();
      if (routeDirty && route && [...route.options].some(option => option.value === routeDraft)) route.value = routeDraft;
      else if (routeBefore && route && [...route.options].some(option => option.value === routeBefore)) route.value = routeBefore;
      if (duty) duty.value = dutyDirty ? dutyDraft : dutyBefore;
      if (nameEl && nameDirty) nameEl.value = nameDraft;
      else if (nameEl && nameBefore) nameEl.value = nameBefore;
      if (phoneEl && phoneDirty) phoneEl.value = phoneDraft;
      else if (phoneEl && phoneBefore) phoneEl.value = phoneBefore;
      nameEl?.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      // 只读恢复失败时保留当前页面与用户输入，等待下一次在线/前台事件。
    } finally {
      recovering = false;
    }
  }

  window.addEventListener("online", recover);
  window.addEventListener("focus", recover);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) recover(); });
})();
