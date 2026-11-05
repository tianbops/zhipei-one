/* 数据中心「填了地址链接却解析不出坐标」真浏览器回归（2026-11-05）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-geo-input.cjs
 *
 * 用户实测 43 家门店全部停在「未定位」。两条系统性静默失败：
 *   A) 高德 App「分享」到微信/剪贴板带文案前缀，整段不是 URL →
 *      旧版 looksResolvable / pending / autoLocate 整批跳过，不发请求也不报错；
 *   B) 失败反馈 2.6 秒自动消失、只说「N 家没取到位置」，看不到原因。
 * 这里用真点击 + fetch 拦截，锁死「文案能解析」「文字地址有提示」「失败常驻」。
 *
 * 离线不打外网：/api/store/geo 由 STUB 直接回结果。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8164);
const PORT_CDP = Number(process.env.PORT_CDP || 9344);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const SHARE_TEXT = '【高德地图】佳园路2号 https://surl.amap.com/9Xhz3TMYbR2 点击查看';
const SHARE_LINK = 'https://surl.amap.com/9Xhz3TMYbR2';
const FAIL_LINK = 'https://surl.amap.com/dead';

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
(function(){
  var isText = location.search.indexOf('case=text')>=0;
  var SHARE=${JSON.stringify(SHARE_TEXT)};
  var stores = isText ? [
    {storeId:'T1',name:'文字地址门店',navigation:'重庆市江北区佳园路2号',lat:null,lng:null,address:'',routeOrder:1,aliases:[]},
    {storeId:'T2',name:'本来就没链接',navigation:'',lat:null,lng:null,address:'',routeOrder:2,aliases:[]}
  ] : [
    {storeId:'A1',name:'带文案分享门店',navigation:SHARE,lat:null,lng:null,address:'',routeOrder:1,aliases:[]},
    {storeId:'A2',name:'短链失效门店',navigation:${JSON.stringify(FAIL_LINK)},lat:null,lng:null,address:'',routeOrder:2,aliases:[]},
    {storeId:'A3',name:'没链接门店',navigation:'',lat:null,lng:null,address:'',routeOrder:3,aliases:[]}
  ];
  window.__geo=[];window.__puts=[];
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u),m=String((o&&o.method)||'GET').toUpperCase();
    if(s.indexOf('/api/dispatch')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'一号线'}}));
    if(s.indexOf('/api/store/geo')>=0){
      var body=JSON.parse((o&&o.body)||'{}');
      var items=(body.items||[]).map(function(it){
        var text=String(it.text||'').trim();
        window.__geo.push(text);
        return text===${JSON.stringify(SHARE_LINK)}
          ? {ok:true,lat:29.600741,lng:106.525818,address:'佳园路2号'}
          : {ok:false,reason:'NO_COORD'};
      });
      return B(JSON.stringify({success:true,items:items}));
    }
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT'){
        var put=JSON.parse((o&&o.body)||'{}');window.__puts.push(put);
        return B(JSON.stringify({success:true,base:{version:2,stores:put.stores}}));
      }
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'一号线'},base:{version:1,stores:stores}}));
    }
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>{
  return {
    rows:document.querySelectorAll('.data-store-row').length,
    badges:document.querySelectorAll('.data-store-geo').length,
    hint:(document.getElementById('editGeoHint')||{}).textContent||'',
    fbText:(document.getElementById('dataFeedback')||{}).textContent||'',
    fbHidden:(document.getElementById('dataFeedback')||{}).hidden,
    fbClass:(document.getElementById('dataFeedback')||{}).className||'',
    hasRetry:[...document.querySelectorAll('.data-feedback-action')].some(b=>b.textContent==='重新识别'),
    navValues:[...document.querySelectorAll('.data-store-nav')].map(a=>a.getAttribute('href')),
    geo:window.__geo,
    puts:window.__puts,
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

  /* ===== 场景 A：带文案的分享文本 ===== */
  await C('Page.navigate', { url: BASE + '/pages/data.html?case=share' });
  await sleep(1800);
  const init = await ev(SNAP);
  console.log('A init ' + JSON.stringify(init && { rows: init.rows, badges: init.badges, navs: init.navValues }));
  check('A：3 家门店全部渲染', init && init.rows === 3, init && String(init.rows));
  check('A：初始 3 家都是「未定位」', init && init.badges === 3, init && String(init.badges));
  check('A：带文案文本不被当成可点链接', init && !init.navValues.some(v => v && v.indexOf('【高德地图】') >= 0), JSON.stringify(init && init.navValues));

  /* 编辑框粘贴带文案的分享文本 → 防抖解析成功 */
  await ev(`(()=>{document.querySelector('[data-swipe-edit="0"]').click();return 1})()`);
  await sleep(250);
  await ev(`(()=>{const i=document.getElementById('editNavigation');i.value=${JSON.stringify(SHARE_TEXT)};i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()`);
  await sleep(1100);
  const afterInput = await ev(SNAP);
  check('A：编辑框粘贴带文案文本会发起解析', afterInput && afterInput.geo.length === 1, JSON.stringify(afterInput && afterInput.geo));
  check('A：发给接口的是提取出的纯链接，不是整段文案', afterInput && afterInput.geo[0] === SHARE_LINK, JSON.stringify(afterInput && afterInput.geo));
  check('A：提示行明确显示「已定位」', afterInput && /已定位/.test(afterInput.hint), afterInput && afterInput.hint);
  await ev(`(()=>{document.getElementById('editSave').click();return 1})()`);
  await sleep(400);
  const afterSave = await ev(SNAP);
  check('A：保存后文案被规范化成纯链接（不再是不可点的整段文字）', afterSave && afterSave.navValues.some(v => v === SHARE_LINK), JSON.stringify(afterSave && afterSave.navValues));

  /* 提交更新：A2 短链失效、A3 无链接 */
  await ev(`(()=>{document.getElementById('saveStoresTop').click();return 1})()`);
  await sleep(1200);
  const done = await ev(SNAP);
  console.log('A done ' + JSON.stringify(done && { geo: done.geo, toast: done.fbText, hidden: done.fbHidden }));
  const put = done && done.puts && done.puts[0];
  check('A：提交更新发出 1 次 PUT', !!put, done && String((done.puts || []).length));
  check('A：带文案门店随 PUT 落库坐标', !!put && put.stores[0].lat === 29.600741 && put.stores[0].lng === 106.525818, put && JSON.stringify(put.stores[0]));
  check('A：提交时自动定位了失效短链门店（发过请求，不是静默跳过）', done && done.geo.includes(FAIL_LINK), JSON.stringify(done && done.geo));
  check('A：失败反馈说明具体原因（这个链接里没有坐标）', done && /NO_COORD|没有坐标/.test(done.fbText), done && done.fbText);
  check('A：失败反馈提供「重新识别」重试按钮', done && done.hasRetry === true, done && String(done.hasRetry));
  check('A：失败反馈是 error 样式', done && /error/.test(done.fbClass), done && done.fbClass);
  /* 关键：常驻不消失。旧版 2.6 秒后 hidden=true，用户根本看不到 */
  await sleep(3200);
  const later = await ev(SNAP);
  check('A：失败反馈 3 秒后仍然可见（不再 2.6 秒消失）', later && later.fbHidden === false && /没能定位/.test(later.fbText), JSON.stringify(later && { hidden: later.fbHidden, text: later.fbText }));

  /* ===== 场景 B：纯文字地址（根本没链接）===== */
  await C('Page.navigate', { url: BASE + '/pages/data.html?case=text' });
  await sleep(1800);
  const bInit = await ev(SNAP);
  check('B：2 家门店渲染', bInit && bInit.rows === 2, bInit && String(bInit.rows));
  await ev(`(()=>{document.getElementById('saveStoresTop').click();return 1})()`);
  await sleep(900);
  const bDone = await ev(SNAP);
  console.log('B done ' + JSON.stringify(bDone && { geo: bDone.geo, toast: bDone.fbText }));
  check('B：文字地址不会误发外网请求', bDone && bDone.geo.length === 0, JSON.stringify(bDone && bDone.geo));
  check('B：明确告知「不是链接（是文字地址或备注）」', bDone && /不是链接（是文字地址或备注）/.test(bDone.fbText), bDone && bDone.fbText);
  check('B：给出可操作的改法（高德分享 → 复制链接）', bDone && /分享/.test(bDone.fbText), bDone && bDone.fbText);
  await sleep(3200);
  const bLater = await ev(SNAP);
  check('B：提示常驻，不会一闪而过', bLater && bLater.fbHidden === false, JSON.stringify(bLater && bLater.fbHidden));

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_geo_input.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
