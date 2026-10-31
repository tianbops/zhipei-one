/* 管理员端工作区隔离与最终返回的真浏览器回归（PWA 场景）。
 *
 * 当前产品以同一 PWA 窗口通过 location.replace 按角色进入管理员区，不创建第二个窗口。
 * 验证管理员根页第一次返回留在管理区，第二次返回注销并落到登录页，不穿越到司机首页。
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
(function(){const real=window.fetch;window.__LOGIN_FETCHES=[];window.fetch=function(u,o){const s=String(u);window.__LOGIN_FETCHES.push(s);
 const B=(t,ok)=>Promise.resolve(new Response(t,{status:ok===false?401:200,headers:{'content-type':'application/json'}}));
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
  console.log('登录表单状态 =', await ev('(()=>{const f=document.getElementById("loginForm"),u=document.getElementById("username"),p=document.getElementById("password");return {form:!!f,valid:f&&f.checkValidity(),username:u&&u.value,passwordLength:p&&p.value.length,loginScript:[...document.scripts].some(x=>x.src.includes("login.js"))}})()'));
  await ev('document.getElementById("loginForm").requestSubmit()');
  await sleep(2500);
  console.log('登录诊断 =', await ev('({fetches:window.__LOGIN_FETCHES||[],message:document.getElementById("loginMessage")?.textContent||"",button:document.getElementById("loginButton")?.textContent||"",role:sessionStorage.getItem("zpRole")})'));

  // 产品当前设计为同一 PWA 窗口内按角色 location.replace 进入管理员区，
  // 不会调用 window.open 创建第二个 Chrome target。验证原登录窗口已切换到管理员根页。
  const adminPath = await ev('location.pathname');
  console.log('管理员工作区当前窗口 path =', adminPath);
  if (adminPath !== '/admin' && adminPath !== '/admin.html') {
    console.error('❌ 登录后没有进入管理员工作区；实际路径：', adminPath);
    ws.close(); proc.kill(); process.exit(1);
  }

  const len = await ev('history.length');
  console.log('管理员窗口 history.length =', len, '| path =', adminPath);
  await ev('history.back()'); await sleep(900);
  const firstBackPath = await ev('location.pathname');
  const firstToast = await ev('(()=>{const t=document.getElementById("zpToast");return t&&t.className.indexOf("show")>=0?t.textContent:""})()');
  const firstBackSafe = (firstBackPath === '/admin' || firstBackPath === '/admin.html') && firstToast === '再按一次返回登录页';
  console.log('第一次返回 path =', firstBackPath, '| toast =', JSON.stringify(firstToast));
  if (!firstBackSafe) {
    console.error('❌ 第一次返回未停留在管理员页或提示文案不正确');
    ws.close(); proc.kill(); process.exit(1);
  }

  // 在两秒确认窗口内再次返回：必须注销管理员会话并回登录页。
  await ev('history.back()'); await sleep(1200);
  const finalUrl = await ev('location.href');
  const finalPath = await ev('location.pathname');
  const finalParams = await ev('(()=>{const u=new URL(location.href);return {reason:u.searchParams.get("reason"),manual:u.searchParams.get("manual")}})()');
  const finalRole = await ev('sessionStorage.getItem("zpRole")');
  const returnedToLogin = (finalPath === '/' || finalPath === '/index.html') &&
    finalParams.reason === 'logout' && finalParams.manual === '1' && finalRole === null;
  console.log('第二次返回最终 URL =', finalUrl, '| zpRole =', finalRole);
  console.log(returnedToLogin
    ? '✅ 管理员返回闭环通过：首次留在管理端，第二次退出到登录页，角色标记已清理'
    : '❌ 管理员最终返回未落到登录页');
  ws.close(); proc.kill();
  process.exit(returnedToLogin ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
