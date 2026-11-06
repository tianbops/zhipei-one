/* 门店名点击 → 地图导航目标：真浏览器验证
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-mapnav.cjs
 *
 * 为什么必须真浏览器：
 *   1) 导航能力全部落在 DOM 上（<a href> 由渲染层拼出），静态断言只能证明源码写了
 *      data-zp-nav，证明不了浏览器真的把门店名渲染成可点链接、也没被 esc 吃掉；
 *   2) 旧实现的 bug 是「纯文本 navigation 被解析成站内路径」，只有在浏览器里看
 *      a.href 才能确认真实解析结果；
 *   3) 门店名来自 OCR，必须确认带 <img onerror> 的名字不会执行；
 *   4) 成熟 H5 范式：有坐标落 /marker 位置标注页、无坐标落 /search 搜索页，
 *      都是「看位置」页，绝不用 /navigation 驾车路线页（真机会整页引导下载），
 *      是否用 App 导航由落地页里的按钮交给司机自己点。
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
/* 记录点击而不真的离开页面。
   菜单模式（window.__menuMode）下捕获阶段只计数、不 preventDefault，
   让 mapnav.js 的冒泡委托能弹出选择菜单；菜单自身会阻止默认跳转。
   window.open 被覆盖成只记录，避免三家 provider 真的打开外链。 */
