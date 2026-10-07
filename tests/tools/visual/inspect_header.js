#!/usr/bin/env node
/**
 * inspect_header.js —— 阶段 6 Header 统一视觉验证（复用 4C/4D/4E 基建）
 *
 * 对给定页面列表，用 puppeteer-core（系统 Chromium）做几何体检：
 *   - headerHeight : <header> 渲染高度（普通 54 / order 矮屏 48）
 *   - backSize     : 返回元素（<a href=/home.html> 或 <button#backBtn>）命中靶区边长
 *   - titlePresent : 头部是否存在标题（strong/h1/.order-title 或文本）
 *   - overflowX    : 横向溢出像素（须 0）
 *   - topbarHook   : .topbar 钩子数量（改后应 >=1）
 *   - appBackHook  : .app-back 钩子数量（link-back 页改后应 >=1；order 页为 0）
 *
 * 用法：node inspect_header.js <url1> [url2 ...] [--shots <dir>]
 *   输出 JSON 数组到 stdout（每行一个结果），并可选截图到 <dir>/<basename>.png。
 *
 * 依赖：puppeteer-core 装在 /tmp/visualtools（不污染仓库）；系统 Chromium 在 /usr/bin/chromium。
 * 无依赖时以退出码 2 显式报错，不假装成功。
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('/tmp/visualtools/node_modules/puppeteer-core');

const CHROMIUM = '/usr/bin/chromium';
const args = process.argv.slice(2);
let shotsDir = null;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') { shotsDir = args[++i]; }
  else { urls.push(args[i]); }
}
if (!urls.length) { console.error('usage: node inspect_header.js <url1> [url2 ...] [--shots <dir>]'); process.exit(2); }

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

  const results = [];
  for (const url of urls) {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false); // 静态 shell 几何体检，避免登录重定向干扰（与 4D 同思路）
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    let navOk = true;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      navOk = false;
    }
    const r = await page.evaluate(() => {
      const header = document.querySelector('header');
      const topbarHook = document.querySelectorAll('.topbar').length;
      const appBackHook = document.querySelectorAll('.app-back').length;
      let headerHeight = null, titlePresent = false, backSize = null, overflowX = 0;
      if (header) {
        const hr = header.getBoundingClientRect();
        headerHeight = Math.round(hr.height);
        const titleEl = header.querySelector('strong,h1,.order-title');
        titlePresent = !!(titleEl || (header.textContent || '').trim().length > 0);
        const backEl = header.querySelector('a[href="/home.html"],a[aria-label*="返回"],button#backBtn');
        if (backEl) {
          const br = backEl.getBoundingClientRect();
          backSize = Math.round(Math.min(br.width, br.height));
        }
      }
      const de = document.documentElement;
      overflowX = Math.max(0, de.scrollWidth - de.clientWidth);
      return { headerHeight, titlePresent, backSize, overflowX, topbarHook, appBackHook };
    });
    r.url = url;
    r.navOk = navOk;
    if (shotsDir) {
      try {
        const name = path.basename(new URL(url).pathname) || 'page';
        await page.screenshot({ path: path.join(shotsDir, 'header_' + name + '.png') });
      } catch (_) {}
    }
    results.push(r);
    await page.close();
  }
  await browser.close();
  for (const r of results) console.log(JSON.stringify(r));
})().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : String(e))); process.exit(2); });
