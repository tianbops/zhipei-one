/* 启动屏握手：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30，v1.0.22）：安卓壳的启动屏改为「等网页首帧就绪才退出」，
 * 握手点是网页侧 js/boot-ready.js → ZhipeiNative.webReady()。
 *
 * 为什么必须真浏览器：
 *   1. 握手的全部价值在于「时机」——早一帧就是空窗、晚太多就是白等 logo。
 *      这个时机只有真实渲染管线（rAF 两跳）能证明，vm 里模拟的 rAF 只能证明调用次数；
 *   2. 必须验证握手发生时**屏上确实有东西**（今日卡已布局、门店列表非零高），
 *      而不是拿 readyState 猜；
 *   3. 网页/浏览器环境（无 ZhipeiNative）下脚本必须彻底静默，不能抛错影响页面。
 *
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-boot-ready.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8141);
const PORT_CDP = Number(process.env.PORT_CDP || 9320);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });

/* 首页所需的接口桩：只要能让骨架→内容跑完即可 */
const STUB_API = `
try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t)=>{const o={ok:true,status:200,headers:{get:()=>null,has:()=>false}};
   o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t);return Promise.resolve(o)};
 if(s.indexOf('/api/')===0)return B('{"success":true,"waybills":[],"history":[],"months":[],"days":[],"routes":[],"stats":{}}');
 return real(u,o)};})();`;

/* 握手桩：记录「握手那一刻屏上是什么样」，而不是只数调用次数 */
const BRIDGE = `
window.__ready = null;
window.ZhipeiNative = {
  webReady: function () {
    if (window.__ready) { window.__ready.count++; return; }
    var nav = -1;
    try { nav = performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd || -1; } catch (e) {}
    var card = document.querySelector('.today-card') || document.querySelector('main section');
    var list = document.querySelector('#todayStoreList') || document.querySelector('.today-store-list');
    var bars = document.querySelectorAll('#todayStoreList .skel-bar');
    window.__ready = {
      count: 1,
      at: performance.now(),
      domReady: nav,
      readyState: document.readyState,
      cardH: card ? Math.round(card.getBoundingClientRect().height) : -1,
      listH: list ? Math.round(list.getBoundingClientRect().height) : -1,
      barCount: bars.length,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 40)
    };
  }
};`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const base = path.join(ROOT, p);
    const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => {
      try { return fs.statSync(c).isFile(); } catch { return false; }
    });
    if (!hit) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  });
  await new Promise((r) => srv.listen(PORT, r));

  const proc = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT_CDP, 'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2600);

  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) { console.error('无法启动 Chromium（检查 CHROMIUM 路径）'); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const exceptions = [];
  const send = (m, p, s) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(String(m.params.exceptionDetails.text || '').slice(0, 120));
    }
    if (m.id && pend.has(m.id)) {
      const q = pend.get(m.id); pend.delete(m.id);
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId;
  const C = (m, p) => send(m, p, sid);
  await C('Page.enable');
  await C('Runtime.enable');
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  /* 每个阶段用独立 target：addScriptToEvaluateOnNewDocument 是按 target 累积的，
     同一 target 复用会让上一阶段的桥桩/接口桩残留，把断言测成假绿或假红。 */
  let cur = null;
  const newPage = async (scripts) => {
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const s = a.sessionId;
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, s);
    for (const src of scripts) await send('Page.addScriptToEvaluateOnNewDocument', { source: src }, s);
    cur = (m, p) => send(m, p, s);
    return cur;
  };
  const ev = async (s) => {
    const r = await cur('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      return 'ERR ' + String(d || r.exceptionDetails.text).split('\n')[0].slice(0, 140);
    }
    return r.result.value;
  };
  const waitExpr = async (expr, ms = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr)) return true; } catch {}
      await sleep(80);
    }
    return false;
  };
  const go = async (url) => {
    await cur('Page.navigate', { url });
  };

  try {
    /* ---------- 阶段 A：原生壳环境——握手发生，且发生在首屏已布局之后 ---------- */
    console.log('\n[阶段A] 原生壳环境：握手时机 = 首屏已绘制');
    exceptions.length = 0;
    await newPage([STUB_API, BRIDGE]);
    await go(BASE + '/home.html');
    const got = await waitExpr('window.__ready !== null', 9000);
    check('握手已发生', got === true);
    const r = (await ev('window.__ready')) || {};

    check('握手发生在 DOM 解析完成之后（readyState 非 loading）',
      r.readyState === 'interactive' || r.readyState === 'complete', String(r.readyState));
    check('握手晚于 DOMContentLoaded', Number(r.at) > Number(r.domReady) && Number(r.domReady) >= 0,
      `at=${Math.round(r.at)} domReady=${Math.round(r.domReady)}`);
    check('握手时今日卡已布局（高度 > 40px）', Number(r.cardH) > 40, `cardH=${r.cardH}`);
    check('握手时门店列表已占位（高度 > 40px）', Number(r.listH) > 40, `listH=${r.listH}`);
    check('握手时屏上已有可读内容（不是空白页）', String(r.text || '').length > 8, JSON.stringify(r.text));
    // 等页面稳定后确认没有重复握手
    await waitExpr('document.readyState === "complete"', 5000);
    await sleep(1500); // 越过 1.2s 兜底定时器
    const cnt = await ev('window.__ready ? window.__ready.count : -1');
    check('兜底定时器触发后仍未重复握手（count 恒为 1）', cnt === 1, 'count=' + String(cnt));
    check('页面无未捕获异常', exceptions.length === 0, exceptions.join(' | '));

    /* ---------- 阶段 B：浏览器/PWA 环境（无桥）——脚本必须彻底静默 ---------- */
    console.log('\n[阶段B] 无 ZhipeiNative：脚本静默退出，不影响页面');
    exceptions.length = 0;
    await newPage([STUB_API]);
    await go(BASE + '/home.html');
    await waitExpr('document.readyState === "complete"', 9000);
    await sleep(300);
    check('无桥时不产生 __ready（脚本提前 return）', (await ev('typeof window.__ready')) === 'undefined');
    check('无桥时页面正常渲染（今日卡有内容）',
      (await ev("!!document.querySelector('#todayCount')")) === true);
    check('无桥时无未捕获异常', exceptions.length === 0, exceptions.join(' | '));

    /* ---------- 阶段 C：登录页也要握手（未登录冷启动走的是登录页） ---------- */
    console.log('\n[阶段C] 登录页：启动屏同样需要握手');
    exceptions.length = 0;
    await newPage([BRIDGE]);
    await go(BASE + '/index.html');
    const gotLogin = await waitExpr('window.__ready !== null', 9000);
    check('登录页握手已发生', gotLogin === true);
    const lr = (await ev('window.__ready')) || {};
    check('登录页握手时表单已布局（body 文本非空）', String(lr.text || '').length > 4, JSON.stringify(lr.text));
    check('登录页握手一次', Number(lr.count) === 1, String(lr.count));
  } catch (e) {
    console.error('运行异常：', e && e.message);
    results.push({ name: '运行未抛异常', ok: false });
  }

  const bad = results.filter((x) => !x.ok);
  console.log(`\n=== ${results.length - bad.length}/${results.length} 通过 ===`);
  proc.kill('SIGKILL');
  srv.close();
  process.exit(bad.length ? 1 : 0);
})();
