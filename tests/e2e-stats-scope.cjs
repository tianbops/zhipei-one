/* 统计口径（重量 3 位 + 单/家/吨）：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30）：重量由 2 位小数改 3 位；首页「今日配送」「月度统计」与历史页
 * 「月份统计」统一成「X单 X家 Xt」三项。
 *
 * 为什么必须真浏览器：
 *   1. 单测只能证明「函数输出 3 位」，证明不了**真实数据流**（今日卡单量来自
 *      latest 的 dayCount、月度卡家数来自 history 的 storeCount）真的接上了；
 *   2. 「X单 X家 Xt」变长后最容易出的问题是**横向溢出**——月份条标题被挤、汇总行
 *      把右侧「峰值」顶掉。这类问题只有布局引擎能判，断言 scrollWidth 才行；
 *   3. 首页与历史页对同一批数据必须显示同一组数字，这是跨页一致性，只能在两页都真跑一遍。
 *
 * 用法：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-stats-scope.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8133);
const PORT_CDP = Number(process.env.PORT_CDP || 9314);
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

/* 一天一条线路 1 单，但每条数据都刻意给非整数重量（1.2345 类），
   好让「2 位 vs 3 位」在屏幕上真的显示不同。 */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ym = today.slice(0, 7);
const [yy, mm] = ym.split('-').map(Number);
const back = (n) => new Date(Date.UTC(yy, mm - 1 - n, 1)).toISOString().slice(0, 7);
const m1 = back(1), m2 = back(2);

const HISTORY = [
  { date: ym + '-01', count: 1, storeCount: 6, totalWeight: 150.125 },
  { date: ym + '-02', count: 1, storeCount: 5, totalWeight: 120.25 },
  { date: ym + '-03', count: 1, storeCount: 4, totalWeight: 90.375 },
  { date: m1 + '-15', count: 1, storeCount: 7, totalWeight: 210.5 },
  { date: m2 + '-08', count: 1, storeCount: 3, totalWeight: 60.0625 },
];
const MONTHS = [
  { month: ym, days: 3, waybills: 3, totalStores: 15, totalWeight: 360.75 },
  { month: m1, days: 1, waybills: 1, totalStores: 7, totalWeight: 210.5 },
  { month: m2, days: 1, waybills: 1, totalStores: 3, totalWeight: 60.0625 },
];

const WAYBILL = {
  id: 'w1', routeId: 'r1', routeName: '17号线', date: today,
  summary: { finalCount: 23, total: 23 },
  totalWeight: 1.5055,
  stores: Array.from({ length: 23 }, (_, i) => ({ name: '门店' + (i + 1) })),
};
const BOOTSTRAP = {
  success: true,
  dispatchRoute: { id: 'r1', name: '17号线', type: 'fixed' },
  user: { id: 9, username: 'driver', role: 'user', name: '司机', boundRouteId: 'r1' },
};

