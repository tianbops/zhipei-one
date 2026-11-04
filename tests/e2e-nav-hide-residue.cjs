/* 浮岛底栏隐藏后「底部残留蓝色」回归验证（2026-11-05 用户反馈）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-nav-hide-residue.cjs
 *
 * 现象（用户真机截图）：历史页向下滚，浮岛收起后底部仍有一条蓝色细弧。
 *   把截图底部放大取样：蓝色只在 x 696~744（图宽 1440）、高度 4 行，
 *   位置正中 —— 正是中间「+」圆形按钮的顶部，不是页面背景。
 *
 * 根因：隐藏位移是 translate(-50%, calc(100% + 16px))，100% 只让底栏本体
 *   重合出屏；而加号 `.zp-nav-plus .zp-nav-icon` 有 translateY(-16px) 上凸，
 *   52px 圆在 52px 行里居中再上移 16，圆顶比底栏顶边高 9px。16px 余量被
 *   这 9px 吃掉后只剩 7px，实测隐藏态加号顶边停在 843 / 视口 844 —— 露 1px。
 *   修复：余量 16 → 32px（位移 98px，加号顶边到 859，含投影整体出屏 15px）。
 *
 * 为什么必须真浏览器：加号的实际顶边由 grid 行高、padding、居中与 transform
 *   叠加决定，改任一环都会移动这个值；只有真布局能给出「到底露没露」的答案。
 *   断言直接量 getBoundingClientRect，不用像素截图解码（CI 无 PNG 解码依赖）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8141);
const PORT_CDP = Number(process.env.PORT_CDP || 9322);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

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

/* 三个月 × 二十来天：历史页本身就够长，不需要往 DOM 里塞占位块。 */
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
try{Object.defineProperty(navigator,'serviceWorker',{value:{register:()=>Promise.resolve(),getRegistrations:()=>Promise.resolve([]),addEventListener:function(){},controller:null}})}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
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

