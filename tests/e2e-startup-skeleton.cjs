/* 启动显示优化：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30）：启动序列优化 —— 首页骨架屏 + 本地快照秒开（SWR）。
 *
 * 为什么必须真浏览器：
 *   1. 「快照先行」依赖脚本执行时序（defer 脚本同步渲染快照 → readyState complete
 *      时数据必须已在屏上），这是时序行为，单测验不了；
 *   2. 「网络未返回时快照已在屏」需要真的把 fetch 拖慢才能证明是快照而非新数据；
 *   3. 「无快照 + 请求失败 → 趋势卡回退 hidden、骨架不永久停留」是失败路径，
 *      只有真跑 fetch 失败才能覆盖。
 *
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-startup-skeleton.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8137);
const PORT_CDP = Number(process.env.PORT_CDP || 9318);
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

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ym = today.slice(0, 7);
const [yy, mm] = ym.split('-').map(Number);
const m1 = new Date(Date.UTC(yy, mm - 2, 1)).toISOString().slice(0, 7);

const HISTORY = [
  { date: ym + '-01', count: 1, storeCount: 6, totalWeight: 150.125 },
  { date: today, count: 1, storeCount: 23, totalWeight: 1.5055 },
  { date: m1 + '-15', count: 1, storeCount: 7, totalWeight: 210.5 },
];
const MONTHS = [
  { month: ym, days: 2, waybills: 2, totalStores: 29, totalWeight: 151.63 },
  { month: m1, days: 1, waybills: 1, totalStores: 7, totalWeight: 210.5 },
];
const WAYBILL = {
  id: 'w1', routeId: 'r1', routeName: '17号线', date: today,
  summary: { finalCount: 23, total: 23 },
  totalWeight: 1.5055,
  stores: Array.from({ length: 23 }, (_, i) => ({ name: '门店' + (i + 1) })),
};
const BOOTSTRAP = {
  success: true,
  dispatchRoute: { id: 'r1', name: '17号线', type: 'fixed' },
  user: { id: 9, username: 'driver', role: 'user', name: '司机', boundRouteId: 'r1' },
};

/* fetch 桩：sessionStorage 开关控制行为
 *   __DELAY=毫秒  所有 /api 响应延迟（验证「网络未回、快照已在屏」）
 *   __FAILHIST=1  /api/history 返回 500（验证无快照失败回退）
 *   __netDone     任一 /api 响应真正返回后置 true（证明屏上是快照不是网络） */
