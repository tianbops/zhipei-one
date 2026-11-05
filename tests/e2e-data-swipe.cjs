/* 数据中心列表手势真浏览器回归（2026-11-05）
 * ------------------------------------------------------------------
 * 用法：CHROMIUM=/usr/bin/chromium node tests/e2e-data-swipe.cjs
 *
 * 为什么必须真浏览器：右滑误删是触摸事件分支里的一行判断，静态断言只能证明
 * 代码长什么样，证明不了「手指划过去门店会不会消失」。这里用 CDP 真派发
 * touchStart / touchMove / touchEnd，覆盖：
 *   右滑不删、纵向滚动不误触、轻点不误触、左滑展开 / 右滑收起、
 *   删除必须二次确认（取消不生效 / 确认才删）、确认后提交落库。
 *
 * 离线环境不打外网：/api/dispatch 与 /api/base 由 STUB 直接回数据。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.OUT_DIR || path.join(os.tmpdir(), 'zp-e2e-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 8157);
const PORT_CDP = Number(process.env.PORT_CDP || 9337);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

/* 故意混排：S1 / S3 有导航链接（门店名渲染成 <a class="data-store-nav">，
   即「保存即定位」后的真实形态），S2 没有链接（门店名是 <strong>）。
   2026-11-05 回归：手势曾把 .data-store-nav 上的起手排除掉，导致有链接的
   那批门店整个左滑没反应 —— 用户反馈「有一部分门店不能左滑了」。
   有链接的两家带坐标，避免提交时触发自动定位干扰本用例。 */
const STORES = [
  { storeId: 'S1', name: '谊品生鲜长安锦绣城店', navigation: 'https://surl.amap.com/abc', lat: 29.600741, lng: 106.525818, address: '佳园路2号', routeOrder: 1, aliases: [] },
  { storeId: 'S2', name: '渝北中景隆贸易', navigation: '', lat: null, lng: null, address: '', routeOrder: 2, aliases: [] },
  { storeId: 'S3', name: '到家主城加州客服中心', navigation: 'https://uri.amap.com/navigation?to=106.5,29.5,x&mode=car', lat: 29.5807, lng: 106.5301, address: '', routeOrder: 3, aliases: [] },
];

const STUB = `
try{sessionStorage.setItem('zpAuth','1');sessionStorage.setItem('zpRole','user');localStorage.setItem('zp_appearance_theme','light')}catch(e){}
(function(){
  var stores=${JSON.stringify(STORES)};
  window.__puts=[];window.__navClicks=[];
  /* 统计「会真的跳转」的门店名链接点击：capture 记下候选，冒泡阶段看
     defaultPrevented —— 被页面手势抑制掉的 click 不计入（那正是要验证的），
     正常轻点链接会计入。最后无条件 preventDefault，避免测试环境真去打开
     target=_blank 的外网标签页，把无头 Chromium 卡在外部请求上。 */
  var navCandidate=null;
  document.addEventListener('click',function(e){
    navCandidate=e.target&&e.target.closest?e.target.closest('.data-store-nav'):null;
  },true);
  document.addEventListener('click',function(e){
    if(!navCandidate)return;
    if(!e.defaultPrevented)window.__navClicks.push(navCandidate.getAttribute('href'));
    e.preventDefault();navCandidate=null;
  },false);
  var real=window.fetch;
  var B=function(t){var r={ok:true,status:200,headers:{get:function(){return null},has:function(){return false}}};r.json=function(){return Promise.resolve(JSON.parse(t))};r.text=function(){return Promise.resolve(t)};r.clone=function(){return B(t)};return Promise.resolve(r)};
  window.fetch=function(u,o){
    var s=String(u&&u.url||u),m=String((o&&o.method)||'GET').toUpperCase();
    if(s.indexOf('/api/dispatch')>=0)return B(JSON.stringify({success:true,dispatchRoute:{id:'r1',name:'一号线'}}));
    if(s.indexOf('/api/base')>=0){
      if(m==='PUT'){
        var put=JSON.parse((o&&o.body)||'{}');
        window.__puts.push(put);
        return B(JSON.stringify({success:true,base:{version:2,stores:put.stores}}));
      }
      return B(JSON.stringify({success:true,canMaintain:true,route:{id:'r1',name:'一号线'},base:{version:1,stores:stores}}));
    }
    if(s.indexOf('/api/')>=0)return B('{"success":true}');
    return real.apply(this,arguments);
  };
})();`;

/* 一次快照：行数 / 隐藏行 / 展开行 / 确认框 / PUT 次数 / 门店名 */
const SNAP = `(()=>{
  const rows=[...document.querySelectorAll('.data-store-row')];
  const box=document.querySelector('.zp-confirm');
  const open=rows.find(r=>r.classList.contains('data-swipe-open'));
  return {
    rows:rows.length,
    hidden:document.querySelectorAll('.data-store-hidden').length,
    open:!!open,
    openIndex:open?Number(open.dataset.index):-1,
    names:rows.map(r=>(r.querySelector('.data-store-name')||{}).textContent||''),
    navLinks:document.querySelectorAll('.data-store-nav').length,
    navClicks:window.__navClicks.length,
    confirm:!!box&&!box.hidden,
    confirmTitle:box?(box.querySelector('#zpConfirmTitle')||{}).textContent||'':'',
    puts:window.__puts.length,
  };
})()`;

