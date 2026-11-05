/* 数据中心返回 → 线路维护页：真浏览器回归（2026-11-05）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-back.cjs
 *
 * 为什么必须真浏览器：返回目标由 js/ui/back.js 的 zpResolveBack 算，
 * 但用户按的是顶栏箭头，中间还隔着 .app-back 的全局点击接管、
 * zpBackHooks 弹层阶梯、zpDirtyProbes 未保存拦截。静态断言只能证明
 * 「算出来是 /pages/dispatch」，证明不了「点一下真的落到线路维护页」。
 * 这里真派发 click，检查导航后的 pathname 与页面标题。
 *
 * 离线环境不打外网：/api/dispatch 与 /api/base 由 STUB 直接回数据。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8161);
const PORT_CDP = Number(process.env.PORT_CDP || 9341);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const STORES = [{ storeId: 'S1', name: '谊品生鲜长安锦绣城店', navigation: '', lat: null, lng: null, address: '', routeOrder: 1, aliases: [] }];
const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
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
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>({
  path:location.pathname+location.search,
  resolve:(typeof window.zpResolveBack==='function')?window.zpResolveBack():null,
  backHref:(document.querySelector('.app-back')||{}).getAttribute?(document.querySelector('.app-back').getAttribute('href')||''):'',
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

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
  const open = async (p) => { await C('Page.navigate', { url: BASE + p }); await sleep(1300); return ev(SNAP); };
  const clickBack = async () => { await ev(`(()=>{const b=document.querySelector('.app-back');if(b)b.click();return 1})()`); await sleep(1300); return ev(SNAP); };

  /* ① 无来源直接打开数据中心：默认归属线路维护 */
  const s1 = await open('/pages/data');
  console.log('init ' + JSON.stringify(s1));
  check('无来源时返回目标算出来是线路维护', s1 && s1.resolve === '/pages/dispatch', s1 && s1.resolve);
  check('顶栏返回箭头 href 指向线路维护', s1 && s1.backHref === '/pages/dispatch', s1 && s1.backHref);
  const s2 = await clickBack();
  console.log('afterBack ' + JSON.stringify(s2));
  check('点顶栏返回真的落到线路维护页', s2 && s2.path === '/pages/dispatch', s2 && s2.path);
  check('落地页面标题是「线路维护」', s2 && s2.h1 === '线路维护', s2 && s2.h1);

  /* ② 从线路维护页点进来的标准链路（带 from=dispatch） */
  const s3 = await open('/pages/data?from=dispatch');
  check('带 from=dispatch 时返回目标仍是线路维护', s3 && s3.resolve === '/pages/dispatch', s3 && s3.resolve);
  const s4 = await clickBack();
  check('带 from=dispatch 时点返回也落到线路维护页', s4 && s4.path === '/pages/dispatch', s4 && s4.path);

  /* ③ 未登记来源不得把用户丢回首页 */
  const s5 = await open('/pages/data?from=constructor');
  check('未登记来源仍回线路维护，不回首页', s5 && s5.resolve === '/pages/dispatch', s5 && s5.resolve);

  /* ④ 不能破坏「运单详情 → 数据中心 → 回原运单」的编辑往返 */
  const s6 = await open('/pages/data?from=order&id=W9&source=process');
  check('详情编辑往返仍回原运单（静态父级不得吞掉）',
    s6 && s6.resolve === '/pages/order_detail?id=W9&source=process&from=process', s6 && s6.resolve);

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_back.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
