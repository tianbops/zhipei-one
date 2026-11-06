/* 数据中心「三家导航链接录入」真浏览器回归（2026-11-06）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-geo-providers.cjs
 *
 * 需求：数据中心基准门店设置里的「导航地址」不再只认高德，高德 / 百度 /
 * 腾讯任意一家的分享链接都能解析出坐标；百度 POI 短链（j.map.baidu.com）
 * 由服务端按移动端 UA 展开详情页取坐标，同样能定位。
 *
 * 这里用真点击 + fetch 桩，锁死四条：
 *   A) 四家链接都进入 /api/store/geo（不被 looksResolvable / navUrlOf 跳过）；
 *   B) 高德 / 腾讯 / 百度长链 / 百度短链全部解析成功并随 PUT 落库；
 *   C) 四家全部定位成功、无失败反馈、无「未定位」角标；
 *   D) 录入位文案明示三家、不再出现「只认高德」。
 *
 * 离线不打外网：/api/store/geo 由 STUB 直接回结果（服务端坐标换算已由
 * tests/store-geo-parse.test.mjs 的 106 条单测覆盖，这里只验前端接线）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8171);
const PORT_CDP = Number(process.env.PORT_CDP || 9351);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 与服务端 parseUrl 结果一致的坐标（GCJ-02） */
const AMAP_LINK = 'https://surl.amap.com/9Xhz3TMYbR2';
const QQ_LINK = 'https://mmapgwh.map.qq.com/shortlink/short?l=_9af4fe8c1d84611994475b57cc198a43';
const BAIDU_LONG = 'https://map.baidu.com/@120.144441,30.222489,18z';
const BAIDU_SHORT = 'https://j.map.baidu.com/6f/7C-k';

const GEO = {
  [AMAP_LINK]: { ok: true, lat: 29.600741, lng: 106.525818, kind: 'amap-share' },
  [QQ_LINK]: { ok: true, lat: 30.216492, lng: 120.13792, kind: 'qq-share' },
  [BAIDU_LONG]: { ok: true, lat: 30.216498, lng: 120.137939, kind: 'baidu-at' },
  [BAIDU_SHORT]: { ok: true, lat: 30.216514, lng: 120.137928, kind: 'baidu-html-mc' },
};

