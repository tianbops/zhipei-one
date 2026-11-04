/* 浮岛底栏收起态回归验证（2026-11-05 用户反馈 → 五版新契约）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-nav-hide-residue.cjs
 *
 * 历史（四版）：用户真机截图「历史页向下滚，浮岛收起后底部仍有一条蓝色细弧」。
 *   根因是隐藏位移余量不足，只让底栏本体出屏，中间加号凸出的圆顶留在视口内。
 *   四版把余量加到 32px，加号跟着浮岛一起出屏 —— 那时断言的是「加号必须出屏」。
 *
 * 五版契约反转：用户参照 Shadowrocket 定稿「收起后加号不跟着走，独自留在底部」。
 *   所以同一个测量点现在要验的是**相反**的事：
 *     · 浮岛本体必须完全出屏（这是原来那条 bug 的底线，不能回退）；
 *     · 加号必须留在屏内、底边距屏底 21px（参考截图实测 64px@3x）；
 *     · 加号在收起态仍可点（父级 pointer-events:none 之下单独 auto）；
 *     · 其余四个导航项出屏后必须退出 Tab 序（tabindex=-1 + aria-hidden），
 *       否则键盘/读屏会停在一排看不见的链接上。
 *   「露一点蓝边」与「留一枚完整圆钮」是两件事：前者是不完整出屏（bug），
 *   后者是刻意的停靠位置（设计），本文件用 21px 这个精确值把两者分开。
 *
 * 为什么必须真浏览器：加号的最终位置由 grid 行高、padding、父层位移与自身
 *   translateY 叠加决定，改任一环都会移动这个值；只有真布局能给出答案。
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

/* 一次量全：本体 / 加号 / 命中元素 / Tab 序 */
const MEASURE = `(()=>{
  const nav=document.querySelector('.zp-nav');
  const plus=document.querySelector('.zp-nav-plus .zp-nav-icon');
  const plusBtn=document.querySelector('.zp-nav-plus');
  const nr=nav.getBoundingClientRect(), pr=plus.getBoundingClientRect();
  const vh=innerHeight;
  const hits=[];
  for(let y=vh-1;y>vh-26;y-=4){
    for(const x of [195,120,270]){
      const el=document.elementFromPoint(x,y);
      hits.push(el?(el.closest('.zp-nav-plus')?'PLUS':(el.closest('.zp-nav')?'NAV':'page')):'none');
    }
  }
  // 加号圆心处的命中元素：收起态必须仍是加号本身（不是被 pointer-events:none 穿透）
  const hitCenter=(()=>{
    const el=document.elementFromPoint(pr.left+pr.width/2, pr.top+pr.height/2);
    return el?(el.closest('.zp-nav-plus')?'PLUS':(el.closest('.zp-nav')?'NAV:'+el.className:'page')):'none';
  })();
  const items=[...document.querySelectorAll('.zp-nav-item')].map(a=>({
    plus:a.classList.contains('zp-nav-plus'),
    tab:a.getAttribute('tabindex'), aria:a.getAttribute('aria-hidden'),
  }));
  return {
    vh, hidden:nav.classList.contains('is-nav-hidden'),
    navTop:+nr.top.toFixed(1), navBottom:+nr.bottom.toFixed(1), navH:+nr.height.toFixed(1),
    plusTop:+pr.top.toFixed(1), plusBottom:+pr.bottom.toFixed(1),
    plusDistBottom:+(vh-pr.bottom).toFixed(1), plusD:+pr.width.toFixed(1),
    plusInert:plusBtn.hasAttribute('inert')||nav.hasAttribute('inert'),
    navInert:nav.hasAttribute('inert'),
    hitCenter, navHits:hits.filter(h=>h==='NAV').length, plusHits:hits.filter(h=>h==='PLUS').length,
    hitSample:hits.slice(0,6), items,
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
  check('底栏本体完全出屏（四版那条「底部露蓝边」的底线不能回退）',
    hid.navTop >= hid.vh, 'navTop=' + hid.navTop + ' vh=' + hid.vh);
  /* 五版新契约：加号不跟着走，独自停在距屏底 21px（参考截图 64px@3x 实测） */
  check('加号留在屏内（收起态仍在视口内可见）',
    hid.plusBottom <= hid.vh && hid.plusTop > hid.vh - 120,
    'top=' + hid.plusTop + ' bottom=' + hid.plusBottom + ' vh=' + hid.vh);
  check('加号底边距屏底 21px（±3px，参考软件收起态同位置）',
    Math.abs(hid.plusDistBottom - 21) <= 3, '距底=' + hid.plusDistBottom + 'px');
  check('加号尺寸未变（52px，收起不缩放）', hid.plusD === 52, 'd=' + hid.plusD);
  /* 交互：父级 pointer-events:none 不能把加号一起废掉 */
  check('加号在收起态仍可命中（圆心处 elementFromPoint 是加号本身）',
    hid.hitCenter === 'PLUS', 'hit=' + hid.hitCenter);
  check('加号未被 inert 波及（不能整条 nav 设 inert）',
    hid.plusInert === false && hid.navInert === false);
  /* 其余四项必须退出 Tab 序，否则键盘会停在一排看不见的链接上 */
  const others = hid.items.filter((i) => !i.plus);
  const plusItem = hid.items.find((i) => i.plus);
  check('收起时其余四个导航项 tabindex=-1 且 aria-hidden=true',
    others.length === 4 && others.every((i) => i.tab === '-1' && i.aria === 'true'),
    JSON.stringify(others));
  check('加号自己不受 Tab 序处理（不能被一起关掉）',
    !!plusItem && plusItem.tab === null && plusItem.aria === null, JSON.stringify(plusItem));
  check('浮岛本体（表面层）不拦截点击：底部 24px 内无 NAV 命中',
    hid.navHits === 0, 'hits=' + hid.navHits + ' ' + JSON.stringify(hid.hitSample));
  check('位移量 ≥ 本体高 + 24px（本体要完全沉下去，不能靠加号挡住缝）',
    hid.navTop - init.navTop >= hid.navH + 24, '位移=' + (hid.navTop - init.navTop) + ' 本体高=' + hid.navH);

  /* 上滑回来：确认修复没有把「回来」一起改坏 */
  await ev(`(async()=>{const sc=document.querySelector('.zp-scroll');
    for(let i=0;i<12;i++){sc.scrollTop-=40;await new Promise(r=>requestAnimationFrame(r));}})()`);
  await sleep(600);
  const back = await ev(MEASURE);
  check('上滑后底栏恢复', back.hidden === false && back.navTop < back.vh - 30, 'navTop=' + back.navTop);
  check('上滑后加号回到缺口位（底边距屏底 46px，五版凸出 26px 的结果）',
    Math.abs(back.plusDistBottom - 46) <= 2, '距底=' + back.plusDistBottom);
  check('上滑后其余导航项恢复 Tab 序（tabindex / aria-hidden 已清除）',
    back.items.filter((i) => !i.plus).every((i) => i.tab === null && i.aria === null),
    JSON.stringify(back.items));
  await shot('nav-shown-after.png');

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n底栏隐藏无残留验证：${results.length - bad.length}/${results.length} 通过（截图：${OUT_DIR}）`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
