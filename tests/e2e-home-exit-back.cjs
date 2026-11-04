/* 真浏览器回归：返回到首页后二次返回，应退回「浏览器首页」（离开站点）。
 *
 * 复现路径（2026-11-04 用户反馈）：
 *   登录跳转写 /home?v=时间戳，底栏「首页」Tab 却是 /home。站内导航一律
 *   location.replace，只替换当前项，栈底那条 /home?v= 永久残留。点 Tab 回首页后，
 *   第二次返回落到这条 URL 不同的首页记录并重新加载文档，旧文档 popstate 里的
 *   zpDoExit 来不及执行就被卸载 —— 人还留在 App 里，退不出去。
 *
 * 修法：第二次返回同步写退出标记，下一份业务页文档（back/forward 到达）在 load
 * 之后接力 history.back()，直到真正离开站点。正常 navigate 打开 App 时清标记。
 *
 * 用法（需要本机 chromium，不进 npm test）：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-home-exit-back.cjs
 *   OLD_BACK / OLD_BUNDLE 可指定「修复前」快照，缺省读 tests/fixtures/e2e-baseline/ 下的同名快照。
 *
 * 自带静态服务器做「无扩展名 → .html」映射，与线上 Pages 一致；
 * 只桩掉鉴权/数据接口，保留真实 back.js —— 验证的正是它的历史栈行为。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const FIX = path.join(__dirname, 'fixtures', 'e2e-baseline');
const OLD_BACK = process.env.OLD_BACK || path.join(FIX, 'back_old.js');
const OLD_BUNDLE = process.env.OLD_BUNDLE || path.join(FIX, 'home_bundle_old.js');
const HAVE_OLD = fs.existsSync(OLD_BACK) && fs.existsSync(OLD_BUNDLE);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
let MODE = 'new';   // old = 注入修复前 back.js / home.bundle.js
function startServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let p = decodeURIComponent(u.pathname);
      const H = { 'cache-control': 'no-store' };
      // 禁用 SW：否则首轮（修复前）会把旧 JS 预缓存到新 ?v= 下，第二轮命中旧缓存。
      if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
      if (MODE === 'old' && p === '/js/ui/back.js' && HAVE_OLD) {
        res.writeHead(200, { ...H, 'content-type': MIME['.js'] });
        return res.end(fs.readFileSync(OLD_BACK));
      }
      if (MODE === 'old' && p === '/js/home.bundle.js' && HAVE_OLD) {
        res.writeHead(200, { ...H, 'content-type': MIME['.js'] });
        return res.end(fs.readFileSync(OLD_BUNDLE));
      }
      if (p.endsWith('/')) p += 'index.html';
      const base = path.join(ROOT, p);
      const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => {
        try { return fs.statSync(c).isFile(); } catch { return false; }
      });
      if (!hit) { res.writeHead(404, H); return res.end('404'); }
      res.writeHead(200, { ...H, 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
      fs.createReadStream(hit).pipe(res);
    });
    srv.listen(port, () => resolve(srv));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});

/* 每个新文档加载前注入登录态与接口桩；退出标记不清（要观察跨文档接力）。 */
const BOOT = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');
    sessionStorage.setItem('__ME',JSON.stringify({id:9,username:'driver',role:'user'}));}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')===0)return B(JSON.stringify({success:true,user:{id:9,username:'driver',role:'user'}}));
 if(s.indexOf('/api/history')===0)return B('{"success":true,"history":[],"days":[]}');
 if(s.indexOf('/api/waybills')===0)return B('{"success":true,"waybills":[]}');
 if(s.indexOf('/api/routes')===0)return B('{"success":true,"routes":[]}');
 if(s.indexOf('/api/today')===0)return B('{"success":true,"waybills":[]}');
 if(s.indexOf('/api/')===0)return B('{"success":true}');
 return real(u,o)};})();
