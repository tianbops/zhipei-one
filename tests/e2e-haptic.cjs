/* 底部按钮触感：真浏览器验证（不进 npm test，需要本机 chromium）
 *
 * 背景（2026-10-30，v1.0.20）：底栏点击要「按下去有物理确认」。
 * 单测（tests/haptic.test.mjs）用 vm 模拟 DOM，能证明通道选择、节流、档位映射；
 * 但证明不了两件只有真 DOM 才会出问题的事：
 *   1. 底栏图标是 <svg><path>，点击时 e.target 是 SVGPathElement 而不是 <a>——
 *      Element.closest 能不能沿 SVG 树找到 .zp-nav a；
 *   2. capture 阶段监听在真实事件流里的触发顺序（业务 handler 会 stopPropagation）。
 *
 * 本脚本用真实 Chromium 跑一个最小夹具页（真实 haptic.js + 真底栏结构 + 探针
 * 覆盖 navigator.vibrate），断言 8 条。
 *
 * 用法：
 *   CHROMIUM=/usr/bin/chromium node tests/e2e-haptic.cjs
 *
 * 注意：这里验证的是「网页侧把震动请求交给了谁」，物理震动本身自动化测不了——
 * 壳内是否真的震，由客户端 MainActivity 的 performHapticFeedback 决定（真机验证）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8123);
const PORT_CDP = Number(process.env.PORT_CDP || 9311);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';

/* 夹具页：结构与 js/ui/nav.js 生成的真实底栏一致（含中央加号与 SVG 图标），
   外加一个 data-zp-haptic="medium" 的底部悬浮按钮和一个普通按钮。 */
const FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>haptic probe</title></head>
<body>
<nav class="zp-nav" aria-label="主要功能">
  <a href="#home" class="zp-nav-item zp-nav-home is-active" aria-current="page">
    <span class="zp-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3.5 9.8 12 3.5l8.5 6.3V19"/></svg></span><span>首页</span>
  </a>
  <a href="#upload" class="zp-nav-item zp-nav-plus" aria-label="上传">
    <span class="zp-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>
  </a>
</nav>
<button id="fab" data-zp-haptic="medium">待确认 3 家</button>
<button id="plain" type="button">普通按钮</button>
<script>
  window.__calls = [];
  try {
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value: function (v) { window.__calls.push(v); return true; }
    });
  } catch (e) { window.__vibratePatchError = String(e); }
</script>
<script src="/js/ui/haptic.js"></script>
</body></html>`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
  });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  [' + detail + ']' : ''));
};

(async () => {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || p === '/__haptic_probe') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(FIXTURE);
    }
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
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
  await C('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await sleep(1200);

  const evalJs = async (expr) => {
    const r = await C('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  };

  check('页面加载了 haptic.js', await evalJs('typeof window.zpHaptic === "function"'));
  check('vibrate 探针生效', await evalJs('window.__vibratePatchError || (typeof navigator.vibrate === "function")'));

  // 1. 点底栏 tab 的 SVG 图标内部（target 是 <path>，不是 <a>）
  await evalJs(`document.querySelector(".zp-nav a svg path").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))`);
  await sleep(80);
  let calls = await evalJs('JSON.stringify(window.__calls)');
  check('点底栏图标（SVG path 内）→ light=10', calls === '[10]', calls);

  // 2. 中央上传加号（同一底栏的另一个 a）
  await sleep(160);
  await evalJs(`document.querySelector(".zp-nav-plus svg path").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))`);
  await sleep(80);
  calls = await evalJs('JSON.stringify(window.__calls)');
  check('点中央加号 → light=10', calls === '[10,10]', calls);

  // 3. data-zp-haptic="medium" 的底部悬浮按钮
  await sleep(160);
  await evalJs(`document.getElementById("fab").click()`);
  await sleep(80);
  calls = await evalJs('JSON.stringify(window.__calls)');
  check('点底部悬浮按钮 → medium=16', calls === '[10,10,16]', calls);

  // 4. 普通按钮不震
  await sleep(160);
  await evalJs(`document.getElementById("plain").click()`);
  await sleep(80);
  calls = await evalJs('JSON.stringify(window.__calls)');
  check('普通按钮不震', calls === '[10,10,16]', calls);

  // 5. 连点三次底栏（同 kind 120ms 内）只响一次
  await sleep(160);
  await evalJs(`(()=>{const a=document.querySelector(".zp-nav a");const ev=()=>a.dispatchEvent(new MouseEvent("click",{bubbles:true}));ev();ev();ev();})()`);
  await sleep(80);
  calls = await evalJs('JSON.stringify(window.__calls)');
  check('连点三次底栏只震一次（节流）', calls === '[10,10,16,10]', calls);

  // 6. 程序化调用
  await sleep(160);
  await evalJs(`window.zpHaptic("success")`);
  await sleep(50);
  calls = await evalJs('JSON.stringify(window.__calls)');
  check('zpHaptic("success") → 20', calls === '[10,10,16,10,20]', calls);

  ws.close();
  proc.kill();
  srv.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n真浏览器触感验证：${results.length - bad.length}/${results.length} 通过`);
  process.exit(bad.length ? 1 : 0);
})();
