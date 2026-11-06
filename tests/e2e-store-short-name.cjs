/* 门店简称 · 真浏览器回归（2026-11-06）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-store-short-name.cjs
 *
 * 需求：原来的「手动追加别名」入口取消，改为「门店简称」，只改变运单显示：
 *   1) 数据中心编辑面板只有简称输入，自动别名连展示都没有；
 *   2) 保存不得清空后台学习的 aliases；
 *   3) 首页今日配送取 displayName（简称），列表单行；
 *   4) 运单详情取 displayName，但导航载荷仍带全名（识别与导航不受简称影响）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8181);
const PORT_CDP = Number(process.env.PORT_CDP || 9361);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const LONG_NAME = '特渠部重庆市卫生健康委员会（临时）';
const SHORT_NAME = '市卫健委';
const ALIAS = '卫健委临时点';

const BASE_STORES = [
  { storeId: 'S1', originalName: LONG_NAME, name: LONG_NAME, shortName: SHORT_NAME, aliases: [ALIAS], navigation: 'https://surl.amap.com/abc', lat: 29.5631, lng: 106.5512, routeOrder: 1, note: '' },
  { storeId: 'S2', originalName: '谊品生鲜重庆渝北区长安锦绣城旗舰店（含仓储配送中心）', name: '谊品生鲜重庆渝北区长安锦绣城旗舰店（含仓储配送中心）', shortName: '', aliases: [], navigation: '', lat: null, lng: null, routeOrder: 2, note: '' },
];
const WB_STORES = [
  /* 模拟服务端投影：简称由 latest.js 的 withRouteData 从基准库补上 */
  { storeId: 'S1', name: LONG_NAME, displayName: SHORT_NAME, rawName: LONG_NAME, navigation: 'https://surl.amap.com/abc', lat: 29.5631, lng: 106.5512, routeOrder: 1 },
  { storeId: 'S2', name: '谊品生鲜重庆渝北区长安锦绣城旗舰店（含仓储配送中心）', rawName: '谊品生鲜重庆渝北区长安锦绣城旗舰店（含仓储配送中心）', routeOrder: 2 },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
