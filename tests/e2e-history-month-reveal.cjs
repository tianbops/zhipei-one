/* 历史页「展开下方月份应从顶部开始显示」真浏览器验证
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-history-month-reveal.cjs
 *
 * 背景（2026-11-04 用户录屏反馈）：
 *   手风琴一次只展开一个月。10 月展开、向下滚到 9 月标题、点开 9 月时，
 *   10 月那二十几行瞬间 display:none，文档高度骤减，浏览器把 scrollTop
 *   裁到新的最大值（≈列表底部），于是 9 月标题与月初日期被顶出视口，
 *   用户看到的是 9 月末尾几行 —— 「9 月从底部开始显示」。
 *   期望与 10 月一致：标题在滚动区顶部，日期从上往下依次排开。
 *
 * 为什么必须真浏览器：scrollTop 的自动裁剪 / scroll anchoring 是布局引擎行为，
 *   手写 DOM 桩测不出来；只有真 .zp-scroll（overflow-y:auto）才复现。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8137);
const PORT_CDP = Number(process.env.PORT_CDP || 9318);
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

/* 三个月，每月二十来天：模拟「10 月展开后要滚很久才看到 9 月」的真实长列表。 */
function fakeHistory() {
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m] = now.slice(0, 7).split('-').map(Number);
  const ym = (n) => new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
  const months = [0, 1, 2].map(ym);
  const days = [22, 20, 18];
  const history = [];
  months.forEach((mm, i) => {
    for (let d = 1; d <= days[i]; d++) {
      history.push({ date: mm + '-' + String(d).padStart(2, '0'), count: 1, storeCount: 2, totalWeight: 1.5 });
    }
  });
  return { months, history, range: { start: months[2] + '-01', end: now } };
}
const FX = fakeHistory();

const STUB = `
try{var _m=JSON.parse(sessionStorage.getItem('__ME')||'null');window.__ME=_m}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.__REQS=[];window.fetch=function(u,o){const s=String(u);window.__REQS.push(s);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t,ok);return Promise.resolve(o)};
 if(s.indexOf('/api/me')>=0){
   if(!window.__ME) return B('{"error":"unauthorized"}',false);
   return B(JSON.stringify({success:true,user:window.__ME}));
 }
 if(s.indexOf('/api/history')>=0)return B(JSON.stringify(${JSON.stringify({ success: true, routeId: 'r1', range: FX.range, history: FX.history })}));
 if(s.indexOf('/api/')>=0)return B('{"success":true,"waybills":[],"history":[],"days":[],"routes":[],"stats":{}}');
 return real(u,o)};})();`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

