/* 首页「今日配送」门店列表：任何可视高度都必须完整展开
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-home-today-expand.cjs
 *
 * 背景（2026-11-05，用户录屏）：「web 端首页今日配送，运单数据未展开，app 端正常」。
 * 根因是旧设计给列表设了 max-height:264px（窗内滚动），改用「内容驱动高度 + 整页滚动」
 * 后，矮屏/横屏降级分支仍保留 max-height，却没恢复 overflow —— 手机浏览器地址栏占高时
 * 可视高度掉到 760px 以下，列表被裁到 6 行、底部再叠一层渐隐，还滑不动：
 * 数据看着像「没展开」。app 内 WebView 是全高（≥760），不进降级分支，所以正常。
 *
 * 为什么必须真浏览器：这是媒体查询 + flex 版面 + 计算样式共同作用的几何结果，
 * 静态断言只能证明源码没写 max-height，证明不了浏览器实际算出来的 clientHeight、
 * overflow 与 mask。这里直接在 5 种视口下量真实几何，并滚到底确认最后一家可见。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8152);
const PORT_CDP = Number(process.env.PORT_CDP || 9332);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 17 家门店：足够长到一屏放不下（复现「列表被裁」的最小规模） */
const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
try{localStorage.removeItem('zp_today_snapshot')}catch(e){}
(function(){
  const names=['江北胡汪洋经销商（重庆胡建镜好食品有限公司）','渝北中景隆(重庆)贸易有限公司','江北重庆三峡融资担保集团有限公司','到家主城-江北区加州客服中心（2026）','到家主城-江北区鸿恩寺客服中心（2026）','特渠部重庆市卫生健康委员会','江北区大石坝配送点','渝中区解放碑配送站','南岸区茶园新区门店','沙坪坝区三峡广场门店','九龙坡区杨家坪门店','渝北区龙溪街道门店','北碚区天生桥门店','巴南区李家沱门店','大渡口区九宫庙门店','两江新区人和门店','高新区大学城门店'];
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const wb={id:'w-e2e',routeId:'r1',date:today,stores:names.map(n=>({name:n,navigation:''})),summary:{finalCount:names.length,total:names.length},totalWeight:1.331};
  const real=window.fetch;
  window.fetch=function(u,o){
    const s=String(u&&u.url||u);
    const B=t=>{const r={ok:true,status:200,headers:{get:()=>null,has:()=>false}};r.json=()=>Promise.resolve(JSON.parse(t));r.text=()=>Promise.resolve(t);r.clone=()=>B(t);return Promise.resolve(r)};
    if(s.indexOf('/api/home-bootstrap')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'测试线路'},user:{boundRouteId:'r1'}}));
    if(s.indexOf('/api/waybills/latest')>=0)return B(JSON.stringify({success:true,waybill:wb,dayCount:1}));
    if(s.indexOf('/api/history')>=0)return B(JSON.stringify({success:true,waybills:[wb],history:[],routeId:'r1'}));
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

const SNAP = `(()=>{
  const list=document.getElementById('todayStoreList');
  const sc=document.querySelector('main.home-app .zp-scroll');
  const card=document.querySelector('.task-card');
  const cs=list?getComputedStyle(list):null;
  const rows=list?[...list.querySelectorAll('.today-store-row:not([aria-hidden="true"])')]:[];
  const last=rows.length?rows[rows.length-1]:null;
  return {
    viewportH:innerHeight,
    rows:rows.length,
    listH:list?Math.round(list.getBoundingClientRect().height):-1,
    innerOverflow:list?list.scrollHeight-list.clientHeight:-1,
    overflowY:cs?cs.overflowY:'',
    maxH:cs?cs.maxHeight:'',
    mask:cs?((cs.maskImage&&cs.maskImage!=='none')||(cs.webkitMaskImage&&cs.webkitMaskImage!=='none')):false,
    cardH:card?Math.round(card.getBoundingClientRect().height):-1,
    pageScrollable:sc?sc.scrollHeight-sc.clientHeight:-1,
    lastText:last?last.textContent.trim():''
  };
})()`;

const TO_BOTTOM = `(()=>{const sc=document.querySelector('main.home-app .zp-scroll');sc.scrollTop=sc.scrollHeight;return sc.scrollTop})()`;

const LAST_ROW = `(()=>{
  const rows=[...document.querySelectorAll('#todayStoreList .today-store-row:not([aria-hidden="true"])')];
  const last=rows[rows.length-1];if(!last)return {visible:false,bottom:-1};
  const r=last.getBoundingClientRect();
  return {visible:r.top>=-1&&r.bottom<=innerHeight+1,bottom:Math.round(r.bottom)};
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

  /* 先落登录态，再正式加载（页面头部守卫读 sessionStorage.zpAuth） */
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(600);
  await ev('try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  /* app 内 WebView 全高 / 手机浏览器地址栏占高 / 小屏 / 横屏 */
  const cases = [
    [390, 844, 'app-844'],
    [390, 700, 'web-700'],
    [390, 640, 'web-640'],
    [375, 667, 'web-375'],
    [844, 390, 'landscape'],
  ];

  for (const [w, h, tag] of cases) {
    await C('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await C('Page.navigate', { url: BASE + '/home.html?case=' + tag });
    await sleep(1800);
    const s = await ev(SNAP);
    if (!s || s.err) { check(tag + ' 页面可测量', false, s && s.err); continue; }
    await ev(TO_BOTTOM);
    await sleep(250);
    const last = await ev(LAST_ROW);
    const shot = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, 'home_today_expand_' + tag + '.png'), Buffer.from(shot.data, 'base64'));

    console.log(tag + ' ' + JSON.stringify({ ...s, last }));
    check(tag + ' 17 家门店全部渲染', s.rows === 17, String(s.rows));
    check(tag + ' 列表不封顶（无 max-height）', s.maxH === 'none', s.maxH);
    check(tag + ' 列表无内部滚动条（内容不被裁）', s.innerOverflow <= 2 && s.overflowY === 'visible', `overflow ${s.innerOverflow} / ${s.overflowY}`);
    check(tag + ' 无底部渐隐（不再伪装「还能往下滚」）', s.mask === false);
    check(tag + ' 整页可滚动承接', s.pageScrollable > 0, String(s.pageScrollable));
    check(tag + ' 滚到底最后一家完整可见', !!last && last.visible === true, JSON.stringify(last));
  }

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
