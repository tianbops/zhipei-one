#!/usr/bin/env node
/**
 * inspect_perf.js —— 阶段 11 性能轻量化：基于 CDP 的性能指标测量基线
 *
 * 对给定页面列表，用 puppeteer-core + Chrome DevTools Protocol 采集（JS 启用、真实数据渲染）：
 *   - fcp / lcp          ：首屏内容/最大内容绘制（ms，相对导航起点）
 *   - nodes              ：DOM 规模
 *   - layoutDuration     ：首屏渲染累计布局耗时（ms）
 *   - recalcStyleDuration：首屏渲染累计样式重算耗时（ms）
 *   - scriptDuration     ：首屏脚本耗时（ms）
 *   - taskDuration       ：首屏主线程任务耗时（ms）
 *   - scroll*            ：对页面强制滚动到底的压测增量（布局/样式/任务耗时）
 *
 * 设计要点：阶段 6 视觉门用 setJavaScriptEnabled(false) 只看静态壳；性能测量必须 JS 启用，
 * 数据驱动内容（列表/卡片）才会真实渲染，性能数字才有意义。所有数字来自 CDP Performance.getMetrics，
 * 可跨提交复现，作为优化前后「是否真的更快」的判据（绝不凭感觉宣称轻量化）。
 *
 * 用法：node inspect_perf.js <url1> [url2 ...] [--scroll] [--shots <dir>]
 *   输出 JSON 数组到 stdout（每行一个结果）。
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('/tmp/visualtools/node_modules/puppeteer-core');

const CHROMIUM = '/usr/bin/chromium';
const args = process.argv.slice(2);
let shotsDir = null, doScroll = false;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') { shotsDir = args[++i]; }
  else if (args[i] === '--scroll') { doScroll = true; }
  else { urls.push(args[i]); }
}
if (!urls.length) { console.error('usage: node inspect_perf.js <url1> [url2 ...] [--scroll] [--shots <dir>]'); process.exit(2); }

function pick(metrics, name) {
  const m = metrics.find((x) => x.name === name);
  return m ? Math.round(m.value * 1000) / 1000 : null; // 秒→ms，保留 3 位
}

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
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    let navOk = true;
    let r = { url, navOk: false };
    try {
      const client = await page.target().createCDPSession();
      await client.send('Performance.enable', { timeDomain: 'timeTicks' });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      // 等首屏稳定（mock API 渲染 + 动画入场结束）
      await new Promise((res) => setTimeout(res, 900));

      const m1 = await client.send('Performance.getMetrics');
      const fcp = pick(m1.metrics, 'FirstContentfulPaint');
      const lcp = pick(m1.metrics, 'LargestContentfulPaint');
      const nodes = pick(m1.metrics, 'Nodes');
      const layoutDuration = pick(m1.metrics, 'LayoutDuration');
      const recalcStyleDuration = pick(m1.metrics, 'RecalcStyleDuration');
      const scriptDuration = pick(m1.metrics, 'ScriptDuration');
      const taskDuration = pick(m1.metrics, 'TaskDuration');

      r.navOk = true;
      r.fcp = fcp; r.lcp = lcp; r.nodes = nodes;
      r.layoutDuration = layoutDuration; r.recalcStyleDuration = recalcStyleDuration;
      r.scriptDuration = scriptDuration; r.taskDuration = taskDuration;

      if (doScroll) {
        // 滚动压测：分步滚到底，采集滚动期间布局/样式/任务增量
        const before = await client.send('Performance.getMetrics');
        const h = await page.evaluate(() => {
          const el = document.scrollingElement || document.documentElement;
          const max = el.scrollHeight - el.clientHeight;
          const step = 200;
          let y = 0;
          const tick = () => new Promise((res) => requestAnimationFrame(() => res()));
          return (async () => {
            while (y < max) { y = Math.min(max, y + step); el.scrollTop = y; await tick(); }
            el.scrollTop = 0; await tick();
            return max;
          })();
        });
        const after = await client.send('Performance.getMetrics');
        const dLayout = (pick(after.metrics, 'LayoutDuration') ?? 0) - (pick(before.metrics, 'LayoutDuration') ?? 0);
        const dRecalc = (pick(after.metrics, 'RecalcStyleDuration') ?? 0) - (pick(before.metrics, 'RecalcStyleDuration') ?? 0);
        const dTask = (pick(after.metrics, 'TaskDuration') ?? 0) - (pick(before.metrics, 'TaskDuration') ?? 0);
        r.scrollLayoutDuration = Math.round(dLayout * 1000) / 1000;
        r.scrollRecalcStyleDuration = Math.round(dRecalc * 1000) / 1000;
        r.scrollTaskDuration = Math.round(dTask * 1000) / 1000;
        r.scrollableHeight = Math.round(h);
      }
    } catch (e) {
      navOk = false;
      r.navOk = false;
      r.error = e && e.message ? e.message : String(e);
    }
    if (shotsDir) {
      try {
        const name = path.basename(new URL(url).pathname) || 'page';
        await page.screenshot({ path: path.join(shotsDir, 'perf_' + name + '.png') });
      } catch (_) {}
    }
    results.push(r);
    await page.close();
  }
  await browser.close();
  for (const r of results) console.log(JSON.stringify(r));
})().catch((e) => { console.error('FATAL: ' + (e && e.message ? e.message : String(e))); process.exit(2); });