const STUB = `
try{sessionStorage.setItem("zpAuth","1");sessionStorage.setItem("zpRole","user")}catch(e){}
try{var _m=JSON.parse(sessionStorage.getItem('__ME')||'null');window.__ME=_m}catch(e){window.__ME=null}
window.__netDone=false;
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>{const o={ok:ok!==false,status:ok===false?500:200,headers:{get:()=>null,has:()=>false}};
   o.json=()=>Promise.resolve(JSON.parse(t));o.text=()=>Promise.resolve(t);o.clone=()=>B(t,ok);return Promise.resolve(o)};
 const delayMs=Number(sessionStorage.getItem('__DELAY'))||0;
 const out=(t,ok)=>{const p=delayMs?new Promise(r=>setTimeout(r,delayMs)):Promise.resolve();
   return p.then(()=>{window.__netDone=true;return B(t,ok)})};
 if(s.indexOf('/api/history')===0){
   if(sessionStorage.getItem('__FAILHIST'))return out('{"error":"boom"}',false);
   return out(${JSON.stringify(JSON.stringify({ success: true, routeId: 'r1', history: HISTORY, months: MONTHS }))});
 }
 if(s.indexOf('/api/home-bootstrap')===0)return out(${JSON.stringify(JSON.stringify(BOOTSTRAP))});
 if(s.indexOf('/api/waybills/latest')===0){
   if(sessionStorage.getItem('__FAILHIST'))return out('{"error":"boom"}',false);
   return out(${JSON.stringify(JSON.stringify({ success: true, waybill: WAYBILL, dayCount: 1 }))});
 }
 if(s.indexOf('/api/')===0)return out('{"success":true,"waybills":[],"history":[],"days":[],"routes":[],"stats":{}}');
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
  const waitExpr = async (expr, ms = 9000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr)) return true; } catch {}
      await sleep(150);
    }
    return false;
  };
  const txt = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.trim():null})()`);

  try {
    /* ---------- 阶段 A：首次访问（无快照）——骨架被数据替换，快照落盘 ---------- */
    console.log('\n[阶段A] 首次访问：数据到达替换骨架 + 快照落盘');
    await C('Page.navigate', { url: BASE + '/home.html' });
    await waitReady();
    await waitExpr("localStorage.getItem('zp_home_hist_v1')!==null");
    await waitExpr("!document.querySelector('#todayStoreList .skel-bar')");

    check('今日卡列表骨架已被真实门店替换', !(await ev("!!document.querySelector('#todayStoreList .skel-bar')")));
    check('今日卡摘要为新数据（23家）', (await txt('#todayCount')) === '23家', String(await txt('#todayCount')));
    check('今日单量来自 dayCount（1单）', (await txt('#todayOrders')) === '1单', String(await txt('#todayOrders')));
    check('重量 3 位小数（1.506t）', (await txt('#todayWeight')) === '1.506t', String(await txt('#todayWeight')));
    check('趋势卡骨架态已移除（is-skel）', (await ev("document.getElementById('trendCard').classList.contains('is-skel')")) === false);
    check('趋势卡可见且已渲染', (await ev("document.getElementById('trendCard').hidden")) === false &&
      (await ev("document.querySelectorAll('#trendPoints circle').length")) > 0);
    check('数据态下骨架条已隐藏（computed display:none）', (await ev("getComputedStyle(document.querySelector('#trendCard .skel-chart')).display")) === 'none');
    check('今日快照已落盘（含当天日期）', (await ev("JSON.parse(localStorage.getItem('zp_home_today_v1')).date")) === today);
    check('历史快照已落盘（13 个月窗口）', (await ev("JSON.parse(localStorage.getItem('zp_home_hist_v1')).d.history.length")) === HISTORY.length);

    /* ---------- 阶段 B：慢网络重访——快照秒开，网络未回数据已在屏 ---------- */
    console.log('\n[阶段B] 慢网络重访：readyState complete 时快照已在屏、网络未返回');
    await ev("sessionStorage.setItem('__DELAY','3500')");
    await C('Page.navigate', { url: BASE + '/home.html' });
    await waitReady();
    await sleep(400); // defer 脚本同步渲染快照；此刻 fetch 还在 3.5s 延迟里

    check('网络确实尚未返回', (await ev('window.__netDone')) === false);
    check('今日卡摘要来自快照（23家）', (await txt('#todayCount')) === '23家', String(await txt('#todayCount')));
    check('今日卡重量来自快照（1.506t）', (await txt('#todayWeight')) === '1.506t', String(await txt('#todayWeight')));
    check('趋势卡快照先行出图（无 is-skel）', (await ev("document.getElementById('trendCard').classList.contains('is-skel')")) === false);
    check('趋势卡图表已有数据点', (await ev("document.querySelectorAll('#trendPoints circle').length")) > 0);
    await waitExpr('window.__netDone===true', 9000);
    check('新数据返回后今日卡仍正确（SWR 覆盖渲染）', (await txt('#todayCount')) === '23家', String(await txt('#todayCount')));
    await ev("sessionStorage.removeItem('__DELAY')");

    /* ---------- 阶段 C：无快照 + 历史请求失败——骨架回退 hidden，不永久停留 ---------- */
    console.log('\n[阶段C] 无快照 + 请求失败：趋势卡回退 hidden、今日卡收敛空态');
    await ev("localStorage.clear();sessionStorage.setItem('__FAILHIST','1')");
    await C('Page.navigate', { url: BASE + '/home.html' });
    await waitReady();
    await waitExpr("String(document.getElementById('todayCount').textContent)==='暂无运单'", 15000);

    check('趋势卡回退 hidden（旧行为）', (await ev("document.getElementById('trendCard').hidden")) === true);
    check('今日卡收敛为空态（暂无运单）', (await txt('#todayCount')) === '暂无运单', String(await txt('#todayCount')));
    check('今日卡列表无骨架残留', !(await ev("!!document.querySelector('#todayStoreList .skel-bar')")));
  } finally {
    try { await C('Page.close'); } catch {}
    try { ws.close(); } catch {}
    try { proc.kill(); } catch {}
    srv.close();
  }

  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('e2e 异常:', e); process.exit(1); });
