/* 历史页「被合并的运单」恢复入口：真浏览器验证
 *
 * 背景（2026-11-06）：同车同日两张单被旧规则误判重传，第 1 张被标 SUPERSEDED
 * 并移出索引，历史/首页/详情全部看不到。规则已改为一处不一致即不同运单；
 * 这一页是历史遗留数据的自救入口（回收站 → 被合并的运单 → 恢复这张）。
 *
 * 为什么必须 e2e：单测只能证明 listSuperseded / restoreSuperseded 的行为，
 * 证明不了三件真 DOM 才有的事：
 *   1. 回收站面板真的把「被合并的运单」渲染出来（不是只加了 class）；
 *   2. 点击走的是事件委托，且请求 URL 真的带 type=superseded&id=；
 *   3. 恢复成功后面板会重绘（不留「恢复中…」的死按钮）。
 *
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-history-superseded.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8144);
const PORT_CDP = Number(process.env.PORT_CDP || 9324);
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

const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const HISTORY = {
  success: true, routeId: 'r1', range: { start: now.slice(0, 4) + '-01-01', end: now },
  history: [{ date: now, count: 2, storeCount: 43, totalWeight: 2.221452 }],
};
const SUPERSEDED = {
  success: true, routeId: 'r1', type: 'superseded', supported: true, count: 1,
  items: [{ id: 'W-FIRST', date: now, vehicle: '渝DK7692', storeCount: 22, totalWeight: 1.150887, supersededBy: 'W-SECOND', supersededAt: now + 'T09:30:00.000Z' }],
};

const STUB = `
try{window.__restoreCalls=0;window.__restoreUrl=''}catch(e){}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u&&u.url||u);const M=(o&&o.method)||'GET';
 const B=(t,ok)=>{const r={ok:ok!==false,status:ok===false?401:200,headers:{get:()=>null,has:()=>false}};r.json=()=>Promise.resolve(JSON.parse(t));r.text=()=>Promise.resolve(t);r.clone=()=>B(t,ok);return Promise.resolve(r)};
 if(s.indexOf('/api/me')>=0)return B(JSON.stringify({success:true,user:{id:9,username:'driver',role:'user',boundRouteId:'r1'}}));
 if(s.indexOf('/api/history-trash')>=0){
   if(s.indexOf('type=superseded')>=0){
     if(M==='POST'){window.__restoreCalls++;window.__restoreUrl=s;return B(JSON.stringify({success:true,id:'W-FIRST',date:'${now}',message:'已恢复，当天恢复为多单'}))}
     return B(JSON.stringify(${JSON.stringify(SUPERSEDED)}));
   }
   return B(JSON.stringify({success:true,routeId:'r1',count:0,items:[]}));
 }
 if(s.indexOf('/api/history')>=0)return B(JSON.stringify(${JSON.stringify(HISTORY)}));
 if(s.indexOf('/api/')>=0)return B('{"success":true}');
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
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const ev = async (s) => {
    const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR ' + String(r.exceptionDetails.text).slice(0, 140);
    return r.result.value;
  };
  const waitReady = async (ms = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await ev('document.readyState')) === 'complete') return true; } catch {}
      await sleep(150);
    }
    return false;
  };

  await C('Page.navigate', { url: BASE + '/pages/history.html' });
  await sleep(900);
  await ev('sessionStorage.clear();sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user");');
  await C('Page.navigate', { url: BASE + '/pages/history.html?x=1' });
  await waitReady();
  await sleep(1500);

  check('落在历史页', (await ev('location.pathname')) === '/pages/history.html', String(await ev('location.pathname')));

  /* 1. 打开回收站：被合并区块必须出现在面板里 */
  await ev('(()=>{document.getElementById("historyTrashBtn").click();return 1})()');
  await sleep(900);
  const panel = await ev(`(()=>{
    const p=document.getElementById('historyOverlayPanel');
    const btn=p&&p.querySelector('.history-superseded-restore');
    return {
      open:!document.getElementById('historyOverlay').hidden,
      text:(p&&p.innerText||'').replace(/\\s+/g,' ').slice(0,220),
      hasBtn:!!btn, id:btn&&btn.dataset.id,
      hasHead:!!p&&p.innerText.indexOf('被合并的运单')>=0
    };
  })()`);
  check('回收站面板已打开且渲染「被合并的运单」', panel && panel.open === true && panel.hasHead === true, panel && panel.text);
  check('列出被合并运单并提供恢复按钮', panel && panel.hasBtn === true && panel.id === 'W-FIRST', JSON.stringify(panel));
  check('显示车牌/家数/重量，便于辨认', panel && /渝DK7692/.test(panel.text) && /22家/.test(panel.text) && /1\.151t/.test(panel.text), panel && panel.text);

  /* 2. 点击恢复：确认后发出 POST（type=superseded&id=W-FIRST） */
  await ev('window.zpConfirm=async()=>true;1');
  await ev('(()=>{document.querySelector(".history-superseded-restore").click();return 1})()');
  await sleep(900);
  const after = await ev('(()=>({calls:window.__restoreCalls,url:window.__restoreUrl}))()');
  check('恢复请求已发出且参数正确', after && after.calls === 1 && /type=superseded/.test(after.url) && /id=W-FIRST/.test(after.url), JSON.stringify(after));
  const redrawn = await ev(`(()=>{const b=document.querySelector('.history-superseded-restore');const p=document.getElementById('historyOverlayPanel');return {still:!!b,disabled:b?b.disabled:false,toast:!!document.querySelector('.ui-toast')}})()`);
  check('恢复后面板重绘（不留禁用中的死按钮）', redrawn && redrawn.disabled === false, JSON.stringify(redrawn));

  const ok = results.filter((r) => r.ok).length;
  console.log('\n结果: ' + ok + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
