/* 智配One · admin 运行时职责边界实证（阶段 8 · P3「admin 内联 script 与 ui-unified.js 职责重叠」审查）
 *
 * 背景：admin.html 内联 <script>（约 375–601 行）在 ui-unified.js（601 行）之前同步执行，
 * 其首屏 load() 在 ui-unified.js 加载前就要用 esc()/toast()。本脚本实证：
 *   ① 这种「内联先于全局层」顺序下，首屏不抛 pageerror（内联 esc/toast 自洽可用）；
 *   ② ui-unified.js 加载后，全局反馈层符号全部就绪；
 *   ③ admin 已通过 zpBackHooks 注册管理端返回层级（length>0）。
 * 从而坐实「职责边界已正确建立、重叠点受时序约束保护、不宜动」的结论。
 *
 * 使用：node inspect_admin_js.js <url> [shot.png]
 * 依赖：系统 Chromium + /tmp/visualtools/node_modules/puppeteer-core（与 4C/4D 同）
 */
const puppeteer = require('/tmp/visualtools/node_modules/puppeteer-core');

const CHROME = '/usr/bin/chromium';
const GLOBAL_KEYS = ['zpConfirm', 'zpSetupPasswordToggles', 'zpToast', 'zpHandleBack', 'zpResolveBack', 'zpBackHooks'];

(async () => {
  const url = process.argv[2];
  const shot = process.argv[3];
  if (!url) {
    console.error('用法: node inspect_admin_js.js <url> [shot.png]');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // 吞掉未认证时的 location.replace 重定向，避免页面离开 admin 导致无法检查全局符号。
  // 仅测试桩：真实重定向逻辑不被修改，只是本会话里不真正跳转。
  await page.evaluateOnNewDocument(() => {
    try {
      window.location.replace = function (u) { window.__suppressedReplace = u; };
    } catch (e) { /* ignore */ }
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return; // mock 环境固有（未托管 /api/me 等），非代码缺陷
    errors.push('console.error: ' + t);
  });

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });

  // ui-unified.js 是 body 末尾同步 script，networkidle0 后必然已执行完。
  const globals = await page.evaluate(() => ({
    zpConfirm: typeof window.zpConfirm,
    zpSetupPasswordToggles: typeof window.zpSetupPasswordToggles,
    zpToast: typeof window.zpToast,
    zpHandleBack: typeof window.zpHandleBack,
    zpResolveBack: typeof window.zpResolveBack,
    zpBackHooks: Array.isArray(window.zpBackHooks) ? window.zpBackHooks.length : 'not-array',
  }));

  // 内联工具泄漏检测：用 own property descriptor 区分
  // 「函数声明泄漏到 window」(own property, value=function, 标 LEAKED) 与
  // 「HTML id 的 named-access」(无 own descriptor，返回 DOM 元素，非泄漏)。
  const inlineLeak = await page.evaluate(() => {
    // LEAKED = 内联函数声明把同名全局覆盖了（own property 且为自定义 function）；
    // native  = window.open/close 等浏览器原生，未被覆盖（IIFE 修复后应为 native）；
    // named-or-none = 无 own descriptor（HTML id named-access 或已被 IIFE 隔离）。
    const names = ['esc', 'toast', 'api', 'load', 'open', 'close'];
    const out = {};
    for (const n of names) {
      const d = Object.getOwnPropertyDescriptor(window, n);
      if (!d) { out[n] = 'named-or-none'; continue; }
      if (typeof d.value === 'function') {
        out[n] = String(d.value).indexOf('[native code]') >= 0 ? 'native' : 'LEAKED';
      } else {
        out[n] = 'own:' + typeof d.value;
      }
    }
    return out;
  });

  let shotPath = null;
  if (shot) { await page.screenshot({ path: shot }); shotPath = shot; }
  await browser.close();

  const result = {
    pageErrors: errors,
    noPageError: errors.length === 0,
    globals,
    globalLayerReady:
      globals.zpConfirm === 'function' &&
      globals.zpSetupPasswordToggles === 'function' &&
      globals.zpToast === 'function' &&
      globals.zpHandleBack === 'function' &&
      globals.zpResolveBack === 'function' &&
      typeof globals.zpBackHooks === 'number' && globals.zpBackHooks > 0,
    inlineToolsArePrivate: !Object.values(inlineLeak).includes('LEAKED'),
    inlineLeak,
    shot: shotPath,
  };
  result.overall = result.noPageError && result.globalLayerReady && result.inlineToolsArePrivate;

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.overall ? 0 : 1);
})().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
