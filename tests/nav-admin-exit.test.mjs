/**
 * 管理员工作区返回出口契约：
 * 模块返回先收口到管理员首页；管理员首页连续两次返回后注销会话并进入登录页。
 * 直接求值 js/ui/back.js 的真实 zpHandleBack 源码，锁定行为及副作用。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");
const start = SRC.indexOf("window.zpHandleBack=async function");
const end = SRC.indexOf("// 真正离开应用");
assert.ok(start > 0 && end > start, "切片失败：zpHandleBack 源码未找到");
const BODY = SRC.slice(start, end);
let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
function makeEnv({ pathname="/home", adminPage=0, zone="business" }={}) {
  const env = { replaced:[], fetched:[], pages:[], toasts:[],
    session:new Set(["zpAuth","zpRole","zpExitAdmin","zpAutoHop"]),
    local:new Set(["zpLastAuth","zpLastRole"]) };
  const storage = set => ({removeItem:k=>set.delete(k),getItem:k=>set.has(k)?"1":null,setItem:k=>set.add(k)});
  const sessionStorage=storage(env.session), localStorage=storage(env.local);
  const win = {zpDirtyProbes:[],zpConfirm:async()=>true,zpToast:m=>env.toasts.push(m),
    ZPAdmin:{S:{page:adminPage},page:i=>{env.pages.push(i);win.ZPAdmin.S.page=i;}}};
  win.sessionStorage=sessionStorage;win.localStorage=localStorage;
  const location={pathname,replace:u=>env.replaced.push(u),href:"https://x.invalid"+pathname};
  win.__zpUi={normPath:p=>String(p||"").replace(/\.html$/,"").replace(/\/$/,"")||"/"};
  const prelude=`
    const UI=window.__zpUi;
    const zpZone=${JSON.stringify(zone)};
    const zpRoot=zpZone==="admin"?"/admin":"/home";
    const zpIsWorkspaceRoot=UI.normPath(location.pathname)===UI.normPath(zpRoot);
    let zpExitArmed=false,zpExitTimer=0,zpAdminNonRoot=false;
    const zpCloseTopLayer=async()=>false;
    const zpConfirmDiscard=async()=>true;
    function zpPushGuard(){}
    function zpResolveBack(){return zpRoot}
    window.zpResolveBack=zpResolveBack;
  `;
  const factory=new Function("window","document","location","fetch","setTimeout","clearTimeout","sessionStorage","localStorage",
    prelude+BODY+"\\nreturn window.zpHandleBack;");
  env.back=factory(win,{querySelector:()=>null},location,async(url,options)=>{env.fetched.push({url,options});return{ok:true};},
    ()=>0,()=>{},sessionStorage,localStorage);
  return env;
}

// 管理员任意模块返回先回管理员首页，不导航、不注销。
{
 const env=makeEnv({pathname:"/admin",adminPage:2,zone:"admin"});
 const result=await env.back();
 t("管理员模块返回被消费",result==="handled",result);
 t("管理员模块回到模块 0",env.pages.length===1&&env.pages[0]===0,JSON.stringify(env.pages));
 t("模块返回不注销",env.fetched.length===0,JSON.stringify(env.fetched));
}
// 管理员首页连续两次返回：服务端注销、本地身份清理、进入登录页。
{
 const env=makeEnv({pathname:"/admin",adminPage:0,zone:"admin"});
 t("首次返回只武装确认",(await env.back())==="exit-armed");
 t("首次返回提示回登录页",env.toasts[0]==="再按一次返回登录页",JSON.stringify(env.toasts));
 t("第二次返回执行管理员退出",(await env.back())==="admin-logout");
 t("服务端注销 API 正确",env.fetched.length===1&&env.fetched[0].url==="/api/logout"&&env.fetched[0].options.method==="POST",JSON.stringify(env.fetched));
 t("最终进入登录页并阻止自动登录",env.replaced[0]==="/?reason=logout&manual=1",JSON.stringify(env.replaced));
 t("清理会话与本地自动登录标记",env.session.size===0&&env.local.size===0,JSON.stringify({session:[...env.session],local:[...env.local]}));
}
// 业务端原有返回行为不变。
{
 const env=makeEnv({pathname:"/pages/order_detail",zone:"business"});
 t("业务子页面返回仍回业务首页",(await env.back())==="leave"&&env.replaced[0]==="/home",JSON.stringify(env.replaced));
 const root=makeEnv({pathname:"/home",zone:"business"});
 t("业务首页第一次返回仍武装",(await root.back())==="exit-armed");
 t("业务首页第二次返回仍按原逻辑退出",(await root.back())==="exit");
}
console.log(`管理员返回出口契约：${pass} 通过 / ${fail} 失败`);
if(fail){failures.forEach(x=>console.error("  ✗ "+x));process.exit(1);}
console.log("✓ 管理员模块返回收口；最终返回注销并进入登录页；业务端行为保持不变");