(async () => {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const H = { 'cache-control': 'no-store' };
    if (p === '/sw.js') { res.writeHead(404, H); return res.end(''); }
    const base = path.join(ROOT, p);
    const hit = [base, base + '.html', path.join(base, 'index.html')].find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!hit) { res.writeHead(404, H); return res.end('404'); }
    res.writeHead(200, { ...H, 'content-type': MIME[path.extname(hit)] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  });
  await new Promise((r) => srv.listen(PORT, r));
  const proc = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + PORT_CDP, 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } });
  await new Promise((r) => { if (ws.readyState === WebSocket.OPEN) return r(); ws.addEventListener('open', r, { once: true }); });
  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId; const C = (m, p) => send(m, p, sid);
  await C('Page.enable'); await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  const ev = async (s) => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { err: String(r.exceptionDetails.text).slice(0, 200) }; return r.result.value; };

  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await C('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await C('Page.navigate', { url: BASE + '/pages/data.html' });
  await sleep(1800);

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };

  /* 把第一行滚到视口中部，取一个落在行内的起手点 */
  const rect = await ev(`(()=>{const r=document.querySelectorAll('.data-store-row')[0];if(!r)return null;r.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),w:Math.round(b.width),h:Math.round(b.height)}})()`);
  console.log('row rect ' + JSON.stringify(rect));
  check('门店行可定位（页面正常加载、列表已渲染）', !!rect && rect.w > 200, JSON.stringify(rect));
  if (!rect) { proc.kill('SIGKILL'); srv.close(); process.exit(1); }

  const touch = (type, x, y) => C('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y, id: 1 }] });
  const gesture = async (x0, y0, x1, y1, steps = 8) => {
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      await sleep(14);
    }
    await touch('touchEnd', x1, y1);
    await sleep(220);
  };
  const centerY = rect.y;
  const LEFT = 110, RIGHT = 300;

  const snap0 = await ev(SNAP);
  check('初始渲染 3 家门店', snap0 && snap0.rows === 3, JSON.stringify(snap0 && snap0.names));

  /* ① 右滑 190px：这是出 bug 的那个手势，门店必须原封不动 */
  await gesture(LEFT, centerY, RIGHT, centerY);
  const s1 = await ev(SNAP);
  check('右滑 190px 后 3 家门店仍在（不再被抹掉）', s1 && s1.rows === 3, JSON.stringify(s1 && s1.names));
  check('右滑不产生隐藏行 / 展开态 / 提交 / 确认框', s1 && s1.hidden === 0 && !s1.open && s1.puts === 0 && !s1.confirm, JSON.stringify(s1));

  /* ② 纵向滚动（带横向偏移）：方向锁定必须把它判成滚动，而不是一次右滑 */
  await gesture(180, centerY, 240, centerY + 220);
  const s2 = await ev(SNAP);
  check('纵向滚动带横向偏移也不会误删 / 误展开', s2 && s2.rows === 3 && s2.hidden === 0 && !s2.open, JSON.stringify(s2));

  /* ③ 轻点（无位移）不该触发任何滑动动作 */
  await touch('touchStart', LEFT + 30, centerY);
  await touch('touchEnd', LEFT + 30, centerY);
  await sleep(200);
  const s3 = await ev(SNAP);
  check('轻点行不误触展开或删除', s3 && s3.rows === 3 && !s3.open && s3.hidden === 0, JSON.stringify(s3));

  /* ④ 左滑：露出编辑/删除动作条 */
  await gesture(RIGHT, centerY, LEFT, centerY);
  const s4 = await ev(SNAP);
  check('左滑露出动作条（行进入 data-swipe-open）', s4 && s4.open === true && s4.openIndex === 0, JSON.stringify(s4));
  const btnVisible = await ev(`(()=>{const b=document.querySelector('.data-store-row.data-swipe-open [data-swipe-delete]');if(!b)return false;return getComputedStyle(b).visibility==='visible'})()`);
  check('动作条里的删除按钮可见', btnVisible === true, String(btnVisible));

  /* ⑤ 右滑：只收起动作条，仍不删任何东西 */
  await gesture(LEFT, centerY, RIGHT, centerY);
  const s5 = await ev(SNAP);
  check('右滑收起动作条但门店数不变', s5 && s5.open === false && s5.rows === 3 && s5.puts === 0, JSON.stringify(s5));

  /* ⑤b 有导航链接的门店：门店名是 <a data-store-nav>，必须在链接上起手也能左滑。
     这是「有一部分门店不能左滑」的回归点 —— 手势曾把链接上的起手整批排除。 */
  const navRect = await ev(`(()=>{const a=document.querySelector('.data-store-row[data-index="0"] .data-store-nav');if(!a)return null;const b=a.getBoundingClientRect();return {l:Math.round(b.left),r:Math.round(b.right),y:Math.round(b.top+b.height/2)}})()`);
  check('带导航链接的门店名渲染成可点链接', !!navRect && navRect.r > navRect.l, JSON.stringify(navRect));
  const navX = Math.min((navRect ? navRect.r : 200) - 15, 260);
  const navX1 = Math.max(navX - 180, 20);
  const navY = navRect ? navRect.y : centerY;
  const clicksBefore = (await ev(SNAP)).navClicks;
  await gesture(navX, navY, navX1, navY);
  const sNav = await ev(SNAP);
  check('在门店名链接上起手左滑，也能展开动作条', sNav && sNav.open === true && sNav.openIndex === 0, JSON.stringify(sNav && { open: sNav.open, openIndex: sNav.openIndex, rows: sNav.rows }));
  check('左滑不会误触发门店名链接跳地图', sNav && sNav.navClicks === clicksBefore, JSON.stringify(sNav && { before: clicksBefore, after: sNav.navClicks }));

  /* ⑤c 无链接的门店同样能左滑（两类门店都要覆盖） */
  const plainRect = await ev(`(()=>{const a=document.querySelector('.data-store-row[data-index="1"] .data-store-name');if(!a)return null;const b=a.getBoundingClientRect();return {y:Math.round(b.top+b.height/2)}})()`);
  const plainY = plainRect ? plainRect.y : centerY;
  await gesture(RIGHT, plainY, LEFT, plainY);
  const sPlain = await ev(SNAP);
  check('无导航链接的门店也能左滑展开', sPlain && sPlain.open === true && sPlain.openIndex === 1, JSON.stringify(sPlain && { open: sPlain.open, openIndex: sPlain.openIndex }));
  await gesture(LEFT, centerY, RIGHT, centerY);/* 收起，保持后续用例干净 */

  /* ⑤d 极快一划：只派发 1 次 touchMove，方向锁定来不及多次采样也必须能识别 */
  await gesture(RIGHT, centerY, LEFT, centerY, 1);
  const sFast = await ev(SNAP);
  check('极快一划（仅 1 次 touchmove）也能左滑展开', sFast && sFast.open === true && sFast.openIndex === 0, JSON.stringify(sFast && { open: sFast.open, openIndex: sFast.openIndex }));
  await gesture(LEFT, centerY, RIGHT, centerY);/* 收起，保持后续用例干净 */

  /* ⑥ 删除必须二次确认，取消不生效 */
  await gesture(RIGHT, centerY, LEFT, centerY);
  await ev(`(()=>{const b=document.querySelector('[data-swipe-delete="0"]');if(b)b.click();return 1})()`);
  await sleep(280);
  const s6 = await ev(SNAP);
  check('点删除弹出「删除门店」确认框（不是直接删）', s6 && s6.confirm === true && /删除门店/.test(s6.confirmTitle), JSON.stringify(s6 && { confirm: s6.confirm, title: s6.confirmTitle }));
  await ev(`(()=>{const b=document.querySelector('.zp-confirm [data-zp-cancel]');if(b)b.click();return 1})()`);
  await sleep(280);
  const s7 = await ev(SNAP);
  check('确认框点取消后 3 家门店仍在', s7 && s7.rows === 3 && !s7.confirm, JSON.stringify(s7));

  /* ⑦ 确认后才真删（本地暂存），提交后落库 */
  await gesture(RIGHT, centerY, LEFT, centerY);
  await ev(`(()=>{const b=document.querySelector('[data-swipe-delete="0"]');if(b)b.click();return 1})()`);
  await sleep(250);
  await ev(`(()=>{const b=document.querySelector('.zp-confirm [data-zp-ok]');if(b)b.click();return 1})()`);
  await sleep(320);
  const s8 = await ev(SNAP);
  check('确认框点确定后才删除该门店（剩 2 家）', s8 && s8.rows === 2 && s8.puts === 0, JSON.stringify(s8));
  await ev(`(()=>{const b=document.getElementById('saveStoresTop');if(b)b.click();return 1})()`);
  await sleep(700);
  const s9 = await ev(SNAP);
  const putOk = await ev(`(()=>{const p=window.__puts[0];return !!p&&p.stores.length===2&&p.stores[0].name==='渝北中景隆贸易'})()`);
  check('提交更新把删除结果真正落库（PUT 里 2 家）', s9 && s9.puts === 1 && putOk === true, JSON.stringify({ puts: s9 && s9.puts, putOk }));

  const shot = await C('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'data_swipe.png'), Buffer.from(shot.data, 'base64'));

  const fails = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过');
  proc.kill('SIGKILL');
  srv.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
