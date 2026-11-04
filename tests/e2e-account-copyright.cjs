/* 设置页版权行「完整信息」：真浏览器排版验证 + 前后截图
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-account-copyright.cjs
 *
 * 文案从「© 2026 智配One」补成「© 2026 智配One All Rights Reserved」后，
 * 必须确认它在 390 宽屏上仍是单行居中、不溢出、不把下面「退出登录」挤下去 ——
 * 静态断言只能证明字符串写对了，证明不了排版。这里用改动前页面快照与工作区
 * 页面在同一浏览器里各加载一次，逐项比对并截图。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const os = require('node:os');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const OLD_HTML = process.env.OLD_HTML || path.join(__dirname, 'fixtures', 'e2e-baseline', 'account_html_old.html');
const PORT = Number(process.env.PORT || 8155);
const PORT_CDP = Number(process.env.PORT_CDP || 9335);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const OLD_PAGE = fs.readFileSync(OLD_HTML, 'utf8');
let MODE = 'old';

const STUB = `
try{localStorage.setItem('zp_appearance_theme','dark')}catch(e){}
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=t=>{const o={ok:true,status:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')>=0)return B('{"success":true,"user":{"id":9,"username":"driver","role":"user"}}');
 if(s.indexOf('/api/')>=0)return B('{"success":true,"version":"1.0.0","latest":"1.0.0","url":"","waybills":[],"routes":[]}');
 return real(u,o)};})();`;

const SNAP = `(()=>{
  const q=s=>document.querySelector(s);
  const e=q('.acct-about-copyright'), btn=q('#logout');
  const cs=e?getComputedStyle(e):null;
  const R=x=>{if(!x)return null;const b=x.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),width:Math.round(b.width),height:Math.round(b.height)}};
  let lines=0,textW=0;
  if(e){const rg=document.createRange();rg.selectNodeContents(e);
    const rects=[...rg.getClientRects()].filter(r=>r.width>0);
    lines=rects.length;textW=Math.round(Math.max(...rects.map(r=>r.width)));}
  return {
    text:e?e.textContent.trim():'',
    rect:R(e), lines, textW,
    fontSize:cs?cs.fontSize:null, color:cs?cs.color:null, textAlign:cs?cs.textAlign:null,
    lineHeight:cs?cs.lineHeight:null,
    overflow:!!e&&textW>e.getBoundingClientRect().width,
    logoutTop:btn?Math.round(btn.getBoundingClientRect().top):-1,
    visible:!!e&&e.getBoundingClientRect().top>=0&&e.getBoundingClientRect().bottom<=window.innerHeight,
    viewportH:window.innerHeight,
    theme:document.documentElement.getAttribute('data-zp-theme')
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    if (MODE === 'old' && p === '/pages/account.html') {
      res.writeHead(200, { ...H, 'content-type': MIME['.html'] }); return res.end(OLD_PAGE);
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

  await C('Page.navigate', { url: BASE + '/pages/account.html' });
  await sleep(600);
  await ev('try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}');

  async function run(mode, tag) {
    MODE = mode;
    await C('Page.navigate', { url: BASE + '/pages/account.html?case=' + tag });
    await sleep(1600);
    /* 版权行在首屏下方（y≈850 > 844），先滚进视口再截图，否则对比图看不到文案。 */
    await ev('(()=>{const e=document.querySelector(".acct-about-copyright");if(e)e.scrollIntoView({block:"center"});return !!e})()');
    await sleep(500);
    const snap = await ev(SNAP);
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, tag + '.png'), Buffer.from(r.data, 'base64'));
    console.log(tag + ' ' + JSON.stringify(snap));
    return snap;
  }

  const before = await run('old', 'copyright_before');
  const after = await run('new', 'copyright_after');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
  const FULL = '© 2026 智配One All Rights Reserved';

  check('旧版是简写版权', before.text === '© 2026 智配One', before.text);
  check('新版为完整版权信息', after.text === FULL, after.text);
  check('新版保留年份与品牌名', after.text.indexOf('© 2026 智配One') === 0 && after.text.endsWith('All Rights Reserved'));
  check('完整文案仍是单行（不折行）', after.lines === 1, 'lines=' + after.lines);
  check('文本未超出容器宽度', !after.overflow && after.textW <= after.rect.width,
    `textW=${after.textW} boxW=${after.rect.width}`);
  check('字号 / 颜色 / 居中保持不变', after.fontSize === before.fontSize && after.color === before.color && after.textAlign === before.textAlign,
    `${after.fontSize} ${after.color} ${after.textAlign}`);
  check('版权行高度不变（没有变成两行撑高）', after.rect.height === before.rect.height,
    `${before.rect.height} → ${after.rect.height}`);
  check('下方「退出登录」未被推低', after.logoutTop === before.logoutTop,
    `${before.logoutTop} → ${after.logoutTop}`);
  check('版权行已滚入视口（截图可见）', after.visible === true && before.visible === true,
    `before=${before.visible} after=${after.visible}`);
  check('深色主题生效', after.theme === 'dark', String(after.theme));

  const fails = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  fs.writeFileSync(path.join(OUT_DIR, 'copyright_meta.json'), JSON.stringify({ before, after }, null, 2));
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