window.__nav=[];window.__navOut=[];window.__menuClicks=0;
window.open=function(u){window.__navOut.push(String(u));return null;};
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[data-zp-nav]'):null;
  if(!a)return;
  if(window.__menuMode){window.__menuClicks++;return}
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
  /* 覆盖成真机 UA：导航 URL 已不再按 UA 分支，但页面其它移动端判定仍依赖它，
     保持与真机一致，确保回归看到的是真实渲染结果。 */
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
  check('高德短链不透传，改走门店名网页版搜索',
    s1.kind === 'keyword' && (() => { try { const u = new URL(s1.abs); return u.hostname === 'uri.amap.com' && u.pathname === '/search' && !/surl\.amap\.com|callnative/.test(s1.abs); } catch { return false; } })(), JSON.stringify(s1));
  const s2 = byName('渝北中景隆');
  check('纯文本 navigation 降级为高德关键词搜索',
    s2.kind === 'keyword' && new URL(s2.abs).hostname === 'uri.amap.com' &&
    new URL(s2.abs).searchParams.get('keyword') === '渝北中景隆(重庆)贸易有限公司', JSON.stringify(s2));
  const s3 = byName('江北重庆三峡');
  check('非地图域名不透传，改用门店名搜索',
    s3.kind === 'keyword' && new URL(s3.abs).hostname === 'uri.amap.com' && !/evil\.com/.test(s3.abs), JSON.stringify(s3));
  const s4 = byName('到家主城');
  check('无 navigation 用门店名搜索', s4.kind === 'keyword' && new URL(s4.abs).searchParams.get('keyword') === '到家主城-江北区加州客服中心', JSON.stringify(s4));
  check('关键词链接不带 callnative、带 src=zhipei（真机避免下载引导页）',
    !!s4.abs && new URL(s4.abs).searchParams.get('callnative') === null && new URL(s4.abs).searchParams.get('src') === 'zhipei');
  const s6 = byName('已定位门店');
  check('有坐标 → /marker 位置标注「看位置」页（不是 /navigation 驾车路线页）',
    s6.kind === 'geo' && new URL(s6.abs).pathname === '/marker' && new URL(s6.abs).searchParams.get('mode') === null, JSON.stringify(s6));
  check('position 是「经度,纬度」，顺序不得颠倒',
    s6.abs && new URL(s6.abs).searchParams.get('position') === '106.551200,29.563100', s6.abs && new URL(s6.abs).searchParams.get('position'));
  check('位置页带 name=门店名、不带 callnative（不主动拉起 App）',
    s6.abs && new URL(s6.abs).searchParams.get('name') === '已定位门店' && new URL(s6.abs).searchParams.get('callnative') === null, s6.abs);
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
  check('详情页高德短链同样不透传（全表无 surl.amap.com）',
    detail && detail.items.every((x) => !/surl\.amap\.com|callnative|callAPP/.test(x.abs)) &&
    detail.items.some((x) => x.kind === 'keyword' && /uri\.amap\.com\/search/.test(x.abs)),
    JSON.stringify(detail && detail.items.map((x) => x.abs)));
  check('详情页触控热区 ≥44px', detail && detail.items.every((x) => x.box >= 44), detail && JSON.stringify(detail.items.map((x) => x.box)));
  check('详情页门店名注入被转义', detail && detail.injectedImg === false && detail.xss === false);

  /* ===== 每次点门店名弹菜单：高德 / 百度 / 腾讯 ===== */
  await C('Page.navigate', { url: BASE + '/home.html?case=mapnav-menu' });
  await sleep(1700);
  const menuSetup = await ev(`(()=>{
    window.__menuMode=true;window.__menuClicks=0;window.__navOut=[];
    const as=[...document.querySelectorAll('#todayStoreList a[data-zp-nav-payload]')];
    as.forEach(a=>{a.setAttribute('target','_blank');a.setAttribute('href','#probe')});
    return as.length;
  })()`);
  check('6 家门店都带 data-zp-nav-payload 载荷', menuSetup === 6, String(menuSetup));

  const payloads = await ev(`(()=>[...document.querySelectorAll('#todayStoreList a[data-zp-nav-payload]')].map(a=>{
    try{return {p:JSON.parse(a.getAttribute('data-zp-nav-payload'))}}catch(e){return {err:String(e)}}
  }))()`);
  check('菜单载荷全部可反解且只含 name/lat/lng/link',
    Array.isArray(payloads) && payloads.length === 6 && payloads.every(x => x.p && !x.err &&
      Object.keys(x.p).sort().join(',') === 'lat,link,lng,name'), JSON.stringify(payloads && payloads.slice(0, 2)));
  check('已定位门店载荷带精确坐标、不带地址文本',
    Array.isArray(payloads) && payloads.some(x => x.p && x.p.lat === 29.5631 && x.p.lng === 106.5512),
    JSON.stringify(payloads && payloads.map(x => x.p && [x.p.lat, x.p.lng])));

  const MENU = `(()=>({sheet:!!document.querySelector('.zp-mn-sheet'),
    rows:[...document.querySelectorAll('.zp-mn-row[data-provider]')].map(r=>r.dataset.provider),
    title:(document.querySelector('.zp-mn-title')||{}).textContent||'',
    sub:(document.querySelector('.zp-mn-sub')||{}).textContent||'',
    open:document.body.classList.contains('zp-mn-open')}))()`;
  const clickStore = async (idx) => {
    await ev(`(()=>{const a=[...document.querySelectorAll('#todayStoreList a[data-zp-nav-payload]')][${idx}];
      const n=a&&a.querySelector('.today-store-name');if(n)n.click();return 1})()`);
    await sleep(140);
  };
  const pick = async (id) => {
    await ev(`(()=>{const r=document.querySelector('.zp-mn-row[data-provider="${id}"]');if(r)r.click();return 1})()`);
    await sleep(140);
  };

  await clickStore(5);   /* S6：已定位门店 */
  const m1 = await ev(MENU);
  check('点门店名弹出底部菜单', m1 && m1.sheet === true && m1.open === true, JSON.stringify(m1));
  check('菜单固定列高德 / 百度 / 腾讯三家', m1 && m1.rows.join(',') === 'amap,baidu,qq', JSON.stringify(m1 && m1.rows));
  check('已定位门店菜单标注「已绑定精确坐标」',
    m1 && /已绑定精确坐标/.test(m1.sub) && /导航到/.test(m1.title), JSON.stringify(m1));

  await pick('amap');
  const out1 = await ev('window.__navOut');
  check('选高德 → uri.amap.com/marker 位置页「看位置」，且 position 经度在前',
    Array.isArray(out1) && out1.length === 1 && (() => { try { const u = new URL(out1[0]); return u.pathname === '/marker' && (u.searchParams.get('position') || '').startsWith('106.551200,29.563100') && !/\/navigation/.test(out1[0]); } catch { return false; } })(),
    JSON.stringify(out1));
  check('选高德后 URL 不含 /navigation / callnative / 下载引导域名',
    Array.isArray(out1) && out1.length === 1 && !/\/navigation|callnative|surl\.amap|callAPP|ap\.amap|wap\.amap/.test(out1[0]), JSON.stringify(out1));
  check('选完菜单自动关闭', (await ev(`!document.querySelector('.zp-mn-sheet')`)) === true);

  await clickStore(5);
  await pick('baidu');
  const out2 = await ev('window.__navOut');
  check('选百度 → api.map.baidu.com/marker 位置页（不再是 /direction 路线页）',
    Array.isArray(out2) && out2.length === 2 && (() => { try { const u = new URL(out2[1]); return u.hostname === 'api.map.baidu.com' && u.pathname === '/marker' && (u.searchParams.get('location') || '').startsWith('29.563100,106.551200'); } catch { return false; } })(),
    JSON.stringify(out2));
  check('选百度 → 带门店名与 coord_type=gcj02，且不含 /direction 驾车参数',
    Array.isArray(out2) && out2.length === 2 && (() => { try { const u = new URL(out2[1]); return u.searchParams.get('title') === '已定位门店' && u.searchParams.get('coord_type') === 'gcj02' && !/\/direction|mode=driving/.test(out2[1]); } catch { return false; } })(),
    JSON.stringify(out2));

  await clickStore(5);
  await pick('qq');
  const out3 = await ev('window.__navOut');
  check('选腾讯 → mapapi.qq.com 的 locationMarker 位置页（不再是地图首页）',
    Array.isArray(out3) && out3.length === 3 && (() => { try { const u = new URL(out3[2]); return u.hostname === 'mapapi.qq.com' && u.pathname === '/web/mapComponents/locationMarker/v/index.html' && (u.searchParams.get('marker') || '').startsWith('coord:29.563100,106.551200;title:已定位门店'); } catch { return false; } })(),
    JSON.stringify(out3));
  check('选腾讯 → 不再落到 map.qq.com/?what= 首页',
    Array.isArray(out3) && out3.length === 3 && !/map\.qq\.com\/\?/.test(out3[2]), JSON.stringify(out3));

  await clickStore(1);   /* S2：纯文本 navigation，未定位 */
  const m2 = await ev(MENU);
  check('未定位门店菜单提示「按门店名搜索」', m2 && /暂无坐标/.test(m2.sub), JSON.stringify(m2));
  await pick('amap');
  const out4 = await ev('window.__navOut');
  check('未定位门店选高德 → 关键词搜索（不拼 0,0）',
    Array.isArray(out4) && out4.length === 4 && (() => { try { const u = new URL(out4[3]); return u.pathname === '/search' && u.searchParams.get('keyword') === '渝北中景隆(重庆)贸易有限公司'; } catch { return false; } })(),
    JSON.stringify(out4));

  /* 真机回归：门店存了高德短链但没解析出坐标时，选高德也不能把短链交出去，
     否则 m.amap.com/callAPP 中转页会在未装 App 时整页跳「立即下载高德」。 */
  await clickStore(0);   /* S1：带高德短链、未定位 */
  await pick('amap');
  const out5 = await ev('window.__navOut');
  check('有高德短链但未定位 → 选高德仍走网页版搜索（下载引导页回归）',
    Array.isArray(out5) && out5.length === 5 && (() => { try { const u = new URL(out5[4]); return u.pathname === '/search' && !/surl\.amap|callnative|callAPP|ap\.amap|wap\.amap/.test(out5[4]); } catch { return false; } })(),
    JSON.stringify(out5));

  await clickStore(5);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(120);
  check('Escape 关闭菜单', (await ev(`!document.querySelector('.zp-mn-sheet')`)) === true);

  await clickStore(5);
  await ev(`(()=>{const bg=document.querySelector('.zp-mn-bg');if(bg)bg.click();return 1})()`);
  await sleep(120);
  check('点遮罩关闭菜单', (await ev(`!document.querySelector('.zp-mn-sheet')`)) === true);

  check('菜单注册 rank 8 返回钩子（系统返回先关菜单）',
    (await ev(`(window.zpBackHooks||[]).some(h=>h&&h.rank===8)`)) === true);

  const suppress = await ev(`(()=>{
    window.__menuMode=false;
    const a=[...document.querySelectorAll('#todayStoreList a[data-zp-nav-payload]')][5];
    const n=a&&a.querySelector('.today-store-name');if(!n)return 'no-anchor';
    const guard=e=>e.preventDefault();
    document.addEventListener('click',guard,{capture:true,once:true});
    n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
    return !document.querySelector('.zp-mn-sheet');
  })()`);
  check('业务已 preventDefault 的点击不弹菜单（不抢手势 / e2e 捕获阶段点击）',
    suppress === true, String(suppress));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
