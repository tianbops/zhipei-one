/* 设置页（我的）底部留白：真浏览器几何验证 + 前后截图
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-account-bottom-gap.cjs
 *
 * 为什么必须真浏览器：空白是「.zp-scroll 撑满剩余高度 + padding-bottom +
 * 浮岛底栏滚动隐藏」共同作用的结果，静态断言只能证明写了 128px，证明不了
 * 滚到底时用户实际看到多大一块黑。这里用改动前的 account.css 快照与工作区
 * 版本在同一浏览器里各加载一次，滚动到底部后逐项比对几何并截图。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || '/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d41-8cc6368be000';
const OLD_CSS = process.env.OLD_CSS || path.join(OUT_DIR, 'account_old.css');
const PORT = Number(process.env.PORT || 8151);
const PORT_CDP = Number(process.env.PORT_CDP || 9331);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const OLD_ACCOUNT = fs.readFileSync(OLD_CSS, 'utf8');
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
  const R=e=>{if(!e)return null;const b=e.getBoundingClientRect();return {top:Math.round(b.top),bottom:Math.round(b.bottom),height:Math.round(b.height)}};
  const sc=q('.zp-scroll'), last=q('#dangerToggle'), nav=q('.zp-nav'), body=document.body;
  const cs=e=>e?getComputedStyle(e):null;
  return {
    viewportH:window.innerHeight,
    scroll:sc?{rect:R(sc),clientHeight:sc.clientHeight,scrollHeight:sc.scrollHeight,
      scrollTop:Math.round(sc.scrollTop),maxScroll:sc.scrollHeight-sc.clientHeight}:null,
    padBottom:sc?cs(sc).paddingBottom:null,
    bodyPadBottom:cs(body).paddingBottom,
    last:last?{rect:R(last),text:last.textContent.trim()}:null,
    gapLastToViewport:last?Math.round(window.innerHeight-last.getBoundingClientRect().bottom):-1,
    nav:nav?{rect:R(nav),hidden:nav.classList.contains('is-nav-hidden')}:null,
    doc:{scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight,
      max:document.documentElement.scrollHeight-document.documentElement.clientHeight,
      scrollTop:Math.round(document.scrollingElement?document.scrollingElement.scrollTop:0)},
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
    if (MODE === 'old' && p === '/css/account.css') {
      res.writeHead(200, { ...H, 'content-type': MIME['.css'] }); return res.end(OLD_ACCOUNT);
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
    const top = await ev(SNAP);
    /* 连续下滑到最底：nav.js 首帧只记位置，必须多次 scroll 事件累计位移才会隐藏底栏，
       一步赋值 scrollTop 复现不出真机「滚到底 + 底栏隐藏」的状态。 */
    for (let i = 1; i <= 6; i++) {
      await ev(`(()=>{const s=document.querySelector(".zp-scroll");if(!s)return -1;
        const max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.round(max*${i}/6);return s.scrollTop})()`);
      await sleep(160);
    }
    await sleep(600);
    const bottom = await ev(SNAP);
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, tag + '.png'), Buffer.from(r.data, 'base64'));
    console.log(tag + ' TOP    ' + JSON.stringify(top));
    console.log(tag + ' BOTTOM ' + JSON.stringify(bottom));
    return { top, bottom };
  }

  const before = await run('old', 'account_gap_before');
  const after = await run('new', 'account_gap_after');

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  check('落在设置页且最后一项是「注销账号」', before.bottom.last && before.bottom.last.text === '注销账号' && after.bottom.last && after.bottom.last.text === '注销账号');
  check('深色主题生效', after.bottom.theme === 'dark', String(after.bottom.theme));
  check('滚到底时底部留白确实减小', after.bottom.gapLastToViewport < before.bottom.gapLastToViewport,
    `修复前 ${before.bottom.gapLastToViewport}px → 修复后 ${after.bottom.gapLastToViewport}px`);
  check('留白收窄幅度 ≥30px', before.bottom.gapLastToViewport - after.bottom.gapLastToViewport >= 30,
    `收窄 ${before.bottom.gapLastToViewport - after.bottom.gapLastToViewport}px`);
  check('padding-bottom 从 128px 下调', parseFloat(after.bottom.padBottom) < parseFloat(before.bottom.padBottom),
    `${before.bottom.padBottom} → ${after.bottom.padBottom}`);
  check('仍保留底部呼吸位（≥32px，不为 0）', after.bottom.gapLastToViewport >= 32,
    String(after.bottom.gapLastToViewport));
  check('滚到底时浮岛底栏保持隐藏（Uber 交互不变）', after.bottom.nav && after.bottom.nav.hidden === true,
    JSON.stringify(after.bottom.nav));
  check('内容仍可滚动到底（注销账号完整可见）', after.bottom.scroll && after.bottom.scroll.scrollTop >= after.bottom.scroll.maxScroll - 1,
    `scrollTop=${after.bottom.scroll && after.bottom.scroll.scrollTop} max=${after.bottom.scroll && after.bottom.scroll.maxScroll}`);
  check('body 让位未被改动', parseFloat(after.bottom.bodyPadBottom) === parseFloat(before.bottom.bodyPadBottom),
    `${before.bottom.bodyPadBottom} → ${after.bottom.bodyPadBottom}`);

  const fails = results.filter(r => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  fs.writeFileSync(path.join(OUT_DIR, 'account_gap_meta.json'), JSON.stringify({ before, after }, null, 2));
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
