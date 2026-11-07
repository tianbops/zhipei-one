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
  check('tab 只显示序号「第1单 / 第2单」且不含时间', s && s.tabs.length === 2 && s.tabs[0] === '第1单' && s.tabs[1] === '第2单' && !/\d{1,2}:\d{2}/.test(s.tabs.join(' ')), s && JSON.stringify(s.tabs));
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
  check('页高按第 1 单实测锁定', s && s.height > 200, s && String(s.height));
  const h1 = s.height;

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
  check('不同单的行数不同 → 页高随之变化', s && s.height !== h1, s && (h1 + ' -> ' + s.height));

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

  const shot = await C('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 390, height: 620, scale: 2 } });
  fs.writeFileSync(path.join(OUT_DIR, 'today-multi-order.png'), Buffer.from(shot.data, 'base64'));

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n结果: ' + (results.length - failed) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL'); srv.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
