/* 智配One 统一分享适配器：Android App 优先使用原生系统 Sharesheet，浏览器保持原有分享行为。 */
(() => {
  'use strict';

  const native = window.ZhipeiNative;
  if (!native || typeof native.shareText !== 'function') return;

  // 保留浏览器原生分享作为原生桥异常时的兜底。
  const browserShare = typeof navigator.share === 'function'
    ? navigator.share.bind(navigator)
    : null;

  const share = async ({ title = '智配One', text = '' } = {}) => {
    const body = String(text || '').trim();
    const subject = String(title || '智配One').trim() || '智配One';
    if (!body) return;
    try {
      // Java 桥方法会在 UI 线程调起 Android ACTION_SEND 系统分享面板。
      native.shareText(subject, body);
    } catch (error) {
      if (browserShare) return browserShare({ title: subject, text: body });
      throw error;
    }
  };

  // 兼容当前各页面既有 navigator.share 调用点，避免重复实现分享内容逻辑。
  try {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share
    });
  } catch (_) {
    try { navigator.share = share; } catch (_) {}
  }
})();