try{localStorage.clear()}catch(e){}
(function(){
  var base=${JSON.stringify(BASE_STORES)};
  var today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  var wb={id:'w-e2e',routeId:'r1',date:today,stage:'CONFIRMED',schemaVersion:'2',stores:${JSON.stringify(WB_STORES)},summary:{finalCount:2,total:2},totalWeight:1.331};
  window.__puts=[];
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u),m=String((o&&o.method)||'GET').toUpperCase();
    if(s.indexOf('/api/home-bootstrap')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'测试线路'},user:{boundRouteId:'r1'}}));
    if(s.indexOf('/api/waybills/latest')>=0)return B(JSON.stringify({success:true,waybill:wb,dayCount:1}));
    if(s.indexOf('/api/history')>=0)return B(JSON.stringify({success:true,waybills:[wb],history:[],routeId:'r1'}));
    if(s.indexOf('/api/dispatch')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'测试线路'}}));
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT'){
        var put=JSON.parse((o&&o.body)||'{}');window.__puts.push(put);
        return B(JSON.stringify({success:true,base:{version:2,stores:put.stores}}));
      }
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'测试线路'},base:{version:1,stores:base}}));
    }
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();
window.__nav=[];window.__clicks=0;
window.open=function(u){window.__nav.push(String(u));return null;};
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[data-zp-nav]'):null;
  if(a){window.__clicks++;e.preventDefault();}
},true);`;

const SNAP_HOME = `(()=>{
  const rows=[...document.querySelectorAll('#todayStoreList .today-store-row')];
  return {
    rows:rows.length,
    labels:rows.map(r=>(r.querySelector('.today-store-name')||{}).textContent||''),
    heights:rows.map(r=>Math.round((r.querySelector('.today-store-name')||r).getBoundingClientRect().height)),
    line:parseFloat(getComputedStyle(document.querySelector('.today-store-name')).lineHeight)||0,
    navNames:[...document.querySelectorAll('#todayStoreList a[data-zp-nav]')].map(a=>a.dataset.zpNavName||''),
    payloadNames:[...document.querySelectorAll('#todayStoreList a[data-zp-nav]')].map(a=>{try{return JSON.parse(a.dataset.zpNavPayload||'{}').name||''}catch(e){return ''}}),
    wraps:[...document.querySelectorAll('.today-store-name-wrap')].map(w=>({sw:w.scrollWidth,cw:w.clientWidth,sl:Math.round(w.scrollLeft),scrollable:w.classList.contains('is-scrollable'),atEnd:w.classList.contains('at-end')}))
  };
})()`;

const SNAP_DETAIL = `(()=>{
  const links=[...document.querySelectorAll('#routeList .order-store-name')];
  return {
    labels:links.map(a=>(a.textContent||'').trim()),
    navNames:links.map(a=>a.dataset.zpNavName||''),
    payloadNames:links.map(a=>{try{return JSON.parse(a.dataset.zpNavPayload||'{}').name||''}catch(e){return ''}})
  };
})()`;

const SNAP_EDIT = `(()=>{
  const box=document.getElementById('editBox');
  return {
    open:!!box&&box.style.display!=='none',
    hasShort:!!document.getElementById('editShortName'),
    shortValue:(document.getElementById('editShortName')||{}).value||'',
    maxLength:(document.getElementById('editShortName')||{}).maxLength||0,
    hasAliasInput:!!document.getElementById('editAliasInput'),
    hasAliasAdd:!!document.getElementById('editAliasAdd'),
    hasAliasBox:!!document.getElementById('editAliases'),
    aliasText:/别名/.test(box?box.textContent:'')
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

  /* 1. 首页今日配送：简称优先、单行 */
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(2200);
  const home = await ev(SNAP_HOME);
  console.log('home ' + JSON.stringify(home));
  check('首页渲染 2 家门店', home && home.rows === 2, home && String(home.rows));
  check('有简称的门店显示简称', home && home.labels[0] === SHORT_NAME, home && home.labels[0]);
  check('未设简称的门店回退全名', home && home.labels[1] === '谊品生鲜重庆渝北区长安锦绣城旗舰店（含仓储配送中心）', home && home.labels[1]);
  check('首页门店名单行（高度 <= 行高×1.6）', home && home.heights[0] <= home.line * 1.6, home && home.heights[0] + '/' + home.line);
  { const shot = await C('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT_DIR, 'store-short-name-home.png'), Buffer.from(shot.data, 'base64')); }
  check('导航载荷仍用全名（简称不进入识别链路）', home && home.payloadNames[0] === LONG_NAME, home && home.payloadNames[0]);
  check('简称行不溢出、不可滑动', home && home.wraps[0] && home.wraps[0].scrollable === false, home && JSON.stringify(home.wraps[0]));

  /* 长名：单行 + 可左滑看全名 */
  await ev(`(()=>{const r=document.querySelectorAll('#todayStoreList .today-store-row')[1];const w=r.querySelector('.today-store-name-wrap');window.__w=w;return {sw:w.scrollWidth,cw:w.clientWidth}})()`);
  await sleep(200);
  const wide = await ev(`(()=>{const w=window.__w;return {sw:w.scrollWidth,cw:w.clientWidth,scrollable:w.classList.contains('is-scrollable'),atEnd:w.classList.contains('at-end'),h:Math.round(w.getBoundingClientRect().height)}})()`);
  console.log('wide ' + JSON.stringify(wide));
  check('长名确实溢出（可滑动）', wide && wide.sw > wide.cw, wide && wide.sw + '/' + wide.cw);
  check('溢出时右侧渐隐提示出现', wide && wide.scrollable === true && wide.atEnd === false, JSON.stringify(wide));
  check('滑动容器仍只占一行', wide && wide.h <= 24, wide && String(wide.h));
  const scrolled = await ev(`(()=>{const w=window.__w;w.scrollLeft=w.scrollWidth;w.dispatchEvent(new Event('scroll'));return {sl:Math.round(w.scrollLeft),atEnd:w.classList.contains('at-end')}})()`);
  check('滑到末尾能看到全名且渐隐收起', scrolled && scrolled.sl > 0 && scrolled.atEnd === true, JSON.stringify(scrolled));

  /* 横向拖动过的手势不得触发导航（否则想看名字会跳出地图） */
  const dragClick = await ev(`(()=>{
    const link=document.querySelectorAll('#todayStoreList .today-store-row')[1];
    const opt={bubbles:true,cancelable:true,pointerType:'touch'};
    link.dispatchEvent(new PointerEvent('pointerdown',{...opt,clientX:320,clientY:300}));
    link.dispatchEvent(new PointerEvent('pointermove',{...opt,clientX:250,clientY:302}));
    link.dispatchEvent(new PointerEvent('pointerup',{...opt,clientX:250,clientY:302}));
    const before=window.__clicks;
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return {before,after:window.__clicks};
  })()`);
  check('左滑手势不会误触地图导航', dragClick && dragClick.after === dragClick.before, JSON.stringify(dragClick));
  const tapClick = await ev(`(()=>{
    const link=document.querySelectorAll('#todayStoreList .today-store-row')[1];
    const opt={bubbles:true,cancelable:true,pointerType:'touch'};
    link.dispatchEvent(new PointerEvent('pointerdown',{...opt,clientX:200,clientY:300}));
    link.dispatchEvent(new PointerEvent('pointerup',{...opt,clientX:200,clientY:300}));
    const before=window.__clicks;
    link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return {before,after:window.__clicks};
  })()`);
  check('原地轻点仍正常唤起导航', tapClick && tapClick.after === tapClick.before + 1, JSON.stringify(tapClick));

  /* 2. 运单详情：显示简称，导航仍全名 */
  await C('Page.navigate', { url: BASE + '/pages/order_detail.html?id=w-e2e' });
  await sleep(2200);
  const detail = await ev(SNAP_DETAIL);
  console.log('detail ' + JSON.stringify(detail));
  check('运单详情显示简称', detail && detail.labels[0] === SHORT_NAME, detail && detail.labels[0]);
  check('运单详情导航载荷仍是全名', detail && detail.payloadNames[0] === LONG_NAME, detail && detail.payloadNames[0]);

  /* 3. 数据中心：编辑面板只有简称 */
  await C('Page.navigate', { url: BASE + '/pages/data.html' });
  await sleep(1800);
  await ev(`(()=>{document.querySelector('[data-swipe-edit="0"]').click();return 1})()`);
  await sleep(350);
  const edit = await ev(SNAP_EDIT);
  console.log('edit ' + JSON.stringify(edit));
  check('编辑面板已打开', edit && edit.open === true, edit && String(edit.open));
  check('存在门店简称输入框', edit && edit.hasShort === true, edit && String(edit.hasShort));
  check('简称输入框回填已有简称', edit && edit.shortValue === SHORT_NAME, edit && edit.shortValue);
  check('简称上限 16 字符', edit && edit.maxLength === 16, edit && String(edit.maxLength));
  check('手动别名输入框已移除', edit && edit.hasAliasInput === false, edit && String(edit.hasAliasInput));
  check('手动添加别名按钮已移除', edit && edit.hasAliasAdd === false, edit && String(edit.hasAliasAdd));
  check('自动别名列表不再显示', edit && edit.hasAliasBox === false, edit && String(edit.hasAliasBox));
  check('面板内不再出现「别名」字样', edit && edit.aliasText === false, edit && String(edit.aliasText));
  { const shot = await C('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT_DIR, 'store-short-name-edit.png'), Buffer.from(shot.data, 'base64')); }

  /* 4. 改简称 → 保存 → 提交，PUT 带新简称且不清空 aliases */
  await ev(`(()=>{const i=document.getElementById('editShortName');i.value='卫健委';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('editSave').click();return 1})()`);
  await sleep(400);
  await ev(`(()=>{document.getElementById('saveStoresTop').click();return 1})()`);
  await sleep(1200);
  const puts = await ev('window.__puts');
  const put = puts && puts[0];
  const s1 = put && (put.stores || []).find(s => s.storeId === 'S1');
  check('提交更新发出 1 次 PUT', !!put, puts && String(puts.length));
  check('PUT 带上门店简称', s1 && s1.shortName === '卫健委', s1 && s1.shortName);
  check('保存不得清空自动学习别名', s1 && Array.isArray(s1.aliases) && s1.aliases.includes(ALIAS), s1 && JSON.stringify(s1.aliases));
  check('保存不得用简称改写全名', s1 && s1.name === LONG_NAME, s1 && s1.name);

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'store-short-name.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