const SNAP = `(()=>{
  const sc=document.querySelector('.zp-scroll');
  const sec=document.querySelectorAll('.history-month')[1];
  const main=sec.querySelector('.history-month-main');
  const rows=[...sec.querySelectorAll('.history-month-body .history-swipe-row')];
  const top=r=>Math.round(r.getBoundingClientRect().top-sc.getBoundingClientRect().top);
  const visible=rows.filter(r=>{const t=top(r);return t>=0&&t<sc.clientHeight});
  return {
    scrollTop:Math.round(sc.scrollTop),
    maxScroll:Math.round(sc.scrollHeight-sc.clientHeight),
    secTop:top(sec),
    mainTop:top(main),
    firstRowTop:rows.length?top(rows[0]):-999,
    rowCount:rows.length,
    firstDate:rows.length?rows[0].querySelector('.history-date-main span').textContent:'',
    visibleFirst:visible.length?visible[0].querySelector('.history-date-main span').textContent:'',
    visibleLast:visible.length?visible[visible.length-1].querySelector('.history-date-main span').textContent:'',
    expanded:sec.classList.contains('expanded'),
    onlyOne:document.querySelectorAll('.history-month.expanded').length,
    firstMonthCollapsed:!document.querySelectorAll('.history-month')[0].classList.contains('expanded')
  };
})()`;

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

  console.error('  [cdp] Chromium 已启动，读取 /json/version');
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) { console.error('无法启动 Chromium（检查 CHROMIUM 路径）'); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const q = pend.get(m.id); pend.delete(m.id);
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
    }
  });
  /* 本地 CDP 连接可能在赋值 onopen 之前就已经 OPEN（onopen 事件不会补发），
     此时等待 onopen 会永久挂起。显式判 readyState，并给 error 一个出口。 */
  await new Promise((r, rej) => {
    if (ws.readyState === WebSocket.OPEN) return r();
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  console.error('  [cdp] WebSocket 已连接');

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
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 160);
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

  await C('Page.navigate', { url: BASE + '/pages/history.html' });
  await sleep(900);
  await ev('sessionStorage.clear();sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");');
  await C('Page.navigate', { url: BASE + '/pages/history.html?x=1' });
  await waitReady();
  await sleep(1400);
  console.error('  [cdp] 历史页加载完成，开始断言');
  if (process.env.DEBUG) {
    const diag = await ev(`({state:document.getElementById('historyState')?.textContent,
      list:document.getElementById('historyList')?.children.length,
      me:window.__ME, reqs:window.__REQS})`);
    console.error('  [diag] ' + JSON.stringify(diag));
  }

  check('落在历史页', (await ev('location.pathname')) === '/pages/history.html', String(await ev('location.pathname')));
  check('渲染出 3 个月份分组', (await ev('document.querySelectorAll(".history-month").length')) === 3);

  /* ---- 1. 展开第一个月（模拟 10 月），再滚到第二个月标题可见 ---- */
  await ev('document.querySelectorAll(".history-month-main")[0].click()');
  await sleep(350);
  const afterFirst = await ev(SNAP);
  check('第 1 个月展开，第 2 个月仍收起', afterFirst.onlyOne === 1 && !afterFirst.expanded, JSON.stringify(afterFirst));

  /* 把第 2 个月标题放到视口 y≈320 处，模拟用户「往下滚到 9 月再点」。 */
  await ev(`(()=>{const sc=document.querySelector('.zp-scroll');const sec=document.querySelectorAll('.history-month')[1];
    const docTop=sec.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop;
    sc.scrollTop=Math.max(0,docTop-320);})()`);
  await sleep(200);
  const before = await ev(SNAP);
  check('点击前第 2 个月标题在视口内（y≈320）',
    before.mainTop > 240 && before.mainTop < 400, 'mainTop=' + before.mainTop + ' scrollTop=' + before.scrollTop);

  /* ---- 2. 点开第 2 个月：核心断言 ---- */
  await ev('document.querySelectorAll(".history-month-main")[1].click()');
  await sleep(450);
  const after = await ev(SNAP);
  console.log('  展开后快照: ' + JSON.stringify(after));

  check('第 2 个月展开、第 1 个月自动收起', after.expanded && after.firstMonthCollapsed && after.onlyOne === 1);
  check('第 2 个月标题停在滚动区顶部（从顶部开始显示，不是被顶出视口）',
    after.secTop >= -8 && after.secTop <= 24, 'secTop=' + after.secTop);
  check('第 2 个月第一行日期紧跟标题，位于视口内',
    after.firstRowTop >= after.secTop + 30 && after.firstRowTop < 180,
    'firstRowTop=' + after.firstRowTop + ' secTop=' + after.secTop);
  check('视口里第一个可见日期是本月最早那天（不是月末几行）',
    after.visibleFirst === after.firstDate, 'visibleFirst=' + after.visibleFirst + ' firstDate=' + after.firstDate);

  /* ---- 3. 再点回第 1 个月：同样从顶部开始 ---- */
  await ev('document.querySelectorAll(".history-month-main")[0].click()');
  await sleep(400);
  const back = await ev(`(()=>{const sc=document.querySelector('.zp-scroll');const sec=document.querySelectorAll('.history-month')[0];
    return {secTop:Math.round(sec.getBoundingClientRect().top-sc.getBoundingClientRect().top),
      expanded:sec.classList.contains('expanded'),onlyOne:document.querySelectorAll('.history-month.expanded').length}})()`);
  check('点回第 1 个月也贴顶（切换方向无关）', back.expanded && back.onlyOne === 1 && back.secTop >= -8 && back.secTop <= 24,
    JSON.stringify(back));

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n真浏览器月份展开方向验证：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
