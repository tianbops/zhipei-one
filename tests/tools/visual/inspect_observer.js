#!/usr/bin/env node
/**
 * inspect_observer.js —— 阶段 8 P3 MutationObserver 收敛验证（复用 4C/4D/4E/6 基建）
 *
 * 加载 observer_probe.html 夹具（含 ui-unified.js、可滚动 .data-store-list、不重定向），
 * 验证 js/ui-unified.js 内两处 MutationObserver 在「收敛改动」前后功能零回归：
 *
 *   第一处（initPasswordToggles，L61-71）：动态捕获动态插入的密码框并挂眼睛按钮(.zp-password-eye)
 *     - 收敛点：observe(document.body,{childList:true,subtree:true}) → {childList:true}
 *       （回调对新增节点递归查密码框，subtree 冗余；密码框或其容器是 body 直接子 addedNode 即可捕获）
 *     - 验证：注入「裸 <input type=password>」与「含 input 的容器」到 body 直接子 → .zp-password-eye 出现
 *
 *   第二处（setupGlobalScrollButtons，L357）：列表重渲染时重测滚动箭头(.zp-float-scroll)
 *     - 收敛点：new MutationObserver(update).observe(el===scrollingElement?document.body:el,...)
 *       → 保存引用 const mo=...; mo.observe(el,{childList:true,subtree:true})
 *       （消除「实例未保存无法 disconnect」代码异味；整页滚动时范围不变，列表容器滚动时本就小）
 *     - 验证：注入长列表 → 箭头出现且 observe 不崩；再注入项模拟重渲染 → 不崩
 *
 * 用法：node inspect_observer.js <fixture-url>
 *   输出 JSON 到 stdout；无依赖时退出码 2，功能不通过时退出码 1，通过时 0。
 *
 * 依赖：puppeteer-core 装在 /tmp/visualtools（不污染仓库）；系统 Chromium 在 /usr/bin/chromium。
 */
const puppeteer = require('/tmp/visualtools/node_modules/puppeteer-core');
const CHROMIUM = '/usr/bin/chromium';
const url = process.argv[2];
if (!url) { console.error('usage: node inspect_observer.js <fixture-url>'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    console.error('LAUNCH_FAIL: ' + (e && e.message ? e.message : String(e)));
    process.exit(2);
  }
  const result = { url };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
    // 过滤 mock 环境固有无害的资源 404（如浏览器默认请求的 /favicon.ico）；
    // 与 4E 处理 /api/me 404 同逻辑——仅保留真实 JS 错误。
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text()); });
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });

    // 初始状态（fixture 无密码框、列表空）
    const before = await page.evaluate(() => ({
      eye: document.querySelectorAll('.zp-password-eye').length,
      arrow: document.querySelectorAll('.zp-float-scroll').length,
      hasSetup: typeof window.zpSetupPasswordToggles,
    }));

    // 第一处：注入密码框到 body 直接子（裸 input + 含 input 的容器）
    await page.evaluate(() => {
      const i = document.createElement('input'); i.type = 'password'; i.value = 'x'; document.body.appendChild(i);
      const w = document.createElement('div'); const j = document.createElement('input');
      j.type = 'password'; j.value = 'y'; w.appendChild(j); document.body.appendChild(w);
    });
    await sleep(300);
    const eyeAfterInject = await page.evaluate(() => document.querySelectorAll('.zp-password-eye').length);

    // 第二处：注入长列表 → 触发 setupGlobalScrollButtons 挂载箭头 + observe
    await page.evaluate(() => {
      const list = document.getElementById('list');
      for (let k = 0; k < 60; k++) { const d = document.createElement('div'); d.style.height = '40px'; d.textContent = 'item ' + k; list.appendChild(d); }
    });
    await sleep(1500); // 等 window load 后的 setTimeout(120) + 轮询(400) + observe 稳定
    const arrowAfterList = await page.evaluate(() => document.querySelectorAll('.zp-float-scroll').length);

    // 第二处重渲染：再注入项，验证 observe 不崩
    await page.evaluate(() => {
      const list = document.getElementById('list');
      for (let k = 0; k < 40; k++) { const d = document.createElement('div'); d.style.height = '40px'; d.textContent = 'more ' + k; list.appendChild(d); }
    });
    await sleep(400);
    const arrowAfterMore = await page.evaluate(() => document.querySelectorAll('.zp-float-scroll').length);

    result.baseline = { eyeBefore: before.eye, arrowBefore: before.arrow, hasSetup: before.hasSetup };
    result.firstObserver = { injectedPasswordBoxes: 2, eyeAfterInject };
    result.secondObserver = { arrowAfterList, arrowAfterMore };
    result.errors = errors;

    // 第一处：observer 已挂载（hasSetup=function）且注入 2 个密码框后眼睛按钮数 = 注入数（零回归锚点）
    result.firstPass = before.hasSetup === 'function' && eyeAfterInject === before.eye + 2;
    // 第二处：箭头出现且重渲染后仍存在、全程无 JS 错误
    result.secondPass = arrowAfterList >= 1 && arrowAfterMore >= 1 && errors.length === 0;
    result.overall = result.firstPass && result.secondPass;
  } catch (e) {
    result.fatal = e && e.message ? e.message : String(e);
    result.overall = false;
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.overall ? 0 : 1);
})();
