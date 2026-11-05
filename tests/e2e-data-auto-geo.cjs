/* 数据中心「粘贴链接 → 保存 → 自动定位 → 全局导航」整链路：真浏览器验证
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-auto-geo.cjs
 *
 * 为什么必须真浏览器：
 *   1) 这条链路的关键是「用户不点解析」也能出坐标 —— 只有真的改 value、派发 input、
 *      真的点保存，才能证明防抖与保存兜底这两条路都通；
 *   2) 坐标是否写进 PUT 请求体，静态断言看不出来，必须在 fetch 层截获；
 *   3) 上一轮的 (0,0) 陷阱（null 被 Number() 变成 0）只在真实数据里才暴露：
 *      后端回的是 lat:null，页面必须判成「未定位」，否则永远不再解析。
 *
 * 离线环境不打外网：/api/store/geo 由 STUB 直接回坐标。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8154);
const PORT_CDP = Number(process.env.PORT_CDP || 9334);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 两家门店都没有坐标（后端 normalizeStore 会把缺失写成 lat:null）：
   S1 已有旧链接，S2 完全没有链接。 */
const STORES = [
  { storeId: 'S1', name: '谊品生鲜长安锦绣城店', navigation: 'https://surl.amap.com/old1', lat: null, lng: null, address: '', routeOrder: 1, aliases: [] },
  { storeId: 'S2', name: '渝北中景隆贸易', navigation: '', lat: null, lng: null, address: '', routeOrder: 2, aliases: [] },
  /* S3 有链接但没坐标，且这次没人编辑它 —— 提交时必须靠自动定位兜住 */
  { storeId: 'S3', name: '到家主城加州客服中心', navigation: 'https://surl.amap.com/new3', lat: null, lng: null, address: '', routeOrder: 3, aliases: [] },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
(function(){
  var stores=${JSON.stringify(STORES)};
  window.__geo=[];
  window.__puts=[];
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  var MAP={'https://surl.amap.com/9Xhz3TMYbR2':{lat:29.600741,lng:106.525818,address:'佳园路2号'},'https://surl.amap.com/new2':{lat:29.6102,lng:106.5743,address:'渝北区龙溪街道'},'https://surl.amap.com/new3':{lat:29.5807,lng:106.5301,address:'江北区建新北路'}};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u),m=String((o&&o.method)||'GET').toUpperCase();
    if(s.indexOf('/api/dispatch')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'一号线'}}));
    if(s.indexOf('/api/store/geo')>=0){
      var body=JSON.parse((o&&o.body)||'{}');
      var items=(body.items||[]).map(function(it){
        var hit=MAP[String(it.text||'').trim()];
        window.__geo.push({text:it.text,hit:!!hit});
        return hit?{ok:true,lat:hit.lat,lng:hit.lng,address:hit.address}:{ok:false,reason:'NO_COORD'};
      });
      return B(JSON.stringify({success:true,items:items}));
    }
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT'){
        var put=JSON.parse((o&&o.body)||'{}');
        window.__puts.push(put);
        return B(JSON.stringify({success:true,base:{version:2,stores:put.stores}}));
      }
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'一号线'},base:{version:1,stores:stores}}));
    }
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>{
  const rows=[...document.querySelectorAll('.data-store-row')];
  return {
    rows:rows.length,
    badges:document.querySelectorAll('.data-store-geo').length,
    hasBatchBtn: !!document.getElementById('batchGeoBtn'),
    hasNavInput: !!document.getElementById('editNavigation'),
    hasGeoInput: !!document.getElementById('editGeo'),
    hint: (document.getElementById('editGeoHint')||{}).textContent||'',
    toast: (document.getElementById('dataFeedback')||{}).textContent||'',
    geo: window.__geo,
    puts: window.__puts,
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
  await C('Page.navigate', { url: BASE + '/pages/data.html' });
  await sleep(1800);

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  const init = await ev(SNAP);
  console.log('init ' + JSON.stringify(init && { rows: init.rows, badges: init.badges, hasBatchBtn: init.hasBatchBtn }));
  check('门店列表渲染 3 家', init && init.rows === 3, init && String(init.rows));
  check('lat 为 null 时判为未定位（不被 Number(null)=0 骗过）', init && init.badges === 3, init && String(init.badges));
  check('「批量定位」按钮已下线（定位并入保存流程）', init && init.hasBatchBtn === false);
  check('编辑面板只留「导航地址」一个输入（无独立位置框）', init && init.hasNavInput === true && init.hasGeoInput === false);

  /* 路径 A：粘贴链接后立刻保存（0.45s 防抖还没跑），靠保存兜底拿坐标 */
  await ev(`(()=>{document.querySelector('[data-swipe-edit="0"]').click();return !!document.getElementById('editBox')})()`);
  await sleep(300);
  await ev(`(()=>{const i=document.getElementById('editNavigation');i.value='https://surl.amap.com/9Xhz3TMYbR2';i.dispatchEvent(new Event('input',{bubbles:true}));return i.value})()`);
  await ev(`(()=>{document.getElementById('editSave').click();return 1})()`);
  await sleep(900);
  const afterSave = await ev(SNAP);
  console.log('afterSave ' + JSON.stringify(afterSave && { badges: afterSave.badges, geo: afterSave.geo }));
  check('保存时自动解析（未点任何「解析」按钮）', afterSave && afterSave.geo.length === 1 && afterSave.geo[0].hit === true, JSON.stringify(afterSave && afterSave.geo));
  check('解析成功后门店不再显示「未定位」', afterSave && afterSave.badges === 2, afterSave && String(afterSave.badges));

  /* 路径 B：只粘贴、不保存，防抖到点后自动解析（S2 无链接） */
  await ev(`(()=>{document.querySelector('[data-swipe-edit="1"]').click();return 1})()`);
  await sleep(250);
  await ev(`(()=>{const i=document.getElementById('editNavigation');i.value='https://surl.amap.com/new2';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
  await sleep(1100);
  const debounced = await ev(SNAP);
  check('粘贴后不点保存也会自动解析（input 防抖）', debounced && debounced.geo.length === 2, JSON.stringify(debounced && debounced.geo));
  check('提示行直接告诉管理员「已定位」', debounced && /已定位/.test(debounced.hint), debounced && debounced.hint);
  await ev(`(()=>{document.getElementById('editSave').click();return 1})()`);
  await sleep(500);

  /* 提交更新：坐标必须随 PUT 一起落库 */
  await ev(`(()=>{document.getElementById('saveStoresTop').click();return 1})()`);
  await sleep(1200);
  const done = await ev(SNAP);
  console.log('done ' + JSON.stringify(done && { puts: (done.puts || []).length, toast: done.toast }));
  const put = done && done.puts && done.puts[0];
  check('提交更新发出 1 次 PUT', !!put, done && String((done.puts || []).length));
  check('PUT 里 S1 带坐标与门牌地址（用户给的真实「分享位置」短链）',
    !!put && put.stores[0].lat === 29.600741 && put.stores[0].lng === 106.525818 && put.stores[0].address === '佳园路2号',
    put && JSON.stringify(put.stores[0]));
  check('PUT 里 S2 带坐标（第二个输入框的值也进了提交）',
    !!put && put.stores[1].lat === 29.6102 && put.stores[1].lng === 106.5743, put && JSON.stringify(put.stores[1]));
  check('没被编辑过的 S3 在提交时被自动补上坐标',
    !!put && put.stores[2].lat === 29.5807 && put.stores[2].lng === 106.5301 && put.stores[2].address === '江北区建新北路',
    put && JSON.stringify(put.stores[2]));
  check('保存后给管理员明确反馈（含「已自动定位 1 家」）', done && /已自动定位 1 家/.test(done.toast), done && done.toast);

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_auto_geo.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
