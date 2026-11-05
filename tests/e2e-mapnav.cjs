/* 门店名点击 → 地图导航目标：真浏览器验证
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-mapnav.cjs
 *
 * 为什么必须真浏览器：
 *   1) 导航能力全部落在 DOM 上（<a href> 由渲染层拼出），静态断言只能证明源码写了
 *      data-zp-nav，证明不了浏览器真的把门店名渲染成可点链接、也没被 esc 吃掉；
 *   2) 旧实现的 bug 是「纯文本 navigation 被解析成站内路径」，只有在浏览器里看
 *      a.href 才能确认真实解析结果；
 *   3) 门店名来自 OCR，必须确认带 <img onerror> 的名字不会执行。
 *
 * 离线环境不真的跳外网：捕获阶段监听 a[data-zp-nav]，记录 href 后 preventDefault。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8153);
const PORT_CDP = Number(process.env.PORT_CDP || 9333);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 六家门店覆盖：高德链 / 纯文本 / 外域链接 / 无导航 / 带注入标签的名称 / 已定位（有坐标） */
const STORES = [
  { storeId: 'S1', name: '谊品生鲜长安锦绣城店', navigation: 'https://surl.amap.com/abc' },
  { storeId: 'S2', name: '渝北中景隆(重庆)贸易有限公司', navigation: 'A栋B1' },
  { storeId: 'S3', name: '江北重庆三峡融资担保集团', navigation: 'https://evil.com/x' },
  { storeId: 'S4', name: '到家主城-江北区加州客服中心', navigation: '' },
  { storeId: 'S5', name: '<img src=x onerror="window.__x=1">特渠部', navigation: '' },
  { storeId: 'S6', name: '已定位门店', navigation: 'https://surl.amap.com/xyz', lat: 29.5631, lng: 106.5512 },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
try{localStorage.clear()}catch(e){}
(function(){
  var stores=${JSON.stringify(STORES)};
  var today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  var wb={id:'w-e2e',routeId:'r1',date:today,stores:stores,summary:{finalCount:stores.length,total:stores.length},totalWeight:1.331};
  var real=window.fetch;
  window.fetch=function(u,o){
    var s=String(u&&u.url||u);
    var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
    if(s.indexOf('/api/home-bootstrap')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'测试线路'},user:{boundRouteId:'r1'}}));
    if(s.indexOf('/api/waybills/latest')>=0)return B(JSON.stringify({success:true,waybill:wb,dayCount:1}));
    if(s.indexOf('/api/history')>=0)return B(JSON.stringify({success:true,waybills:[wb],history:[],routeId:'r1'}));
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();
/* 记录点击而不真的离开页面 */
window.__nav=[];
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[data-zp-nav]'):null;
  if(!a)return;
  e.preventDefault();
  window.__nav.push({href:a.getAttribute('href'),abs:a.href,target:a.target,kind:a.dataset.zpNav,name:a.dataset.zpNavName,text:(a.textContent||'').trim().slice(0,12)});
},true);`;

const SNAP_HOME = `(()=>{
  const rows=[...document.querySelectorAll('#todayStoreList .today-store-row')];
  const links=[...document.querySelectorAll('#todayStoreList a[data-zp-nav]')];
  return {
    rows:rows.length,
    links:links.length,
    items:links.map(a=>({href:a.getAttribute('href'),abs:a.href,target:a.target,rel:a.rel,kind:a.dataset.zpNav,name:a.dataset.zpNavName,label:a.getAttribute('aria-label')||''})),
    injectedImg: !!document.querySelector('#todayStoreList img'),
    xss: window.__x===1,
    plainRows: rows.filter(r=>r.tagName!=='A').length
  };
})()`;

const SNAP_DETAIL = `(()=>{
  const links=[...document.querySelectorAll('#routeList a.order-store-name')];
  return {
    links:links.length,
    items:links.map(a=>({href:a.getAttribute('href'),abs:a.href,kind:a.dataset.zpNav,name:a.dataset.zpNavName,box:Math.round(a.getBoundingClientRect().height)})),
    injectedImg: !!document.querySelector('#routeList img'),
    xss: window.__x===1
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
  const ev = async (s) => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { err: String(r.exceptionDetails.text).slice(0, 160) }; return r.result.value; };

  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  /* 必须同时覆盖 UA：isMobile() 读 navigator.userAgent，只改 metrics 会让关键词链接
     少掉 callnative（桌面 UA 行为），与真机不一致。 */
  await C('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(600);
  await ev('try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}');
  await C('Page.navigate', { url: BASE + '/home.html?case=mapnav' });
  await sleep(1800);
  const home = await ev(SNAP_HOME);
  await C('Page.captureScreenshot', { format: 'png' });
  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'home_mapnav.png'), Buffer.from(shot.data, 'base64'));

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  console.log('home ' + JSON.stringify(home));
  check('首页 6 家门店全部渲染', home && home.rows === 6, home && String(home.rows));
  check('6 家全部可点（无导航链接的门店也不留死行）', home && home.links === 6 && home.plainRows === 0, home && `${home.links}/${home.plainRows}`);
  check('没有站内相对路径（旧 bug：纯文本被当成站内链接）',
    home && home.items.every((x) => /^https:\/\//.test(x.abs) && !x.abs.startsWith(BASE)), home && JSON.stringify(home.items.map((x) => x.abs)));
  check('没有 javascript: / data: 伪协议', home && home.items.every((x) => !/^(javascript|data):/i.test(x.href)));

  const byName = (n) => (home.items || []).find((x) => (x.name || '').indexOf(n) > -1) || {};
  const s1 = byName('谊品生鲜');
  check('高德短链原样透传', s1.kind === 'link' && s1.abs === 'https://surl.amap.com/abc', JSON.stringify(s1));
  const s2 = byName('渝北中景隆');
  check('纯文本 navigation 降级为高德关键词搜索',
    s2.kind === 'keyword' && new URL(s2.abs).hostname === 'uri.amap.com' &&
    new URL(s2.abs).searchParams.get('keyword') === '渝北中景隆(重庆)贸易有限公司', JSON.stringify(s2));
  const s3 = byName('江北重庆三峡');
  check('非地图域名不透传，改用门店名搜索',
    s3.kind === 'keyword' && new URL(s3.abs).hostname === 'uri.amap.com' && !/evil\.com/.test(s3.abs), JSON.stringify(s3));
  const s4 = byName('到家主城');
  check('无 navigation 用门店名搜索', s4.kind === 'keyword' && new URL(s4.abs).searchParams.get('keyword') === '到家主城-江北区加州客服中心', JSON.stringify(s4));
  check('关键词链接带 callnative=1 与 src=zhipei',
    !!s4.abs && new URL(s4.abs).searchParams.get('callnative') === '1' && new URL(s4.abs).searchParams.get('src') === 'zhipei');
  const s6 = byName('已定位门店');
  check('有坐标 → 直接进驾车路线（navigation），不再停在 POI 页',
    s6.kind === 'geo' && new URL(s6.abs).pathname === '/navigation' && new URL(s6.abs).searchParams.get('mode') === 'car', JSON.stringify(s6));
  check('to 参数是「经度,纬度,名称」，顺序不得颠倒',
    s6.abs && new URL(s6.abs).searchParams.get('to') === '106.551200,29.563100,已定位门店', s6.abs && new URL(s6.abs).searchParams.get('to'));
  check('普通环境 target=_self', home.items.every((x) => x.target === '_self'));
  check('aria-label 说明「导航到 门店名」', !!s1.label && /导航到/.test(s1.label), s1.label);
  check('门店名里的 <img onerror> 被转义，未执行', home && home.injectedImg === false && home.xss === false);

  /* 点店铺名（不是点链接边缘）：确实落在 <a> 上并被记录 */
  await ev(`(()=>{const a=[...document.querySelectorAll('#todayStoreList a[data-zp-nav]')][1];const n=a.querySelector('.today-store-name');n.click();return window.__nav.length})()`);
  const clicks = await ev('window.__nav');
  check('点门店名会触发导航链接', Array.isArray(clicks) && clicks.length === 1 && clicks[0].kind === 'keyword', JSON.stringify(clicks));
  check('点击目标与渲染出的 href 一致', Array.isArray(clicks) && clicks[0] && clicks[0].href === s2.href, JSON.stringify(clicks && clicks[0]));

  /* 详情页：同一个 render.js，必须同样可点且热区 ≥44 */
  await C('Page.navigate', { url: BASE + '/pages/order_detail.html?id=w-e2e' });
  await sleep(1800);
  const detail = await ev(SNAP_DETAIL);
  console.log('detail ' + JSON.stringify(detail));
  check('详情页门店名可点（6 个链接）', detail && detail.links === 6, detail && String(detail.links));
  check('详情页高德短链同样透传', detail && detail.items.some((x) => x.abs === 'https://surl.amap.com/abc'));
  check('详情页触控热区 ≥44px', detail && detail.items.every((x) => x.box >= 44), detail && JSON.stringify(detail.items.map((x) => x.box)));
  check('详情页门店名注入被转义', detail && detail.injectedImg === false && detail.xss === false);

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
