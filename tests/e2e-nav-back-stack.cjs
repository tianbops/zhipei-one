/* 返回序列真浏览器验证：首页按返回只能往桌面走，不得回到内页。
 *
 * 背景（2026-10-30 线上录屏）：首页按返回出现「再按一次退出」后，继续按会依次
 * 回到运单详情 → 历史查询 → 才退出。根因是站内 <a href> 每次点击都 push 历史，
 * zpDoExit 的连续 back() 把残留页逐个穿过去。
 *
 * 修法：站内导航一律 location.replace。本脚本用真实 Chromium 验证三件事：
 *   1. 点击底栏跳转后 history.length 不增长（replace 生效）；
 *   2. 连续返回的路径序列里不出现已经离开的内页（不回历史页/线路页）；
 *   3. 最终离开站点（等价退桌面）。
 *
 * 用法（需要本机 chromium，不进 npm test）：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-nav-back-stack.cjs
 *
 * 自带静态服务器：线上 Pages 是 pretty URL（/pages/history 无扩展名），
 * python -m http.server 会 404，导致测的不是真实页面。这里自己做
 * 「无扩展名 → .html」映射，与线上一致。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
};
function startServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let p = decodeURIComponent(u.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const base = path.join(ROOT, p);
      const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => {
        try {
          return fs.statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!hit) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
      fs.createReadStream(hit).pipe(res);
    });
    srv.listen(port, () => resolve(srv));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(JSON.parse(d)));
      })
      .on('error', rej);
  });

/* 只桩掉鉴权与数据接口，保留真实静态资源与真实 back.js —— 验证的正是后者。 */
const STUB = `
try{var _m=sessionStorage.getItem('__ME');window.__ME=_m?JSON.parse(_m):null}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?401:200};o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);return Promise.resolve(o)};
 if(s.indexOf('/api/me')===0){
   if(!window.__ME) return B('{"error":"unauthorized"}',false);
   return B(JSON.stringify({success:true,user:window.__ME}));
 }
 if(s.indexOf('/api/history')===0)return B('{"success":true,"history":[],"days":[]}');
 if(s.indexOf('/api/waybills')===0)return B('{"success":true,"waybills":[]}');
 if(s.indexOf('/api/routes')===0)return B('{"success":true,"routes":[]}');
 if(s.indexOf('/api/today')===0)return B('{"success":true,"waybills":[]}');
 if(s.indexOf('/api/')===0)return B('{"success":true}');
 return real(u,o)};})();`;

const PORT = Number(process.env.PORT || 8099);
const PORT_CDP = Number(process.env.PORT_CDP || 9234);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

(async () => {
  const server = await startServer(PORT);
  const proc = spawn(
    CHROMIUM,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=' + PORT_CDP,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await sleep(2600);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) {
    console.error('无法启动 Chromium（检查 CHROMIUM 路径）');
    process.exit(1);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (m, p, s) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const q = pend.get(m.id);
      pend.delete(m.id);
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
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text).slice(0, 160));
    return r.result.value;
  };
  const where = () => ev('location.pathname + location.search');
  const waitReady = async (ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const st = await ev('document.readyState');
        const n = await ev('document.body ? document.body.children.length : 0');
        if (st === 'complete' && n > 0) return true;
      } catch {}
      await sleep(200);
    }
    return false;
  };
  const hlen = () => ev('history.length');

  console.log('0) 以司机身份进入首页（历史栈起点）');
  await C('Page.navigate', { url: BASE + '/home.html' });
  await sleep(1500);
  await ev(
    'sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}));' +
      'sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");',
  );
  await ev('location.replace("/home.html")');
  await waitReady();
  await sleep(600);
  const p0 = await where();
  const len0 = await hlen();
  console.log('   落位 :', p0, '| history.length =', len0);

  console.log('\n1) 点底栏「历史」（<a href> 应被拦成 replace，栈不增长）');
  await ev('document.querySelector(\'a.zp-nav-item[href*="history"]\').click()');
  await waitReady();
  await sleep(600);
  const p1 = await where();
  const len1 = await hlen();
  console.log('   落位 :', p1, '| history.length =', len1);
  check('点底栏后到达历史页', p1.indexOf('/pages/history') === 0, p1);
  check('历史栈未增长（replace 生效）', len1 === len0, len0 + ' → ' + len1);

  console.log('\n2) 从历史页点底栏「线路」');
  const links = await ev('[...document.querySelectorAll("a")].map(a=>a.getAttribute("href")).filter(Boolean)');
  console.log('   本页链接 :', JSON.stringify(links.slice(0, 12)));
  await ev('[...document.querySelectorAll("a")].find(a=>(a.getAttribute("href")||"").indexOf("dispatch")>=0).click()');
  await waitReady();
  await sleep(600);
  const p2 = await where();
  const len2 = await hlen();
  console.log('   落位 :', p2, '| history.length =', len2);
  check('点底栏后到达线路页', p2.indexOf('/pages/dispatch') === 0, p2);
  check('历史栈仍未增长', len2 === len1, len1 + ' → ' + len2);

  console.log('\n3) 连续按返回，记录每一步落点（关键：不得回内页）');
  const seq = [];
  for (let i = 0; i < 5; i++) {
    let landed = '(已离开站点)';
    try {
      await ev('history.back()');
    } catch {}
    await sleep(1600);
    try {
      landed = await where();
    } catch {
      landed = '(已离开站点)';
    }
    seq.push(landed);
    console.log('   第 ' + (i + 1) + ' 次返回 →', landed);
    if (landed === '(已离开站点)') break;
  }

  console.log('\n4) 判定');
  check(
    '返回序列中不出现已离开的历史页',
    !seq.some((p) => String(p).indexOf('/pages/history') === 0),
    seq.join(' → '),
  );
  check(
    '返回序列中不出现已离开的线路页',
    !seq.some((p) => String(p).indexOf('/pages/dispatch') === 0),
    seq.join(' → '),
  );
  const isHome = (p) => String(p).indexOf('/home') === 0;
  const isInner = (p) => String(p).startsWith('/pages/');
  check(
    '返回方向始终朝首页/桌面（不落回任何内页）',
    seq.every((p) => isHome(p) || !isInner(p)),
    seq.join(' → '),
  );
  const firstBack = seq[0];
  check('第一次返回即回到首页', String(firstBack).indexOf('/home') === 0, String(firstBack));

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0 ? '✅ 全部通过' : '❌ 失败 ' + failed.length + ' 项') + '（共 ' + results.length + ' 项）');
  ws.close();
  proc.kill();
  server.close();
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