const STUB = `
try{var _m=JSON.parse(sessionStorage.getItem('__ME')||'null');window.__ME=_m}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200,headers:{get:()=>null,has:()=>false}};
   o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t,ok);return Promise.resolve(o)};
 if(s.indexOf('/api/me')===0)return window.__ME?B(JSON.stringify({success:true,user:window.__ME})):B('{"error":"unauthorized"}',false);
 if(s.indexOf('/api/home-bootstrap')===0)return B(${JSON.stringify(JSON.stringify(BOOTSTRAP))});
 if(s.indexOf('/api/waybills/latest')===0)return B(${JSON.stringify(JSON.stringify({ success: true, waybill: WAYBILL, dayCount: 1 }))});
 if(s.indexOf('/api/history')===0)return B(${JSON.stringify(JSON.stringify({ success: true, routeId: 'r1', range: { start: m2 + '-01', end: today }, history: HISTORY, months: MONTHS }))});
 if(s.indexOf('/api/')===0)return B('{"success":true,"waybills":[],"history":[],"days":[],"routes":[],"stats":{}}');
 return real(u,o)};})();`;

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
  const send = (m, p, s) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
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
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const ev = async (s) => {
    const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 140);
    return r.result.value;
  };
  const waitReady = async (ms = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await ev('document.readyState')) === 'complete') return true; } catch {}
      await sleep(150);
    }
    return false;
  };
  const txt = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.trim():null})()`);
  /* 横向溢出：元素内容比可视区宽 → 会被裁或顶掉邻居 */
  const overflow = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'no-el';return (e.scrollWidth>e.clientWidth+1)?(e.scrollWidth+' > '+e.clientWidth):'ok'})()`);

  /* ---------- 1. 首页 ---------- */
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(900);
  await ev('sessionStorage.clear();sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");');
  await C('Page.navigate', { url: BASE + '/home.html?fresh=1' });
  await waitReady();
  /* 等今日卡与月度卡真正落地（loadHome / trendCard 都是异步） */
  for (let i = 0; i < 40; i++) {
    const c = await txt('#todayCount');
    if (c && c !== '加载中…' && c !== '暂无运单') break;
    await sleep(250);
  }
  await sleep(700);

  check('首页今日卡：单量 1单', (await txt('#todayOrders')) === '1单', String(await txt('#todayOrders')));
  check('首页今日卡：家数 23家', (await txt('#todayCount')) === '23家', String(await txt('#todayCount')));
  check('首页今日卡：重量 1.506t（3 位，1.5055 四舍五入）',
    (await txt('#todayWeight')) === '1.506t', String(await txt('#todayWeight')));
  check('今日卡三项顺序是 单→家→吨',
    (await ev(`(()=>{const p=[...document.querySelectorAll('.today-summary > *')].filter(e=>e.textContent.trim()&&!e.hidden);
      return p.map(e=>e.textContent.trim()).join('|')})()`)) === '1单|23家|1.506t',
    String(await ev(`[...document.querySelectorAll('.today-summary > *')].map(e=>e.textContent.trim()).join('|')`)));
  check('今日卡不横向溢出', (await overflow('.today-summary')) === 'ok', String(await overflow('.today-summary')));

  check('月度统计：单量 3单', (await txt('#trendWaybills')) === '3', String(await txt('#trendWaybills')));
  check('月度统计：家数 15家', (await txt('#trendStores')) === '15', String(await txt('#trendStores')));
  const homeMonthWeight = await txt('#trendWeight');
  check('月度统计：重量 360.750t', homeMonthWeight === '360.750', String(homeMonthWeight));
  check('月度统计三项都可见',
    (await ev(`['#trendWaybills','#trendStores','#trendWeight'].every(s=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0})`)) === true);
  check('月度汇总行不横向溢出', (await overflow('.trend-bottom-row')) === 'ok', String(await overflow('.trend-bottom-row')));
  check('首页无整页横向滚动',
    (await ev('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1')) === true,
    String(await ev('document.documentElement.scrollWidth+" / "+document.documentElement.clientWidth')));

  /* ---------- 2. 历史页：同一批数据必须同一组数字 ---------- */
  await C('Page.navigate', { url: BASE + '/pages/history.html?fresh=1' });
  await waitReady();
  await sleep(1500);

  const monthSmall = (ymk) => ev(`(()=>{const s=document.querySelector('.history-month[data-month="${ymk}"] .history-month-main small');return s?s.textContent.trim():null})()`);
  check('历史月份条：3单 · 15家 · 360.750t',
    (await monthSmall(ym)) === '3单 · 15家 · 360.750t', String(await monthSmall(ym)));
  /* 跨页一致性：切页后首页的 DOM 已经没了，必须拿首页阶段读到的值来比。 */
  check('历史月份条与首页月度卡重量一致',
    String(await monthSmall(ym)).endsWith(homeMonthWeight + 't'),
    String(await monthSmall(ym)) + ' vs ' + homeMonthWeight);
  check('历史月份条不再显示「N天」', !/\d+天/.test(String(await monthSmall(ym))), String(await monthSmall(ym)));
  check('月份条不横向溢出', (await overflow('.history-month-main')) === 'ok', String(await overflow('.history-month-main')));
  check('月份标题没被挤到换行',
    (await ev(`(()=>{const s=document.querySelector('.history-month[data-month="${ym}"] .history-month-main span');return s.getBoundingClientRect().height<30})()`)) === true);
  check('历史页无整页横向滚动',
    (await ev('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1')) === true,
    String(await ev('document.documentElement.scrollWidth+" / "+document.documentElement.clientWidth')));

  /* ---------- 3. 日报行仍保留重量 3 位 ---------- */
  await ev(`document.querySelector('.history-month[data-month="${ym}"] .history-month-main').click()`);
  await sleep(400);
  const dayTexts = await ev(`[...document.querySelectorAll('.history-month[data-month="${ym}"] .history-date-main small')].map(s=>s.textContent.trim())`);
  check('日报行重量一律 3 位（3 行）',
    Array.isArray(dayTexts) && dayTexts.length === 3 && dayTexts.every((x) => /\d+\.\d{3}t$/.test(x)),
    JSON.stringify(dayTexts));
  check('日报行保留了具体重量值',
    Array.isArray(dayTexts) && dayTexts.some((x) => x.includes('150.125t')),
    JSON.stringify(dayTexts));

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n真浏览器统计口径验证：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
