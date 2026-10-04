/* 漏洞复现 + 双向验证：管理员页背后就是司机首页时，一次 stray 返回会不会穿过去 */
/* 管理员端「返回穿越到业务端」漏洞的真浏览器复现。
 *
 * 自动化单测（tests/nav-return.test.mjs）只能验证 zpHandleBack 的分支逻辑，
 * 验证不了 history 栈 / popstate 时序这类真实时序问题 —— 这个脚本补的就是这一块。
 *
 * 用法（不算入 npm test 套件，需要本机 chromium）：
 *   python3 -m http.server 8099 --directory . &
 *   CHROMIUM=/usr/bin/chromium PORT=8099 node tests/e2e-admin-back-leak.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });

const STUB = `
try{var _m=sessionStorage.getItem('__ME');window.__ME=_m?JSON.parse(_m):null}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>Promise.resolve({ok:ok!==false,status:ok===false?401:200,json:()=>Promise.resolve(JSON.parse(t)),text:()=>Promise.resolve(t)});
 if(s.indexOf('/api/me')===0){
   if(!window.__ME) return B('{"error":"unauthorized"}',false);
   return B(JSON.stringify({success:true,user:window.__ME}));
 }
 if(s.indexOf('/api/admin/users')===0)return B('{"success":true,"users":[]}');
 if(s.indexOf('/api/routes')===0)return B('{"success":true,"routes":[]}');
 if(s.indexOf('/api/admin/route-requests')===0)return B('{"success":true,"requests":[]}');
 if(s.indexOf('/api/invite-codes')===0)return B('{"success":true,"invites":[]}');
 return real(u,o)};})();`;

const PORT = Number(process.env.PORT || 8099);
const PORT_CDP = Number(process.env.PORT_CDP || 9233);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';

(async () => {
  const proc = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + PORT_CDP, 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const ver = await getJSON('http://127.0.0.1:' + PORT_CDP + '/json/version').catch(() => null);
  if (!ver) { console.error('no browser'); process.exit(1); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p, s) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } };
  await new Promise(r => ws.onopen = r);
  const tg = await send('Target.createTarget', { url: 'about:blank' });
  const at = await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true });
  const sid = at.sessionId, C = (m, p) => send(m, p, sid);
  await C('Page.enable'); await C('Runtime.enable');
  await C('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await C('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const ev = async s => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text).slice(0, 160)); return r.result.value; };
  const where = async () => await ev('location.pathname');
  const toast = async () => await ev('(()=>{const t=document.getElementById("zpToast");return t?(t.className.indexOf("show")>=0?t.textContent:""):""})()');

  console.log('0) 先以司机身份进入业务首页，制造「管理员页背后就是司机首页」的历史栈');
  await C('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' }); await sleep(1500);
  await ev('sessionStorage.setItem("__ME",JSON.stringify({id:9,username:"driver",role:"user"}))');
  await C('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' }); await sleep(2000);
  console.log('   落位 :', await where());

  console.log('1) 再切成管理员会话进入管理端');
  await ev('sessionStorage.setItem("__ME",JSON.stringify({id:1,username:"root",role:"system_admin"}))');
  await ev('location.href="/admin.html"'); await sleep(2500);
  console.log('   落位 :', await where(), '| history.length =', await ev('history.length'));

  console.log('2) 第 1 次返回：应提示「再按一次」并留在管理端');
  await ev('history.back()'); await sleep(900);
  console.log('   落位 :', await where(), '| toast :', JSON.stringify(await toast()));

  console.log('3) 停顿 3 秒（超过 2 秒确认窗口，armed 已过期）后再返回一次');
  await sleep(3000);
  await ev('history.back()'); await sleep(1200);
  const after = await where();
  console.log('   落位 :', after, '| toast :', JSON.stringify(await toast()));

  console.log('');
  console.log(after === '/home.html'
    ? '❌ 漏洞仍在：一次返回后穿到了司机首页 /home.html'
    : '✅ 已封堵：仍停在管理端 ' + after);
  ws.close(); proc.kill();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
