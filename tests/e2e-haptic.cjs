/* 底部按钮触感：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30，v1.0.20）：底栏点击要「按下去有物理确认」。
 *
 * 为什么必须用**真实页面**而不是手写夹具：
 * 第一版脚本用了自己搭的底栏夹具（全 `<a>`），8 条全绿，线上却坏了——因为
 *   首页中央加号是 <button id="uploadAction">（点了就地开上传面板，不跳转），
 *   其他页的加号才是 <a href="/home?openUpload=1">，管理端整条底栏都是 <button>。
 * 夹具照着自己的想象搭，正好把「选择器只写了 a」这个 bug 完全遮住。
 * 现在直接加载 home.html / pages/history.html，用真实 DOM 与真实 bundle。
 *
 * 探针覆盖 navigator.vibrate 并把调用累积进 sessionStorage——页面导航会换文档，
 * window 上的数组会被清空，只有 sessionStorage 跨文档保留。
 *
 * 用法：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-haptic.cjs
 *
 * 边界：验证的是「网页把震动请求交给了谁」；物理震动由壳内 performHapticFeedback
 * 决定，只能真机验。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8131);
const PORT_CDP = Number(process.env.PORT_CDP || 9312);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });

/* 只桩掉鉴权与数据接口，保留真实静态资源与真实 haptic.js。 */
const STUB = `
window.__hz=[];
try{
  Object.defineProperty(Navigator.prototype,'vibrate',{configurable:true,value:function(v){
    window.__hz.push(v);
    try{var c=JSON.parse(sessionStorage.getItem('__hz')||'[]');c.push(v);sessionStorage.setItem('__hz',JSON.stringify(c))}catch(e){}
    return true;
  }});
}catch(e){window.__probeErr=String(e)}
try{var _m=sessionStorage.getItem('__ME');window.__ME=_m?JSON.parse(_m):null}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')===0){
   if(!window.__ME) return B('{"error":"unauthorized"}',false);
   return B(JSON.stringify({success:true,user:window.__ME}));
 }
 if(s.indexOf('/api/')===0)return B('{"success":true,"waybills":[],"history":[],"days":[],"routes":[],"stats":{}}');
 return real(u,o)};})();`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const base = path.join(ROOT, p);
    const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => {
      try { return fs.statSync(c).isFile(); } catch { return false; }
    });
    if (!hit) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  });
  await new Promise((r) => srv.listen(PORT, r));

  const proc = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT_CDP, 'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2600);

  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) { console.error('无法启动 Chromium（检查 CHROMIUM 路径）'); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const q = pend.get(m.id); pend.delete(m.id);
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId;
  const C = (m, p) => send(m, p, sid);
  await C('Page.enable');
  await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const ev = async (s) => {
    const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 120);
    return r.result.value;
  };
  const hz = async () => JSON.parse((await ev("sessionStorage.getItem('__hz')||'[]'")) || '[]');
  const waitReady = async (ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await ev('document.readyState')) === 'complete') return true; } catch {}
      await sleep(150);
    }
    return false;
  };
  const sheetOpen = () => ev('(()=>{const o=document.querySelector("#uploadArea");if(!o)return "no-el";const r=o.getBoundingClientRect();return (!o.hidden&&r.height>0)?"开":"关"})()');

  /* 进首页：先落一次文档写登录态，再 replace 到首页（与真实登录后进入一致）。 */
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(1200);
  await ev('sessionStorage.clear();sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");');
  await ev('location.replace("/home.html")');
  await waitReady();
  await sleep(900);

  check('探针生效', (await ev('typeof navigator.vibrate')) === 'function');
  check('落在首页', (await ev('location.pathname')) === '/home.html');

  /* ---- 结构断言：这一条正是上次漏掉的 ----
     首页加号不是链接，是按钮。选择器必须能命中它。 */
  const plusTag = await ev('(document.querySelector(".zp-nav-plus")||{}).tagName');
  check('首页中央加号是 BUTTON（不是 A）', plusTag === 'BUTTON', String(plusTag));
  check('底栏其余项是 A', (await ev('document.querySelector(".zp-nav a").tagName')) === 'A');

  /* ---- 1. 第一次点加号 ---- */
  await ev('document.querySelector(".zp-nav-plus").click()');
  await sleep(400);
  let calls = await hz();
  check('点首页加号 → 震动一次', calls.length === 1 && calls[0] === 10, JSON.stringify(calls));
  check('加号打开上传面板', (await sheetOpen()) === '开');

  /* ---- 2. 关掉面板，再点一次（用户报的「第二次」） ---- */
  await ev('window.closeUpload && window.closeUpload()');
  await sleep(350);
  await ev('document.querySelector(".zp-nav-plus").click()');
  await sleep(400);
  calls = await hz();
  check('第二次点加号仍然震动', calls.length === 2 && calls[1] === 10, JSON.stringify(calls));

  /* ---- 3. 点底栏 tab 的 SVG 图标内部（target 是 <path>） ---- */
  await ev('window.closeUpload && window.closeUpload()');
  await sleep(300);
  await ev('document.querySelector(".zp-nav a svg path").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))');
  await sleep(500);
  calls = await hz();
  check('点底栏图标（SVG path 内）→ 震动', calls.length === 3 && calls[2] === 10, JSON.stringify(calls));

  /* ---- 4. 普通按钮不震 ---- */
  const before = calls.length;
  await ev('(()=>{const b=document.createElement("button");b.id="__plain";b.textContent="普通按钮";document.body.appendChild(b);b.click();})()');
  await sleep(300);
  calls = await hz();
  check('普通按钮不震', calls.length === before, JSON.stringify(calls));

  /* ---- 5. 连点（同 kind 120ms 内）只响一次 ---- */
  const before2 = calls.length;
  await ev('(()=>{const p=document.querySelector(".zp-nav-plus");p.click();p.click();p.click();})()');
  await sleep(400);
  calls = await hz();
  check('连点三次只震一次（节流）', calls.length === before2 + 1, JSON.stringify(calls));

  /* ---- 6. 跳到历史页（加号是 <a>），点它应震动并跳回首页 ---- */
  await ev('window.closeUpload && window.closeUpload()');
  await sleep(300);
  const before3 = calls.length;
  await C('Page.navigate', { url: BASE + '/pages/history.html' });
  await waitReady();
  await sleep(700);
  const histPlusTag = await ev('(document.querySelector(".zp-nav-plus")||{}).tagName');
  check('历史页加号是 A（与首页不同）', histPlusTag === 'A', String(histPlusTag));
  await ev('document.querySelector(".zp-nav-plus").click()');
  await sleep(1200);
  calls = await hz();
  check('历史页点加号 → 震动', calls.length === before3 + 1, JSON.stringify(calls));
  check('历史页点加号 → 回到首页并开面板',
    ['/home', '/home.html'].includes(await ev('location.pathname')) && (await sheetOpen()) === '开',
    (await ev('location.pathname')) + ' / ' + (await sheetOpen()));

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n真浏览器触感验证：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
