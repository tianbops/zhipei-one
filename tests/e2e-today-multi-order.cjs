/* 同日多单 · 首页单卡切换真浏览器回归（2026-11-06）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-today-multi-order.cjs
 *
 * 场景：同一天同一线路两单（09:12 / 14:40），门店数与内容不同。
 * 锁死的行为：
 *   1) 两单都渲染，默认停在最新一单（第 2 单）；
 *   2) 点 tab 切换 → 摘要、列表、序号同步换页；
 *   3) 左滑切页，右滑回上一单；首尾不越界；
 *   4) 纵向滑动不切单（滚列表优先）；
 *   5) 卡片高度跟随当前页；
 *   6) 选中单记在本次会话，刷新后仍停在那一单；
 *   7) 切页手势不得误触导航。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8183);
const PORT_CDP = Number(process.env.PORT_CDP || 9363);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const LONG = '特渠部重庆市卫生健康委员会（临时办公区）';
const S1 = [
  { storeId: 'A1', name: LONG, rawName: LONG, routeOrder: 1, lat: 29.56, lng: 106.55, navigation: 'https://surl.amap.com/a1' },
  { storeId: 'A2', name: '谊品生鲜长安锦绣城店', rawName: '谊品生鲜长安锦绣城店', routeOrder: 2, lat: 29.57, lng: 106.53 },
  { storeId: 'A3', name: '江北重庆三峡融资担保集团', rawName: '江北重庆三峡融资担保集团', routeOrder: 3, lat: 29.58, lng: 106.54 },
  { storeId: 'A4', name: '到家主城-江北区加州客服中心', rawName: '到家主城-江北区加州客服中心', routeOrder: 4, lat: 29.59, lng: 106.52 },
  { storeId: 'A5', name: '渝北中景隆贸易有限公司', rawName: '渝北中景隆贸易有限公司', routeOrder: 5, lat: 29.6, lng: 106.51 },
  { storeId: 'A6', name: '两江新区礼嘉社区卫生服务中心', rawName: '两江新区礼嘉社区卫生服务中心', routeOrder: 6, lat: 29.61, lng: 106.5 },
];
const S2 = [
  { storeId: 'B1', name: '沙坪坝区三峡广场商圈', rawName: '沙坪坝区三峡广场商圈', routeOrder: 1, lat: 29.55, lng: 106.47 },
  { storeId: 'B2', name: '九龙坡区杨家坪正街店', rawName: '九龙坡区杨家坪正街店', routeOrder: 2, lat: 29.51, lng: 106.51 },
  { storeId: 'B3', name: '南岸区弹子石老街', rawName: '南岸区弹子石老街', routeOrder: 3, lat: 29.58, lng: 106.58 },
  { storeId: 'B4', name: '巴南区鱼洞街道办', rawName: '巴南区鱼洞街道办', routeOrder: 4, lat: 29.4, lng: 106.53 },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
try{localStorage.clear()}catch(e){}
(function(){
  var today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  var w1={id:'w-1',routeId:'r1',date:today,stage:'CONFIRMED',schemaVersion:'2',uploadedAt:today+'T01:12:00Z',
    stores:${JSON.stringify(S1)},summary:{finalCount:6,total:6},totalWeight:0.8};
  var w2={id:'w-2',routeId:'r1',date:today,stage:'CONFIRMED',schemaVersion:'2',uploadedAt:today+'T06:40:00Z',
    stores:${JSON.stringify(S2)},summary:{finalCount:4,total:4},totalWeight:0.43};
  window.__clicks=0;window.__nav=[];
  window.open=function(u){window.__nav.push(String(u));return null;};
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a[data-zp-nav]'):null;
    if(a){window.__clicks++;e.preventDefault();}
  },true);
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u);
    if(s.indexOf('/api/home-bootstrap')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'测试线路'},user:{boundRouteId:'r1'}}));
    if(s.indexOf('/api/waybills/latest')>=0)return B(JSON.stringify({success:true,waybill:w2,dayCount:2,orders:[w1,w2]}));
    if(s.indexOf('/api/history')>=0)return B(JSON.stringify({success:true,waybills:[w1,w2],history:[],routeId:'r1'}));
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>{
  const list=document.getElementById('todayStoreList');
  const pages=[...document.querySelectorAll('#todayStoreList .today-page')];
  const active=document.querySelector('#todayTabs .today-tab.is-active');
  return {
    tabs:[...document.querySelectorAll('#todayTabs .today-tab')].map(b=>b.textContent.trim()),
    tabsHidden:!!document.getElementById('todayTabs').hidden,
    active:active?Number(active.dataset.i):-1,
    count:(document.getElementById('todayCount')||{}).textContent||'',
    weight:(document.getElementById('todayWeight')||{}).textContent||'',
    orders:(document.getElementById('todayOrders')||{}).textContent||'',
    pages:pages.length,
    rowsByPage:pages.map(p=>p.querySelectorAll('.today-store-row').length),
    idxByPage:pages.map(p=>[...p.querySelectorAll('.today-store-index')].map(s=>s.textContent.trim())),
    height:parseInt(list.style.height||'0',10),
    /* 2026-11-06 一屏内滚：卡片高度由 flex 决定（非 JS 内联高度），
       切页时不应跳；名单区高度 = 卡片剩余空间。 */
    cardH:(document.querySelector('.task-card')||{}).offsetHeight||0,
    listH:list.offsetHeight||0,
    viewH:(list.querySelector('.today-view')||{}).offsetHeight||0,
    transform:(list.querySelector('.today-track')||{}).style?list.querySelector('.today-track').style.transform:''
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    const base = path.join(ROOT, p);
    const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!hit) { res.writeHead(404, H); return res.end('404'); }
    res.writeHead(200, { ...H, 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  });
  await new Promise((r) => srv.listen(PORT, r));
  const proc = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + PORT_CDP, 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } });
  await new Promise((r) => { if (ws.readyState === WebSocket.OPEN) return r(); ws.addEventListener('open', r, { once: true }); });
  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId; const C = (m, p) => send(m, p, sid);
  await C('Page.enable'); await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const ev = async (s) => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { err: String(r.exceptionDetails.text).slice(0, 200) }; return r.result.value; };
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(2400);
  let s = await ev(SNAP);
  console.log('init ' + JSON.stringify(s));
  check('两单都在 DOM 里（pages=2）', s && s.pages === 2, s && String(s.pages));
  /* 2026-11-06 用户定稿：tab 只写「第 N 单」，不再带上传时间。
     顺序仍按上传时间升序（第 1 单 = 最早上传）。 */
  check('tab 只写「第1单 / 第2单」，不带时间', s && s.tabs.join('|') === '第1单|第2单', s && JSON.stringify(s.tabs));
  check('tab 文案里没有时间（无 HH:mm）', s && !s.tabs.some((t) => /\d{1,2}:\d{2}/.test(t)), s && JSON.stringify(s.tabs));
  check('默认停在最新一单（第 2 单）', s && s.active === 1, s && String(s.active));
  check('摘要取当前单（4家）', s && s.count === '4家', s && s.count);
  check('单量取全天（2单）', s && s.orders === '2单', s && s.orders);
  check('第 2 单 4 家、序号 1-4 重排', s && s.rowsByPage[1] === 4 && s.idxByPage[1].join(',') === '1,2,3,4', s && JSON.stringify(s.idxByPage[1]));

  /* 点 tab 切到第 1 单 */
  await ev(`(()=>{document.querySelectorAll('#todayTabs .today-tab')[0].click();return 1})()`);
  await sleep(420);
  s = await ev(SNAP);
  console.log('tab1 ' + JSON.stringify(s));
  check('点 tab 切到第 1 单', s && s.active === 0, s && String(s.active));
  check('摘要跟随切页（6家 / 0.800t）', s && s.count === '6家' && s.weight === '0.800t', s && (s.count + ' ' + s.weight));
  check('第 1 单 6 家、序号连续', s && s.rowsByPage[0] === 6 && s.idxByPage[0].join(',') === '1,2,3,4,5,6', s && JSON.stringify(s.idxByPage[0]));
  check('轨道位移到第 1 页', s && /^translate3d\(0px/.test(s.transform), s && s.transform);
  check('卡片高度 = 一屏（>500px，由 flex 链决定而非 JS 内联高度）', s && s.cardH > 500, s && String(s.cardH));
  check('名单区占用卡片剩余高度（小于卡片、大于 0）', s && s.listH > 0 && s.listH < s.cardH, s && (s.listH + '/' + s.cardH));
  const h1 = s.cardH;

  /* 左滑回第 2 单 */
  await ev(`(()=>{
    const box=document.getElementById('todayStoreList');
    const r=box.querySelector('.today-page[data-i="0"] .today-store-row');
    const rc=r.getBoundingClientRect();
    const y=Math.round(rc.top+10), x=Math.round(rc.right-30);
    const opt={bubbles:true,cancelable:true,pointerType:'touch'};
    r.dispatchEvent(new PointerEvent('pointerdown',{...opt,clientX:x,clientY:y}));
    r.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:x-60,clientY:y+2}));
    r.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:x-120,clientY:y+3}));
    r.dispatchEvent(new PointerEvent('pointerup',{...opt,clientX:x-120,clientY:y+3}));
    return 1;
  })()`);
  await sleep(420);
  s = await ev(SNAP);
  console.log('swipe ' + JSON.stringify(s));
  check('左滑切到下一单（第 2 单）', s && s.active === 1, s && String(s.active));
  check('切页后摘要同步（4家）', s && s.count === '4家', s && s.count);
  check('切页后卡片高度不变（6 家 / 4 家同一屏，不再随行数跳动）', s && s.cardH === h1, s && (h1 + ' -> ' + s.cardH));

  /* 纵向滑动：判为滚动，不得切单 */
  await ev(`(()=>{
    const box=document.getElementById('todayStoreList');
    const r=box.querySelector('.today-page[data-i="1"] .today-store-row');
    const rc=r.getBoundingClientRect();
    const y=Math.round(rc.top+8), x=Math.round(rc.right-40);
    const opt={bubbles:true,cancelable:true,pointerType:'touch'};
    r.dispatchEvent(new PointerEvent('pointerdown',{...opt,clientX:x,clientY:y}));
    r.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:x+16,clientY:y+40}));
    r.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:x+20,clientY:y+110}));
    r.dispatchEvent(new PointerEvent('pointerup',{...opt,clientX:x+20,clientY:y+110}));
    return 1;
  })()`);
  await sleep(420);
  s = await ev(SNAP);
  check('纵向滑动不切单（仍是第 2 单）', s && s.active === 1, s && String(s.active));

  /* 末页继续左滑：不循环 */
  await ev(`(()=>{
    const box=document.getElementById('todayStoreList');
    const r=box.querySelector('.today-page[data-i="1"] .today-store-row');
    const rc=r.getBoundingClientRect();
    const y=Math.round(rc.top+10), x=Math.round(rc.right-30);
    const opt={bubbles:true,cancelable:true,pointerType:'touch'};
    r.dispatchEvent(new PointerEvent('pointerdown',{...opt,clientX:x,clientY:y}));
    r.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:x-150,clientY:y+2}));
    r.dispatchEvent(new PointerEvent('pointerup',{...opt,clientX:x-150,clientY:y+2}));
    return 1;
  })()`);
  await sleep(420);
  s = await ev(SNAP);
  check('末页再左滑不循环（停在 1）', s && s.active === 1, s && String(s.active));

  /* 误触：横滑后紧跟的 click 不得打开导航 */
  const clickAfter = await ev(`(()=>{
    const r=document.querySelector('.today-page[data-i="1"] .today-store-row');
    const before=window.__clicks;
    r.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return {before,after:window.__clicks};
  })()`);
  check('切页手势后的 click 被吞（不误触导航）', clickAfter && clickAfter.after === clickAfter.before, JSON.stringify(clickAfter));

  /* 记住选择：切到第 1 单后刷新，仍停在第 1 单 */
  await ev(`(()=>{document.querySelectorAll('#todayTabs .today-tab')[0].click();return 1})()`);
  await sleep(400);
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(2400);
  s = await ev(SNAP);
  console.log('reload ' + JSON.stringify(s));
  check('刷新后记住上次选择（第 1 单）', s && s.active === 0, s && String(s.active));

  /* 2026-11-06 一屏内滚：把名单补到 25 行，验证「摘要 + 插画 + tab 固定，
     只有门店名单在自己的区域里滚」。克隆行不影响 state / 手势，只测版面。 */
  const scrollInfo = await ev(`(()=>{
    const page=document.querySelector('.today-page[data-i="0"]');
    const sum=document.querySelector('.task-main');
    const tabs=document.getElementById('todayTabs');
    const row=page.querySelector('.today-store-row');
    for(let i=0;i<24;i++) page.appendChild(row.cloneNode(true));
    const r=(e)=>Math.round(e.getBoundingClientRect().top);
    const before={sum:r(sum),tab:r(tabs),card:document.querySelector('.task-card').offsetHeight};
    const overflow=page.scrollHeight-page.clientHeight;
    page.scrollTop=300;
    const after={sum:r(sum),tab:r(tabs),top:page.scrollTop};
    return {overflow,before,after};
  })()`);
  console.log('scroll ' + JSON.stringify(scrollInfo));
  check('25 行时名单页内可滚（内容溢出）', scrollInfo && scrollInfo.overflow > 100, scrollInfo && String(scrollInfo.overflow));
  check('滚动发生在名单页内（scrollTop 生效）', scrollInfo && scrollInfo.after.top > 0, scrollInfo && String(scrollInfo.after.top));

  /* 2026-11-06 定稿：浏览下方内容时浮岛收起（把 150px 让给列表），
     回看上方时弹出。收起会同步补偿 scrollTop，所以列表内容不会整体上跳。 */
  const headToggle = await ev(`(async()=>{
    const main=document.querySelector('main.home-app');
    const page=document.querySelector('.today-page[data-i="0"]');
    const list=document.getElementById('todayStoreList');
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    /* 先从任意状态复位：显式展开 + 回顶，避免上一条用例留下的收起态干扰 */
    try{window.zpHeadShow&&window.zpHeadShow()}catch(e){}
    await wait(320); page.scrollTop=0; await wait(260);
    const before={hidden:main.classList.contains('is-head-hidden'),listH:Math.round(list.getBoundingClientRect().height)};
    const y0=page.scrollTop;
    page.scrollTop=420; await wait(380);
    const off={hidden:main.classList.contains('is-head-hidden'),listH:Math.round(list.getBoundingClientRect().height),st:Math.round(page.scrollTop)};
    page.scrollTop=Math.max(0,off.st-90); await wait(380);
    const on={hidden:main.classList.contains('is-head-hidden'),listH:Math.round(list.getBoundingClientRect().height)};
    return {before,off,on,y0};
  })()`);
  console.log('head ' + JSON.stringify(headToggle));
  check('向下滚名单收起浮岛', headToggle && headToggle.before.hidden === false && headToggle.off.hidden === true, JSON.stringify(headToggle));
  check('收起后列表高度增加（把空间让给门店）', headToggle && headToggle.off.listH > headToggle.before.listH + 100, headToggle && (headToggle.before.listH + ' -> ' + headToggle.off.listH));
  check('向上滚名单弹出浮岛', headToggle && headToggle.on.hidden === false, JSON.stringify(headToggle));
  check('弹出后列表高度回到原值', headToggle && Math.abs(headToggle.on.listH - headToggle.before.listH) <= 2, headToggle && String(headToggle.on.listH));

  /* 2026-11-06 用户录屏「固定没实现」：真手指上滑到名单底部后，滚动链会把
     外层 .zp-scroll 一起带走（实测 226px，摘要 top 从 148 漂到 -78），
     头部整块滚出屏幕。修法是页内可滚时开 overscroll-behavior-y:contain，
     这里用 CDP 触摸事件把「到底即停、头部不动」钉死。 */
  await C('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const swipeUp = async () => {
    const x = 195, y0 = 660, dy = -300;
    const pt = (y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
    await C('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y0) });
    for (let k = 1; k <= 12; k++) {
      await C('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y0 + (dy * k) / 12) });
      await sleep(16);
    }
    await C('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
  };
  const HEAD_PROBE = `(()=>{
    const r=(e)=>e?Math.round(e.getBoundingClientRect().top):null;
    const p=document.querySelector('.today-page[data-i="0"]');
    const outer=document.querySelector('main.home-app .zp-scroll');
    return {sum:r(document.querySelector('.task-main')),tab:r(document.getElementById('todayTabs')),
      pageTop:p?Math.round(p.scrollTop):null,pageMax:p?Math.round(p.scrollHeight-p.clientHeight):null,
      outerTop:outer?Math.round(outer.scrollTop):0,outerMax:outer?Math.round(outer.scrollHeight-outer.clientHeight):0,
      mark:p?p.classList.contains('is-scrollable'):false,
      hidden:document.querySelector('main.home-app').classList.contains('is-head-hidden'),
      listH:Math.round(document.getElementById('todayStoreList').getBoundingClientRect().height)};
  })()`;
  await sleep(300);   /* 等 MutationObserver 打完 .is-scrollable */
  const headBefore = await ev(HEAD_PROBE);
  await swipeUp(); await swipeUp(); await swipeUp();
  const headAfter = await ev(HEAD_PROBE);
  console.log('touch ' + JSON.stringify({ headBefore, headAfter }));
  check('可滚名单被标记 .is-scrollable（滚动链才切断）', headBefore && headBefore.mark === true, headBefore && String(headBefore.mark));
  check('手指连滑 3 次后名单到底', headAfter && headAfter.pageMax > 0 && headAfter.pageTop === headAfter.pageMax, headAfter && (headAfter.pageTop + '/' + headAfter.pageMax));
  check('名单到底后外层不被连带滚动', headAfter && headAfter.outerTop === 0, headAfter && (headAfter.outerTop + '/' + headAfter.outerMax));
  /* 2026-11-06 定稿：手指连滑 3 次 = 一直在往下看 → 浮岛收起（摘要/tab 随之滑出），
     把 150px 让给名单；这里钉的是「收起确实发生」，不是「位置不动」。 */
  check('触摸连滑后浮岛收起', headBefore && headAfter && headBefore.hidden === false && headAfter.hidden === true, headBefore && (headBefore.hidden + ' -> ' + (headAfter && headAfter.hidden)));
  check('触摸连滑后名单多出约 150px 可视高度', headBefore && headAfter && headAfter.listH - headBefore.listH >= 140, headBefore && (headBefore.listH + ' -> ' + (headAfter && headAfter.listH)));

  const shot = await C('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 390, height: 620, scale: 2 } });
  fs.writeFileSync(path.join(OUT_DIR, 'today-multi-order.png'), Buffer.from(shot.data, 'base64'));

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n结果: ' + (results.length - failed) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL'); srv.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
