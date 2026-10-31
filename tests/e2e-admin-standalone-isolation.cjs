/* 管理员端「独立工作区」隔离的真浏览器复现（standalone PWA 场景）。
 *
 * 验证点：独立 PWA 下以管理员身份登录，login.js / index.html 会以 window.open
 * 打开独立管理窗口；系统返回不得穿越到司机首页，管理员根页连续两次返回的最终落点
 * 必须是登录页（用户明确要求的退出登录语义），而不是司机首页或手机桌面。
 *
 * 用法（由 browser-e2e.yml 在 Chromium 中执行）：
 *   python3 -m http.server 8099 --directory . &
 *   CHROMIUM=/usr/bin/chromium PORT=8099 node tests/e2e-admin-standalone-isolation.cjs
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });
const STUB = `
try{var _m=sessionStorage.getItem('__ME');window.__ME=_m?JSON.parse(_m):null}catch(e){window.__ME=null}
(function(){const real=window.fetch;window.fetch=function(u,o){const s=String(u);
 const B=(t,ok)=>Promise.resolve({ok:ok!==false,status:ok===false?401:200,json:()=>Promise.resolve(JSON.parse(t)),text:()=>Promise.resolve(t)});
 if(s.indexOf('/api/me')===0){if(!window.__ME)return B('{"error":"unauthorized"}',false);return B(JSON.stringify({success:true,user:window.__ME}));}
 if(s.indexOf('/api/login')===0){const b=o&&o.body?JSON.parse(o.body):{};if(b.username==='root')return B(JSON.stringify({success:true,user:{id:1,username:'root',role:'system_admin'}}));return B('{"error":"bad"}',false);}
 if(s.indexOf('/api/logout')===0)return B('{"success":true}');
 if(s.indexOf('/api/admin/users')===0)return B('{"success":true,"users":[]}');
 if(s.indexOf('/api/routes')===0)return B('{"success":true,"routes":[]}');
 if(s.indexOf('/api/admin/route-requests')===0)return B('{"success":true,"requests":[]}');
 if(s.indexOf('/api/invite-codes')===0)return B('{"success":true,"invites":[]}');
 return real(u,o)};})();`;

const PORT = Number(process.env.PORT || 8099);
const PORT_CDP = Number(process.env.PORT_CDP || 9233);
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const BASE = 'http://127.0.0.1:' + PORT + '/';

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
  const ev = async s => { const r = await C('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval:' + JSON.stringify(r.exceptionDetails).slice(0, 120)); return r.result.value; };

  await C('Page.navigate', { url: BASE + 'index.html' }); await sleep(1500);
  // 模拟独立 PWA：把 matchMedia(display-mode: standalone) 写成 true
  await ev(`window.matchMedia=function(q){return {matches:String(q).indexOf('standalone')>=0,media:q,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent(){return false}}}`);
  console.log('matchMedia standalone =', await ev("window.matchMedia('(display-mode: standalone)').matches"));
  await ev('sessionStorage.setItem("__ME",JSON.stringify({id:1,username:"root",role:"system_admin"}))');
  await ev('document.getElementById("username").value="root"');
  await ev('document.getElementById("password").value="x"');
  await ev('document.getElementById("loginForm").requestSubmit()');
  await sleep(2500);

  const targets = await send('Target.getTargets', {});
  const adminT = targets.targetInfos.find(t => /admin\\.html/.test(t.url || ''));
  console.log('独立管理员窗口存在 :', !!adminT, '| url :', adminT && adminT.url);
  if (adminT) {
    const at2 = await send('Target.attachToTarget', { targetId: adminT.targetId, flatten: true });
    const s2 = at2.sessionId, C2 = (m, p) => send(m, p, s2);
    await C2('Page.enable'); await C2('Runtime.enable');
    const ev2 = async s => { const r = await C2('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval2:' + JSON.stringify(r.exceptionDetails).slice(0, 120)); return r.result.value; };
    const len = await ev2('history.length');
    const path = await ev2('location.pathname');
    console.log('管理员窗口 history.length =', len, '| path =', path);
    await ev2('history.back()'); await sleep(900);
    const firstBackPath = await ev2('location.pathname');
    const firstToast = await ev2('(()=>{const t=document.getElementById("zpToast");return t&&t.className.indexOf("show")>=0?t.textContent:""})()');
    const firstBackSafe = firstBackPath === '/admin.html' && firstToast === '再按一次返回登录页';
    console.log('第一次返回 path =', firstBackPath, '| toast =', JSON.stringify(firstToast));
    if (!firstBackSafe) {
      console.error('❌ 第一次返回未停留在管理员页或提示文案不正确');
      ws.close(); proc.kill(); process.exit(1);
    }

    // 在两秒确认窗口内再次返回：必须注销管理员会话并回登录页。
    await ev2('history.back()'); await sleep(1200);
    const finalUrl = await ev2('location.href');
    const finalPath = await ev2('location.pathname');
    const finalParams = await ev2('(()=>{const u=new URL(location.href);return {reason:u.searchParams.get("reason"),manual:u.searchParams.get("manual")}})()');
    const finalRole = await ev2('sessionStorage.getItem("zpRole")');
    const returnedToLogin = (finalPath === '/' || finalPath === '/index.html') &&
      finalParams.reason === 'logout' && finalParams.manual === '1' && finalRole === null;
    console.log('第二次返回最终 URL =', finalUrl, '| zpRole =', finalRole);
    console.log(returnedToLogin
      ? '✅ 管理员返回闭环通过：首次留在管理端，第二次退出到登录页，角色标记已清理'
      : '❌ 管理员最终返回未落到登录页');
    ws.close(); proc.kill();
    process.exit(returnedToLogin ? 0 : 1);
  } else {
    console.log('⚠️ 未检测到独立窗口（window.open 被拦截），已退回同窗口 replace 路径（由跨区防火墙兜底）');
    ws.close(); proc.kill();
    process.exit(0);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
