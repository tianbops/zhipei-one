/* 线路页「线路维护」文字布局：真浏览器验证 + 前后截图
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-dispatch-text-layout.cjs
 *
 * 为什么必须真浏览器：文字层级是「计算样式 + 实际几何」的事，静态断言只能证明
 * 源码写了令牌，证明不了删掉 .dispatch-intro 之后首屏有没有被推低、名称与状态
 * 是不是真的分成了两行。这里用 git HEAD（修复前）与工作区（修复后）两套 HTML/CSS
 * 在同一浏览器里各加载一次，逐项比对并截图。
 */
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d41-8cc6368be000';
const PORT = Number(process.env.PORT || 8143);
const PORT_CDP = Number(process.env.PORT_CDP || 9324);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 修复前的 HTML/CSS 从 git HEAD 取，保证对比的是真实旧版本而不是手写桩。 */
const OLD_HTML = execFileSync('git', ['show', 'HEAD:pages/dispatch.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const OLD_CSS = execFileSync('git', ['show', 'HEAD:css/business-pages.css'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
let MODE = 'old';

const STUB = `
try{localStorage.setItem('zp_appearance_theme','dark')}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=t=>{const o={ok:true,status:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')>=0)return B('{"success":true,"user":{"id":9,"username":"driver","role":"user"}}');
 if(s.indexOf('/api/dispatch-bootstrap')>=0)return B(JSON.stringify({success:true,
   dispatchRoute:{id:'r17',name:'17号线',storeCount:43},
   routes:[{id:'r17',name:'17号线',storeCount:43,status:'active'},{id:'r18',name:'18号线',storeCount:31,status:'active'}]}));
 if(s.indexOf('/api/')>=0)return B('{"success":true}');
 return real(u,o)};})();`;

const SNAP = `(()=>{
  const q=s=>document.querySelector(s), cs=s=>{const e=q(s);if(!e)return null;const c=getComputedStyle(e);
    return {text:e.textContent.trim().slice(0,30),fs:c.fontSize,color:c.color,fw:c.fontWeight}};
  const sc=q('.zp-scroll'), sec=q('.dispatch-section');
  const name=q('.dispatch-current-name'), status=q('.dispatch-current-status');
  return {
    h1:q('.topbar h1')?.textContent,
    intro:!!q('.dispatch-intro'),
    introText:q('.dispatch-intro')?.textContent.replace(/\\s+/g,' ').trim()||'',
    titles:[...document.querySelectorAll('.dispatch-section-title')].map(e=>({text:e.textContent,fs:getComputedStyle(e).fontSize,color:getComputedStyle(e).color})),
    firstSectionTop:sec&&sc?Math.round(sec.getBoundingClientRect().top-sc.getBoundingClientRect().top):-1,
    name:cs('.dispatch-current-name'), status:cs('.dispatch-current-status'),
    nameBottom:name?Math.round(name.getBoundingClientRect().bottom):-1,
    statusTop:status?Math.round(status.getBoundingClientRect().top):-1,
    actions:[...document.querySelectorAll('.dispatch-action-main')].map(e=>({strong:getComputedStyle(e.querySelector('strong')).fontSize,small:getComputedStyle(e.querySelector('small')).fontSize})),
    switchBtn:!!q('#switchRouteBtn'),
    tabText:[...document.querySelectorAll('.zp-nav-item')].map(e=>e.textContent.trim()).find(x=>x==='线路')||''
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    /* 禁用 Service Worker + HTTP 缓存：否则第一次（修复前）加载时 SW 会把旧 CSS
       预缓存到「新 ?v= 」的 URL 下，第二次加载直接命中旧缓存，计算样式永远是旧值。 */
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    if (MODE === 'old' && p === '/pages/dispatch.html') { res.writeHead(200, { ...H, 'content-type': MIME['.html'] }); return res.end(OLD_HTML); }
    if (MODE === 'old' && p === '/css/business-pages.css') { res.writeHead(200, { ...H, 'content-type': MIME['.css'] }); return res.end(OLD_CSS); }
    const base = path.join(ROOT, p);
    const hit = [base, base + '.html', path.join(base, 'index.html')].find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!hit) { res.writeHead(404, H); return res.end('404'); }
    res.writeHead(200, { ...H, 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  });
  await new Promise(r => srv.listen(PORT, r));
  const proc = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + PORT_CDP, 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } });
  await new Promise(r => { if (ws.readyState === WebSocket.OPEN) return r(); ws.addEventListener('open', r, { once: true }); });
  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId; const C = (m, p) => send(m, p, sid);
  await C('Page.enable'); await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const ev = async s => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 160); return r.result.value; };

  /* 先写登录态（页面头部守卫 zpAuth），再正式加载。 */
  await C('Page.navigate', { url: BASE + '/pages/dispatch.html' });
  await sleep(700);
  await ev('sessionStorage.clear();sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")');

  async function run(mode, tag) {
    MODE = mode;
    await C('Page.navigate', { url: BASE + '/pages/dispatch.html?case=' + tag });
    await sleep(2000);
    const snap = await ev(SNAP);
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, tag + '.png'), Buffer.from(r.data, 'base64'));
    console.log(tag + ' ' + JSON.stringify(snap));
    return snap;
  }

  const before = await run('old', 'dispatch_before');
  const after = await run('new', 'dispatch_after');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : '')); };
  check('落在线路页', (await ev('location.pathname')) === '/pages/dispatch.html');
  check('修复前顶栏是「线路」且有「线路工作区」', before.h1 === '线路' && before.intro, before.h1 + '/' + before.introText);
  check('修复后顶栏是「线路维护」', after.h1 === '线路维护', String(after.h1));
  check('修复后「线路工作区」板块已删除', !after.intro);
  check('底部 Tab 文案仍是「线路」', after.tabText === '线路', after.tabText);
  check('两个分组标题文案保留', after.titles.map(x => x.text).join('/') === '当前配送线路/线路功能', JSON.stringify(after.titles.map(x => x.text)));
  check('分组标题 14px 实色（修复前 13px 灰字）',
    after.titles.every(x => x.fs === '14px') && before.titles.every(x => x.fs === '13px'),
    JSON.stringify(after.titles.map(x => x.fs)));
  check('删掉 intro 后首屏上移（首组距顶 < 30px，修复前 > 60px）',
    after.firstSectionTop < 30 && before.firstSectionTop > 60,
    `before=${before.firstSectionTop} after=${after.firstSectionTop}`);
  check('线路名与匹配状态分成上下两行（修复前同一行）',
    after.statusTop - after.nameBottom >= 0 && before.statusTop - before.nameBottom < 0,
    `修复前 ${before.nameBottom}/${before.statusTop}；修复后 ${after.nameBottom}/${after.statusTop}`);
  check('修复后状态字号 13px（原 12px）', after.status.fs === '13px' && before.status.fs === '12px', after.status.fs);
  check('功能名 16px / 说明 13px（原 15px / 12px）',
    after.actions.every(x => x.strong === '16px' && x.small === '13px') && before.actions.every(x => x.strong === '15px' && x.small === '12px'),
    JSON.stringify(after.actions));
  check('「切换」按钮仍在', after.switchBtn === true);

  ws.close(); proc.kill(); srv.close();
  fs.writeFileSync(path.join(OUT_DIR, 'dispatch_meta.json'), JSON.stringify({ before, after }));
  const bad = results.filter(r => !r.ok);
  console.log(`\n真浏览器线路页文字布局：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
