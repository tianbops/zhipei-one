/* 设置页底部三块「版权 / 退出登录 / 注销账号」间距等距化：真浏览器测量 + 前后截图
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-account-footer-spacing.cjs
 *
 * 用户要求三者「适当等距」。这里的间距一律按**视觉空白**定义，而不是元素盒边界：
 *   gap1 = 退出登录按钮顶边 - 版权「文字行」底边
 *   gap2 = 注销账号「文字行」顶边 - 退出登录按钮底边
 * 注销账号是带 12px 上下 padding 的文字按钮，若按元素盒量会把 padding 算进间距，
 * 与用户眼睛看到的空白不符。版权行同理用 Range 取文字行 rect。
 *
 * old 模式注入改动前 account.css（git HEAD 快照）做同数据前后对比。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d41-8cc6368be000';
const OLD_CSS = process.env.OLD_CSS || path.join(OUT_DIR, 'account_footer_old.css');
const PORT = Number(process.env.PORT || 8156);
const PORT_CDP = Number(process.env.PORT_CDP || 9336);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const OLD_CSS_TEXT = fs.readFileSync(OLD_CSS, 'utf8');
let MODE = 'old';

const STUB = `
try{localStorage.setItem('zp_appearance_theme','dark')}catch(e){}
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user')}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=t=>{const o={ok:true,status:200,headers:{get:()=>null,has:()=>false}};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')>=0)return B('{"success":true,"user":{"id":9,"username":"driver","role":"user"}}');
 if(s.indexOf('/api/')>=0)return B('{"success":true,"version":"1.0.0","latest":"1.0.0","url":"","waybills":[],"routes":[]}');
 return real(u,o)};})();`;

/* 取元素内文字行的 rect（版权行 / 注销账号文字），比元素盒更贴近观感 */
const SNAP = `(()=>{
  const q=s=>document.querySelector(s);
  const lineRect=el=>{if(!el)return null;const rg=document.createRange();rg.selectNodeContents(el);
    const rs=[...rg.getClientRects()].filter(r=>r.width>0);
    if(!rs.length)return null;
    return {top:Math.round(Math.min(...rs.map(r=>r.top))),bottom:Math.round(Math.max(...rs.map(r=>r.bottom))),
      left:Math.round(Math.min(...rs.map(r=>r.left))),width:Math.round(Math.max(...rs.map(r=>r.right))-Math.min(...rs.map(r=>r.left)))};};
  const box=el=>{if(!el)return null;const b=el.getBoundingClientRect();
    return {top:Math.round(b.top),bottom:Math.round(b.bottom),height:Math.round(b.height),width:Math.round(b.width)};};
  const cr=q('.acct-about-copyright'), btn=q('#logout'), dz=q('#dangerToggle'), sec=q('.account-logout-section');
  const crLine=lineRect(cr), btnBox=box(btn), dzLine=lineRect(dz), secBox=box(sec);
  const cs=el=>el?getComputedStyle(el):null;
  const mt=el=>cs(el)?cs(el).marginTop:null, mb=el=>cs(el)?cs(el).marginBottom:null, pt=el=>cs(el)?cs(el).paddingTop:null;
  return {
    crLine, btnBox, dzLine, secBox,
    crBox:box(cr), dzBox:box(dz),
    gap1:crLine&&btnBox?btnBox.top-crLine.bottom:null,
    gap2:dzLine&&btnBox?dzLine.top-btnBox.bottom:null,
    crMargin:mt(cr)+' / '+mb(cr), secMargin:mt(sec)+' / '+mb(sec),
    dzMargin:mt(dz)+' / '+mb(dz), dzPadding:pt(dz),
    crText:cr?cr.textContent.trim():'', dzText:dz?dz.textContent.trim():'',
    btnText:btn?btn.textContent.trim():'',
    theme:document.documentElement.getAttribute('data-zp-theme'),
    viewportH:window.innerHeight
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    /* 禁用 SW 与 HTTP 缓存：否则第一次（old）加载会把旧 CSS 缓存到新 ?v 下 */
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    if (MODE === 'old' && p === '/css/account.css') {
      res.writeHead(200, { ...H, 'content-type': MIME['.css'] }); return res.end(OLD_CSS_TEXT);
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

  async function run(mode, tag) {
    MODE = mode;
    await C('Page.navigate', { url: BASE + '/pages/account.html?case=' + tag });
    await sleep(1600);
    await ev('try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}');
    /* 三块都在首屏下方，滚到版权行上方留一点，让三块同时进视口 */
    await ev('(()=>{const e=document.querySelector(".acct-about-copyright");if(e)window.scrollTo(0,Math.max(0,e.getBoundingClientRect().top+window.scrollY-160));const s=document.querySelector(".zp-scroll");if(s)s.scrollTop=s.scrollHeight;return 1})()');
    await sleep(450);
    const snap = await ev(SNAP);
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, tag + '.png'), Buffer.from(r.data, 'base64'));
    console.log(tag + ' ' + JSON.stringify(snap));
    return snap;
  }

  const before = await run('old', 'footer_before');
  const after = await run('new', 'footer_after');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  check('三块文案齐全且顺序不变',
    before.crText === after.crText && before.btnText === after.btnText && before.dzText === after.dzText &&
    /All Rights Reserved$/.test(after.crText) && after.btnText === '退出登录' && after.dzText === '注销账号',
    `${after.crText} / ${after.btnText} / ${after.dzText}`);
  check('修复前两段间距明显不等', Math.abs(before.gap1 - before.gap2) >= 8,
    `gap1=${before.gap1} gap2=${before.gap2}`);
  check('修复后两段视觉间距等距（差 ≤2px）', Math.abs(after.gap1 - after.gap2) <= 2,
    `gap1=${after.gap1} gap2=${after.gap2}`);
  check('间距落在「适当」区间 16~36px', after.gap1 >= 16 && after.gap1 <= 36,
    `gap1=${after.gap1}`);
  check('退出登录按钮尺寸/位置语义未变（仍是 48px 起）',
    after.btnBox.height >= 48 && before.btnBox.height === after.btnBox.height,
    `${before.btnBox.height} → ${after.btnBox.height}`);
  check('版权行仍单行、字号未变', after.crLine && after.crBox.height === before.crBox.height,
    `${before.crBox.height} → ${after.crBox.height}`);
  check('深色主题生效', after.theme === 'dark', String(after.theme));

  const fails = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  fs.writeFileSync(path.join(OUT_DIR, 'footer_meta.json'), JSON.stringify({ before, after, OUT: '/workspace/account-footer-spacing-compare.png' }, null, 2));
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