(function(){let _fn;Object.defineProperty(window,'zpHandleBack',{configurable:true,
  get(){return _fn},
  set(fn){_fn=async function(){const r=await fn.apply(this,arguments);
    let L=[];try{L=JSON.parse(sessionStorage.getItem('__BACKLOG')||'[]')}catch(e){}
    L.push({url:location.pathname,r,exit:(()=>{try{return sessionStorage.getItem('zpExitAdmin')}catch(e){return 'ERR'}})(),t:Date.now()});
    try{sessionStorage.setItem('__BACKLOG',JSON.stringify(L.slice(-10)))}catch(e){}
    return r};}});})();
document.addEventListener('DOMContentLoaded',function(){
  let n=null;try{n=(performance.getEntriesByType('navigation')[0]||{}).type||null}catch(e){}
  let L=[];try{L=JSON.parse(sessionStorage.getItem('__NAVLOG')||'[]')}catch(e){}
  L.push({url:location.pathname+location.search,type:n,legacy:(()=>{try{return performance.navigation&&performance.navigation.type}catch(e){return 'ERR'}})(),
    exit:(()=>{try{return sessionStorage.getItem('zpExitAdmin')}catch(e){return 'ERR'}})(),t:Date.now()});
  try{sessionStorage.setItem('__NAVLOG',JSON.stringify(L.slice(-10)))}catch(e){}
});
`;

const PORT = Number(process.env.PORT || 8119);
const PORT_CDP = Number(process.env.PORT_CDP || 9261);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const SITE = BASE + '/';
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

(async () => {
  const server = await startServer(PORT);
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT_CDP, 'about:blank',
  ], { stdio: 'ignore' });
  await sleep(2600);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) { console.error('无法启动 Chromium（检查 CHROMIUM 路径）'); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
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
  await C('Page.enable'); await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: BOOT });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const ev = async (s) => {
    const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text).slice(0, 160));
    return r.result.value;
  };
  const waitReady = async (ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const st = await ev('document.readyState');
        const n = await ev('document.body ? document.body.children.length : 0');
        if (st === 'complete' && n > 0) return true;
      } catch {}
      await sleep(150);
    }
    return false;
  };
  const snap = async () => {
    try {
      return await ev(`(()=>{let f='ERR';try{f=sessionStorage.getItem('zpExitAdmin')}catch(e){}
        return {href:location.href,path:location.pathname+location.search,len:history.length,
          exitFlag:f,toast:(document.body?document.body.innerText:'').indexOf('再按一次退出')>=0,
          navType:(()=>{try{return (performance.getEntriesByType('navigation')[0]||{}).type||null}catch(e){return 'ERR'}})(),
          navlog:(()=>{try{return JSON.parse(sessionStorage.getItem('__NAVLOG')||'[]').slice(-4)}catch(e){return []}})(),
          backlog:(()=>{try{return JSON.parse(sessionStorage.getItem('__BACKLOG')||'[]').slice(-4)}catch(e){return []}})(),
          out:location.href.indexOf(${JSON.stringify(SITE)})!==0}})()`);
    } catch (e) { return { href: '(eval 失败)', path: '', out: true, err: String(e.message).slice(0, 80) }; }
  };
  const back = async () => { try { await ev('history.back()'); } catch {} await sleep(1100); };
  const shot = async (file) => {
    const r = await C('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };

  /* 一个场景：干净栈 → 登录跳转形态的首页 → 历史 Tab → 首页 Tab → 两次物理返回。
     backWay='tab' 用底栏 Tab 回首页（复现路径）；'key' 用物理返回回首页（对照）。 */
  async function runScene(mode, backWay, tag) {
    MODE = mode;
    await C('Page.navigate', { url: 'about:blank' }); await sleep(320);
    try { await C('Page.resetNavigationHistory'); } catch {}
    await C('Page.navigate', { url: BASE + '/home?v=' + Date.now() }); // 登录跳转的真实 URL 形态
    await waitReady(); await sleep(620);
    await ev(`try{sessionStorage.removeItem('zpExitAdmin');sessionStorage.removeItem('zpExitAt');sessionStorage.removeItem('zpExitReady')}catch(e){}`);
    const s0 = await snap();
    await ev(`document.querySelector('a.zp-nav-item[href*="history"]').click()`);
    await waitReady(); await sleep(560);
    const sHist = await snap();
    if (backWay === 'tab') {
      await ev(`document.querySelector('a.zp-nav-home').click()`);
      await waitReady(); await sleep(620);
    } else {
      await back(); await waitReady(); await sleep(400);
    }
    const sHome = await snap();
    await back(); const s1 = await snap();
    await back(); const s2 = await snap();
    console.log('   ' + tag + ' 序列: ' + [s0.path, sHist.path, sHome.path, s1.path, s2.path].join(' → '));
    console.log('   ' + tag + ' 第2次返回 out=' + s2.out + ' | len=' + s2.len + ' | exitFlag=' + s2.exitFlag + ' | navType=' + s2.navType);
    console.log('   ' + tag + ' navlog=' + JSON.stringify(s2.navlog));
    console.log('   ' + tag + ' backlog=' + JSON.stringify(s2.backlog));
    if (tag.indexOf('修复前') === 0 || tag.indexOf('修复后') === 0) {
      await shot(path.join(OUT_DIR, tag.indexOf('修复前') === 0 ? 'exit_before.png' : 'exit_after.png'));
    }
    return { s0, sHist, sHome, s1, s2 };
  }

  console.log('修复前快照: ' + (HAVE_OLD ? '可用' : '缺失（跳过修复前一轮）'));
  let oldTab = null, newTab = null, newKey = null;
  if (HAVE_OLD) {
    console.log('\n1) 修复前 · 点底栏「首页」Tab 回首页 → 两次物理返回');
    oldTab = await runScene('old', 'tab', '修复前·Tab');
    check('修复前确实复现：第 2 次返回仍停在 App（未退出）', oldTab.s2.out === false,
      String(oldTab.s2.path));
  }

  console.log('\n2) 修复后 · 同一路径');
  newTab = await runScene('new', 'tab', '修复后·Tab');
  check('修复后第 1 次返回仍在首页并出现「再按一次」提示',
    newTab.s1.out === false && String(newTab.s1.path).indexOf('/home') === 0 && newTab.s1.toast === true,
    String(newTab.s1.path) + ' | toast=' + newTab.s1.toast);
  check('修复后第 2 次返回已离开站点（退回浏览器首页）', newTab.s2.out === true, String(newTab.s2.href));
  if (HAVE_OLD) {
    check('修复前后差异成立（前=留在 App / 后=离开站点）',
      oldTab.s2.out === false && newTab.s2.out === true,
      oldTab.s2.path + ' vs ' + newTab.s2.href);
  }

  console.log('\n3) 对照 · 物理返回回首页（原路径不能被改坏）');
  newKey = await runScene('new', 'key', '对照·物理键');
  check('物理返回回首页后，第 2 次返回同样离开站点', newKey.s2.out === true, String(newKey.s2.href));

  const meta = {
    before: oldTab ? { seq: [oldTab.s0.path, oldTab.sHist.path, oldTab.sHome.path, oldTab.s1.path, oldTab.s2.path], out: oldTab.s2.out } : null,
    after: { seq: [newTab.s0.path, newTab.sHist.path, newTab.sHome.path, newTab.s1.path, newTab.s2.path], out: newTab.s2.out },
    key: { seq: [newKey.s0.path, newKey.sHist.path, newKey.sHome.path, newKey.s1.path, newKey.s2.path], out: newKey.s2.out },
    OUT: '/workspace/home-exit-back-compare.png',
  };
  fs.writeFileSync(path.join(OUT_DIR, 'exit_meta.json'), JSON.stringify(meta, null, 2));

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed.length + ' 项') + '（共 ' + results.length + ' 项）');
  ws.close(); proc.kill(); server.close();
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
