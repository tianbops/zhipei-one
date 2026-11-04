/* 首页品牌区「智配One ↔ 副标」间距：真浏览器几何验证 + 前后截图
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-home-brand-gap.cjs
 *
 * 为什么必须真浏览器：间距是「计算样式 + flex 布局 + 顶栏 min-height」共同作用的
 * 结果，静态断言只能证明源码写了 margin，证明不了品牌区在 50px 顶栏里被垂直居中后
 * 主标会不会反向贴住状态栏。这里用改动前的 bundle 快照与工作区 bundle 在同一浏览器
 * 里各加载一次，逐项比对几何并截图。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d41-8cc6368be000';
const OLD_CSS = process.env.OLD_CSS || path.join(OUT_DIR, 'home_bundle_old.css');
const PORT = Number(process.env.PORT || 8147);
const PORT_CDP = Number(process.env.PORT_CDP || 9327);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 改动前的 bundle 快照（由改动前复制留存），保证对比的是真实旧版本。 */
const OLD_BUNDLE = fs.readFileSync(OLD_CSS, 'utf8');
let MODE = 'old';

const STUB = `
try{localStorage.setItem('zp_appearance_theme','dark')}catch(e){}
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=t=>{const o={ok:true,status:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')>=0)return B('{"success":true,"user":{"id":9,"username":"driver","role":"user"}}');
 if(s.indexOf('/api/')>=0)return B('{"success":true,"waybills":[],"days":[],"history":[],"routes":[],"stats":{},"today":{},"stores":[]}');
 return real(u,o)};})();`;

const SNAP = `(()=>{
  const q=s=>document.querySelector(s);
  const R=e=>{if(!e)return null;const b=e.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),height:Math.round(b.height)}};
  const cs=e=>e?{fs:getComputedStyle(e).fontSize,lh:getComputedStyle(e).lineHeight,mt:getComputedStyle(e).marginTop}:null;
  const strong=q('.home-brand strong'), span=q('.home-brand span'), brand=q('.home-brand'),
        topbar=q('.topbar'), card=q('.task-card'), scroll=q('.zp-scroll');
  return {
    strongText:strong?strong.textContent.trim():'', spanText:span?span.textContent.trim():'',
    viewportH:window.innerHeight,
    topbar:R(topbar), brand:R(brand), strong:R(strong), span:R(span), card:R(card), scroll:R(scroll),
    gap:strong&&span?Math.round(span.getBoundingClientRect().top-strong.getBoundingClientRect().bottom):-1,
    strongToTop:strong?Math.round(strong.getBoundingClientRect().top):-1,
    spanToCard:span&&card?Math.round(card.getBoundingClientRect().top-span.getBoundingClientRect().bottom):-1,
    topbarToCard:topbar&&card?Math.round(card.getBoundingClientRect().top-topbar.getBoundingClientRect().bottom):-1,
    strongStyle:cs(strong), spanStyle:cs(span),
    safeTop:getComputedStyle(document.documentElement).getPropertyValue('--zp-safe-top').trim(),
    theme:document.documentElement.getAttribute('data-zp-theme')
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    /* 禁用 Service Worker + HTTP 缓存：否则第一次加载时 SW 会把旧 CSS 预缓存到
       「新 ?v=」的 URL 下，第二次加载直接命中旧缓存，计算样式永远是旧值。 */
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    if (MODE === 'old' && p === '/css/home.bundle.css') {
      res.writeHead(200, { ...H, 'content-type': MIME['.css'] }); return res.end(OLD_BUNDLE);
    }
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

  /* 先写登录态，再正式加载（页面头部守卫读 sessionStorage.zpAuth）。 */
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(600);
  await ev('try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}');

  async function run(mode, tag) {
    MODE = mode;
    await C('Page.navigate', { url: BASE + '/home.html?case=' + tag });
    await sleep(1800);
    const snap = await ev(SNAP);
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, tag + '.png'), Buffer.from(r.data, 'base64'));
    console.log(tag + ' ' + JSON.stringify(snap));
    return snap;
  }

  const before = await run('old', 'home_brand_before');
  const after = await run('new', 'home_brand_after');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  check('落在首页且品牌区两行都在', before.strongText === '智配One' && after.strongText === '智配One' && after.spanText.length > 0,
    before.strongText + ' / ' + after.spanText);
  check('深色主题生效', after.theme === 'dark', String(after.theme));
  check('主标与副标拉开距离（≥6px）', after.gap >= 6, `修复前 ${before.gap}px → 修复后 ${after.gap}px`);
  check('间距确实增大', after.gap > before.gap, `${before.gap} → ${after.gap}`);
  check('主标没有反向贴住状态栏', after.strongToTop >= before.strongToTop - 1, `strongTop ${before.strongToTop} → ${after.strongToTop}`);
  check('副标到「今日配送」卡片仍有呼吸位（≥20px）', after.spanToCard >= 20, `修复前 ${before.spanToCard}px → 修复后 ${after.spanToCard}px`);
  check('顶栏与卡片间距未被压缩', after.topbarToCard >= before.topbarToCard - 1, `修复前 ${before.topbarToCard}px → 修复后 ${after.topbarToCard}px`);
  check('主标字号不变', after.strongStyle.fs === before.strongStyle.fs, `${before.strongStyle.fs} → ${after.strongStyle.fs}`);
  check('副标字号不变', after.spanStyle.fs === before.spanStyle.fs, `${before.spanStyle.fs} → ${after.spanStyle.fs}`);

  const fails = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  fs.writeFileSync(path.join(OUT_DIR, 'home_brand_meta.json'), JSON.stringify({ before, after }, null, 2));
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