/* 一次量全：本体 / 加号 / 命中的元素 / 位移量 */
const MEASURE = `(()=>{
  const nav=document.querySelector('.zp-nav');
  const plus=document.querySelector('.zp-nav-plus .zp-nav-icon');
  const nr=nav.getBoundingClientRect(), pr=plus.getBoundingClientRect();
  const vh=innerHeight;
  const hits=[];
  for(let y=vh-1;y>vh-26;y-=4){
    for(const x of [195,120,270]){
      const el=document.elementFromPoint(x,y);
      hits.push(el?(el.closest('.zp-nav')?'NAV:'+(el.className||el.tagName):'page'):'none');
    }
  }
  return {
    vh, hidden:nav.classList.contains('is-nav-hidden'),
    navTop:+nr.top.toFixed(1), navBottom:+nr.bottom.toFixed(1), navH:+nr.height.toFixed(1),
    plusTop:+pr.top.toFixed(1), plusVisible:+Math.max(0,vh-pr.top).toFixed(1),
    inert:nav.hasAttribute('inert'),
    navHits:hits.filter(h=>h.indexOf('NAV')===0).length,
    hitSample:hits.slice(0,6),
    scrollTop:Math.round((document.querySelector('.zp-scroll')||document.documentElement).scrollTop),
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
    // 无缓存：否则多轮迭代会拿到上一版 CSS，量出来的还是旧位移
    res.writeHead(200, { 'content-type': MIME[path.extname(hit)] || 'application/octet-stream', 'cache-control': 'no-store' });
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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const q = pend.get(m.id); pend.delete(m.id);
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
    }
  });
  await new Promise((r, rej) => {
    if (ws.readyState === WebSocket.OPEN) return r();
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId;
  const C = (m, p) => send(m, p, sid);
  await C('Page.enable');
  await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await C('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  const ev = async (s) => {
    const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 160);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await C('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.data, 'base64'));
  };

  await C('Page.navigate', { url: BASE + '/pages/history.html' });
  await sleep(900);
  await ev('sessionStorage.clear();sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");localStorage.setItem("zp_appearance_theme","dark");');
  await C('Page.navigate', { url: BASE + '/pages/history.html?x=1' });
  for (let i = 0; i < 60; i++) {
    if ((await ev('document.readyState')) === 'complete') break;
    await sleep(150);
  }
  await sleep(1400);

  check('落在历史页', (await ev('location.pathname')) === '/pages/history.html');
  if (process.env.DEBUG) {
    console.log('  [diag] ' + JSON.stringify(await ev(`({state:document.getElementById('historyState')?.textContent,
      list:document.getElementById('historyList')?.children.length,
      months:document.querySelectorAll('.history-month').length,
      scrollH:document.querySelector('.zp-scroll')?.scrollHeight,
      clientH:document.querySelector('.zp-scroll')?.clientHeight,
      overflow:getComputedStyle(document.querySelector('.zp-scroll')).overflowY})`)));
  }
  const navCount = await ev('document.querySelectorAll(".zp-nav").length');
  check('页面上只有一套底栏（没有第二份副本各隐藏一半）', navCount === 1, 'count=' + navCount);

  const init = await ev(MEASURE);
  check('初始为常驻显示态', init.hidden === false && init.navBottom <= init.vh + 1, JSON.stringify({ top: init.navTop, bottom: init.navBottom }));

  /* 手风琴默认全收起，列表不足一屏滚不动；先展开一个月 —— 与用户真实操作一致 */
  await ev('document.querySelectorAll(".history-month-main")[0].click()');
  await sleep(400);
  const grew = await ev(`(()=>{const sc=document.querySelector('.zp-scroll');return {h:sc.scrollHeight,c:sc.clientHeight,rows:document.querySelectorAll('.history-month.expanded .history-swipe-row').length}})()`);
  check('展开一个月后列表可滚动（否则测不到隐藏）', grew.h - grew.c > 100, JSON.stringify(grew));

  /* 真实下滚：每帧 40px、共 40 帧，跨过 nav.js 的累计阈值 */
  await ev(`(async()=>{const sc=document.querySelector('.zp-scroll');
    for(let i=0;i<40;i++){sc.scrollTop+=40;await new Promise(r=>requestAnimationFrame(r));}})()`);
  await sleep(700);
  const hid = await ev(MEASURE);
  console.log('  隐藏态快照: ' + JSON.stringify(hid));
  await shot('nav-hidden-after.png');

  check('向下滚后底栏收起', hid.hidden === true, 'hidden=' + hid.hidden);
  check('收起时带 inert（退出现行 Tab 序）', hid.inert === true);
  check('底栏本体完全出屏', hid.navTop >= hid.vh, 'navTop=' + hid.navTop + ' vh=' + hid.vh);
  /* 核心断言：蓝色圆顶来自加号，它必须也出屏 */
  check('中间加号圆形完全出屏（余量不足时停在 843，露出 1px）',
    hid.plusTop >= hid.vh, 'plusTop=' + hid.plusTop + ' vh=' + hid.vh + ' 露出=' + hid.plusVisible + 'px');
  check('底部 24px 内无底栏元素拦截点击（隐藏态 pointer-events 穿透）', hid.navHits === 0, 'hits=' + hid.navHits + ' ' + JSON.stringify(hid.hitSample));
  check('位移量 ≥ 本体高 + 24px（余量要盖住加号上凸 13px）',
    hid.navTop - init.navTop >= hid.navH + 24, '位移=' + (hid.navTop - init.navTop) + ' 本体高=' + hid.navH);

  /* 上滑回来：确认修复没有把「回来」一起改坏 */
  await ev(`(async()=>{const sc=document.querySelector('.zp-scroll');
    for(let i=0;i<12;i++){sc.scrollTop-=40;await new Promise(r=>requestAnimationFrame(r));}})()`);
  await sleep(600);
  const back = await ev(MEASURE);
  check('上滑后底栏恢复', back.hidden === false && back.navTop < back.vh - 30, 'navTop=' + back.navTop);
  await shot('nav-shown-after.png');

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n底栏隐藏无残留验证：${results.length - bad.length}/${results.length} 通过（截图：${OUT_DIR}）`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
