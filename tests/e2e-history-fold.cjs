/* 历史运单页月份折叠：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30）：月份分组由「当月默认展开」改为「默认全部收起」。
 *
 * 为什么还要 e2e：单测（tests/history-month-fold.test.mjs）用的是手写 DOM 桩，
 * 只能证明 JS 逻辑；证明不了三件真 DOM 才有的事——
 *   1. `.history-month-body{display:none}` 到底有没有把日期行藏起来（class 对了但 CSS 没中一样白改）；
 *   2. 真实页面加载顺序下 expandedMonths 与 core.js 的绑定关系；
 *   3. 真实 load() 重绘后展开状态是否还在（用户删一条记录，列表不该整个塌下去）。
 * 上一轮触感的教训就是「夹具照想象搭」，这里直接加载 pages/history.html。
 *
 * 用法：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-history-fold.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8132);
const PORT_CDP = Number(process.env.PORT_CDP || 9313);
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

/* 三个月的假历史：当月 3 天 + 前两个月各 1 天。 */
function fakeHistory() {
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const ym = now.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const back = (n) => new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
  const m1 = back(1), m2 = back(2);
  const history = [
    { date: ym + '-01', count: 1, storeCount: 4, totalWeight: 90 },
    { date: ym + '-02', count: 1, storeCount: 5, totalWeight: 120 },
    { date: ym + '-03', count: 2, storeCount: 6, totalWeight: 150 },
    { date: m1 + '-15', count: 1, storeCount: 7, totalWeight: 210 },
    { date: m2 + '-08', count: 1, storeCount: 3, totalWeight: 60 },
  ];
  return { ym, m1, m2, history, range: { start: m2 + '-01', end: now } };
}
const FX = fakeHistory();

const STUB = `
try{var _m=JSON.parse(sessionStorage.getItem('__ME')||'null');window.__ME=_m}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 /* headers 必须有：fetch-retry / 导出等路径会读 res.headers.get('retry-after')，
    少了它整条链路会在 ".get of undefined" 上炸掉，页面表现为「列表空白」。 */
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t,ok);return Promise.resolve(o)};
 if(s.indexOf('/api/me')===0){
   if(!window.__ME) return B('{"error":"unauthorized"}',false);
   return B(JSON.stringify({success:true,user:window.__ME}));
 }
 if(s.indexOf('/api/history')===0)return B(JSON.stringify(${JSON.stringify({ success: true, routeId: 'r1', ...{ range: FX.range, history: FX.history } })}));
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

  /* 先落一次文档写登录态，再进历史页（页面头部会检查 zpAuth）。 */
  await C('Page.navigate', { url: BASE + '/pages/history.html' });
  await sleep(900);
  await ev('sessionStorage.clear();sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");');
  await C('Page.navigate', { url: BASE + '/pages/history.html?x=1' });
  await waitReady();
  await sleep(1400);

  check('落在历史页', (await ev('location.pathname')) === '/pages/history.html', String(await ev('location.pathname')));

  const months = await ev('[...document.querySelectorAll(".history-month")].map(s=>s.dataset.month)');
  check('渲染出 3 个月份分组', Array.isArray(months) && months.length === 3, JSON.stringify(months));
  check('当月分组在列表里', Array.isArray(months) && months.includes(FX.ym), JSON.stringify(months));

  /* ---- 1. 首屏全部收起 ---- */
  let expanded = await ev('document.querySelectorAll(".history-month.expanded").length');
  check('首屏 0 个展开（当月也没展开）', expanded === 0, String(expanded));

  const bodyH = (ym) => ev(`(()=>{const s=document.querySelector('.history-month[data-month="${ym}"] .history-month-body');return s?s.getBoundingClientRect().height:-1})()`);
  check('收起态日期行确实隐藏（高度 0）', (await bodyH(FX.ym)) === 0, String(await bodyH(FX.ym)));

  /* ---- 2. 点当月 → 展开，日期行真的出现 ---- */
  await ev(`document.querySelector('.history-month[data-month="${FX.ym}"] .history-month-main').click()`);
  await sleep(350);
  check('点月份条 → 该月展开', (await ev('document.querySelectorAll(".history-month.expanded").length')) === 1);
  check('展开后日期行可见（高度 > 0）', (await bodyH(FX.ym)) > 0, String(await bodyH(FX.ym)));
  check('展开后 aria-expanded=true',
    (await ev(`document.querySelector('.history-month[data-month="${FX.ym}"] .history-month-main').getAttribute('aria-expanded')`)) === 'true');
  check('只展开被点的那一个，其余仍收起',
    (await ev('document.querySelectorAll(".history-month.expanded").length')) === 1);

  /* ---- 3. 重绘后保持（用户删一条记录 → load() → render()） ---- */
  const hasLoad = await ev('typeof window.load');
  check('页面暴露 load()（重绘入口）', hasLoad === 'function', String(hasLoad));
  /* 直接走真实重绘路径：load() 拉一次 /api/history 再 render()——与删除一条记录后一致。 */
  await ev('window.load()');
  await sleep(900);
  check('重绘后已展开的月份仍展开',
    (await ev(`document.querySelector('.history-month[data-month="${FX.ym}"]').classList.contains('expanded')`)) === true);
  check('重绘后其余月份仍收起',
    (await ev('document.querySelectorAll(".history-month.expanded").length')) === 1,
    String(await ev('document.querySelectorAll(".history-month.expanded").length')));

  /* ---- 4. 再点一次收起 ---- */
  await ev(`document.querySelector('.history-month[data-month="${FX.ym}"] .history-month-main').click()`);
  await sleep(350);
  check('再点一次 → 收起', (await ev('document.querySelectorAll(".history-month.expanded").length')) === 0);
  check('收起后日期行又隐藏', (await bodyH(FX.ym)) === 0, String(await bodyH(FX.ym)));

  /* ---- 5. 点其他月份也只在它自己身上展开 ---- */
  await ev(`document.querySelector('.history-month[data-month="${FX.m1}"] .history-month-main').click()`);
  await sleep(350);
  check('点 9 月 → 只有 9 月展开',
    (await ev(`document.querySelector('.history-month[data-month="${FX.m1}"]').classList.contains('expanded')`)) === true &&
    (await ev('document.querySelectorAll(".history-month.expanded").length')) === 1);

  /* ---- 6. 冷启动（新文档、Set 为空）仍然全收起 ---- */
  await C('Page.navigate', { url: BASE + '/pages/history.html?fresh=1' });
  await waitReady();
  await sleep(1500);
  expanded = await ev('document.querySelectorAll(".history-month.expanded").length');
  check('重新进入页面：全部收起', expanded === 0, String(expanded));

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n真浏览器月份折叠验证：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