const STORES = [
  { storeId: 'P1', name: '高德来源门店', navigation: AMAP_LINK, lat: null, lng: null, address: '', routeOrder: 1, aliases: [] },
  { storeId: 'P2', name: '腾讯来源门店', navigation: QQ_LINK, lat: null, lng: null, address: '', routeOrder: 2, aliases: [] },
  { storeId: 'P3', name: '百度长链门店', navigation: BAIDU_LONG, lat: null, lng: null, address: '', routeOrder: 3, aliases: [] },
  { storeId: 'P4', name: '百度短链门店', navigation: BAIDU_SHORT, lat: null, lng: null, address: '', routeOrder: 4, aliases: [] },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
(function(){
  var GEO=${JSON.stringify(GEO)};
  var STORES=${JSON.stringify(STORES)};
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
        return GEO[text]||{ok:false,reason:'NO_COORD'};
      });
      return B(JSON.stringify({success:true,items:items}));
    }
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT'){
        var put=JSON.parse((o&&o.body)||'{}');window.__puts.push(put);
        return B(JSON.stringify({success:true,base:{version:2,stores:put.stores}}));
      }
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'一号线'},base:{version:1,stores:STORES}}));
    }
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>{
  return {
    rows:document.querySelectorAll('.data-store-row').length,
    badges:document.querySelectorAll('.data-store-geo').length,
    placeholder:(document.getElementById('editNavigation')||{}).placeholder||'',
    hint:(document.getElementById('editGeoHint')||{}).textContent||'',
    appendPlaceholder:(document.getElementById('appendNavigation')||{}).placeholder||'',
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

  await C('Page.navigate', { url: BASE + '/pages/data.html' });
  await sleep(1800);
  const init = await ev(SNAP);
  console.log('init ' + JSON.stringify(init && { rows: init.rows, badges: init.badges }));
  check('四家门店全部渲染', init && init.rows === 4, init && String(init.rows));
  check('初始四家都是「未定位」', init && init.badges === 4, init && String(init.badges));
  check('编辑框 placeholder 明示三家', init && /高德/.test(init.placeholder) && /百度/.test(init.placeholder) && /腾讯/.test(init.placeholder), init && init.placeholder);
  check('追加框 placeholder 明示三家', init && /高德/.test(init.appendPlaceholder) && /百度/.test(init.appendPlaceholder) && /腾讯/.test(init.appendPlaceholder), init && init.appendPlaceholder);
  check('录入位不再出现「只认高德」', init && !/只认高德/.test(init.placeholder + init.hint + init.appendPlaceholder), init && init.hint);

  /* 提交更新：四家链接都应进入解析并全部成功 */
  await ev(`(()=>{document.getElementById('saveStoresTop').click();return 1})()`);
  await sleep(1400);
  const done = await ev(SNAP);
  console.log('done ' + JSON.stringify(done && { geo: done.geo, toast: done.fbText }));
  check('高德链接进入解析请求', done && done.geo.includes(AMAP_LINK), JSON.stringify(done && done.geo));
  check('腾讯链接进入解析请求', done && done.geo.includes(QQ_LINK), JSON.stringify(done && done.geo));
  check('百度带坐标长链进入解析请求', done && done.geo.includes(BAIDU_LONG), JSON.stringify(done && done.geo));
  check('百度 POI 短链也进入解析请求（不静默跳过）', done && done.geo.includes(BAIDU_SHORT), JSON.stringify(done && done.geo));

  const put = done && done.puts && done.puts[0];
  check('提交更新发出 1 次 PUT', !!put, done && String((done.puts || []).length));
  const byName = put && Object.fromEntries((put.stores || []).map(s => [s.name, s]));
  check('高德来源门店落库 GCJ-02 坐标', byName && byName['高德来源门店'].lat === 29.600741 && byName['高德来源门店'].lng === 106.525818, put && JSON.stringify(byName && byName['高德来源门店']));
  check('腾讯来源门店落库 GCJ-02 坐标', byName && byName['腾讯来源门店'].lat === 30.216492 && byName['腾讯来源门店'].lng === 120.13792, put && JSON.stringify(byName && byName['腾讯来源门店']));
  check('百度长链门店落库换算后的 GCJ-02 坐标', byName && byName['百度长链门店'].lat === 30.216498 && byName['百度长链门店'].lng === 120.137939, put && JSON.stringify(byName && byName['百度长链门店']));
  check('百度短链门店落库换算后的 GCJ-02 坐标', byName && byName['百度短链门店'].lat === 30.216514 && byName['百度短链门店'].lng === 120.137928, put && JSON.stringify(byName && byName['百度短链门店']));
  check('四家全部定位成功、无失败反馈文案', done && !/没取到坐标|没能定位|短链不含坐标/.test(done.fbText), done && done.fbText);
  check('不出现「重新识别」重试按钮', done && done.hasRetry === false, done && String(done.hasRetry));
  check('四家门店都不再显示「未定位」', done && done.badges === 0, done && String(done.badges));

  /* 编辑框单独粘腾讯链接 → 防抖解析成功（三家链接在编辑态同样可用） */
  await ev(`(()=>{document.querySelector('[data-swipe-edit="1"]').click();return 1})()`);
  await sleep(250);
  const beforeQq = (await ev(SNAP)).geo.length;
  await ev(`(()=>{const i=document.getElementById('editNavigation');i.value=${JSON.stringify(QQ_LINK)};i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()`);
  await sleep(1100);
  const afterQq = await ev(SNAP);
  check('编辑框粘贴腾讯链接会发起解析', afterQq && afterQq.geo.length === beforeQq + 1, JSON.stringify(afterQq && afterQq.geo));
  check('编辑框腾讯链接显示「已定位」', afterQq && /已定位/.test(afterQq.hint), afterQq && afterQq.hint);
  /* 换成百度短链 → 同样显示「已定位」（服务端已能解析 POI 短链） */
  await ev(`(()=>{const i=document.getElementById('editNavigation');i.value=${JSON.stringify(BAIDU_SHORT)};i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()`);
  await sleep(1100);
  const afterBd = await ev(SNAP);
  check('编辑框百度短链会发起解析', afterBd && afterBd.geo.length === afterQq.geo.length + 1, JSON.stringify(afterBd && afterBd.geo));
  check('编辑框百度短链显示「已定位」', afterBd && /已定位/.test(afterBd.hint), afterBd && afterBd.hint);
  check('编辑框百度短链不再提示换链或未知原因', afterBd && !/短链不含坐标|未知原因/.test(afterBd.hint), afterBd && afterBd.hint);

  /* 关闭编辑框，截列表态：四家门店全部已定位、无「未定位」角标 */
  await ev(`(()=>{var b=document.getElementById('editCancel');if(b)b.click();return 1})()`);
  await sleep(400);
  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_geo_providers.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
