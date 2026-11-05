/* 数据中心「安卓系统手势返回」真浏览器回归（2026-11-05）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-back-system.cjs
 *
 * 与 e2e-data-back.cjs 的分工：那条只测顶栏箭头 click，永远走 zpBackButton，
 * 所以当初没发现手势返回错。用户实测链路是：
 *   /home → /pages/dispatch → 点「数据中心」入口 → /pages/data → 系统手势返回
 * 旧实现站内导航一律 location.replace，子页上一条历史记录是工作区根，
 * 系统返回是跨文档后退，浏览器直接加载根页，popstate 不触发，返回控制器
 * 完全没机会介入 —— 线上表现为「数据资料按返回回到首页」。
 *
 * 修法：父级 → 有静态父级的子页放行普通 <a> push，保留「父级→子页」两层物理历史；
 * 子页用 sessionStorage.zpNavPushParent 认出自己是 push 进来的，顶栏/原生壳返回
 * 用 history.back() 消费那条父级记录；popstate 路径传 true，绝不二次 back。
 *
 * 离线环境不打外网：/api/dispatch、/api/base、/api/waybills 由 STUB 直接回数据。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8176);
const PORT_CDP = Number(process.env.PORT_CDP || 9356);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const STORES = [{ storeId: 'S1', name: '谊品生鲜长安锦绣城店', navigation: '', lat: null, lng: null, routeOrder: 1, aliases: [] }];
const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
window.addEventListener('popstate',function(){try{sessionStorage.setItem('zpPopCount',String(Number(sessionStorage.getItem('zpPopCount')||0)+1))}catch(e){}});
(function(){
  var stores=${JSON.stringify(STORES)};
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u),m=String((o&&o.method)||'GET').toUpperCase();
    if(s.indexOf('/api/dispatch')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'一号线'}}));
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT')return B(JSON.stringify({success:true,base:{version:2,stores:stores}}));
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'一号线'},base:{version:1,stores:stores}}));
    }
    if(s.indexOf('/api/waybills')>=0)return B(JSON.stringify({success:true,orders:[],waybill:null,summary:{}}));
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>({
  path:location.pathname+location.search,
  resolve:(typeof window.zpResolveBack==='function')?window.zpResolveBack():null,
  hist:history.length,
  pop:Number(sessionStorage.getItem('zpPopCount')||0),
  marker:sessionStorage.getItem('zpNavPushParent'),
  hasSystemBack:typeof window.zpSystemBack==='function',
  h1:(document.querySelector('h1')||{}).textContent||''
}))()`;

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
  const open = async (p) => { await C('Page.navigate', { url: BASE + p }); await sleep(1400); return ev(SNAP); };

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  /* ① 用户实测链路：首页 → 线路维护 → 数据中心 → 系统手势返回 */
  const a0 = await open('/home');
  await ev("location.replace('/pages/dispatch')"); await sleep(1400);
  const a1 = await ev(SNAP);
  await ev(`(()=>{var a=document.querySelector('a[href*="/pages/data"]');if(a)a.click();return 1})()`); await sleep(1500);
  const a2 = await ev(SNAP);
  console.log('A 链路 ' + JSON.stringify({ home: a0 && a0.path, dispatch: a1 && a1.path, data: a2 && a2.path, hist: [a0 && a0.hist, a1 && a1.hist, a2 && a2.hist] }));
  check('点「数据中心」入口真的进了数据页', a2 && a2.path.indexOf('/pages/data') === 0, a2 && a2.path);
  check('父级 → 子页走普通 push（历史多一层，不再一律 replace）',
    a1 && a2 && a2.hist === a1.hist + 1, a1 && a2 && `${a1.hist} → ${a2.hist}`);
  check('子页消费并清除 zpNavPushParent 标记（不留残留误判）', a2 && a2.marker === null, a2 && String(a2.marker));

  await ev('history.back()'); await sleep(1700);
  const a3 = await ev(SNAP);
  console.log('A 返回 ' + JSON.stringify(a3));
  check('安卓系统手势返回落到线路维护页（核心 bug）', a3 && a3.path === '/pages/dispatch', a3 && a3.path);
  check('落地页面标题是「线路维护」', a3 && a3.h1 === '线路维护', a3 && a3.h1);
  check('绝不再落回首页', a3 && a3.path !== '/home', a3 && a3.path);
  check('跨文档返回不依赖 popstate 也能正确落点', a3 && a3.hasSystemBack === true, a3 && `pop=${a3.pop}`);

  /* ② 原生壳桥接 zpSystemBack()：直达数据页，非 push 路径仍应回线路维护 */
  const b0 = await open('/pages/data?from=dispatch');
  check('原生壳桥接入口存在', b0 && b0.hasSystemBack === true, b0 && String(b0.hasSystemBack));
  await ev(`(()=>{if(typeof window.zpSystemBack==='function')window.zpSystemBack();return 1})()`); await sleep(1500);
  const b1 = await ev(SNAP);
  console.log('B 返回 ' + JSON.stringify(b1));
  check('zpSystemBack() 落到线路维护页', b1 && b1.path === '/pages/dispatch', b1 && b1.path);
  check('zpSystemBack() 不落回首页', b1 && b1.path !== '/home', b1 && b1.path);

  /* ③ popstate 路径（系统自己已退一层）：不得二次 history.back() 多退一层 */
  const c0 = await open('/pages/data?from=dispatch');
  await ev('window.zpHandleBack(true)'); await sleep(1500);
  const c1 = await ev(SNAP);
  console.log('C 返回 ' + JSON.stringify(c1));
  check('popstate 路径仍落到线路维护', c1 && c1.path === '/pages/dispatch', c1 && c1.path);
  check('popstate 路径不越过父级退回首页', c1 && c1.path !== '/home', c1 && c1.path);

  /* ④ 回归：详情 → 数据资料的编辑往返不被静态父级吞掉 */
  const d0 = await open('/pages/data?from=order&id=W9&source=process');
  check('详情编辑往返的返回目标仍是原运单',
    d0 && d0.resolve === '/pages/order_detail?id=W9&source=process&from=process', d0 && d0.resolve);

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_back_system.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
