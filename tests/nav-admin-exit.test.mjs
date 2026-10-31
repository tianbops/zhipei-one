/**
 * 管理员与普通用户统一的返回出口契约。
 * 模块返回先回本工作区首页；工作区首页连续两次返回只退出应用，不注销、不清理会话。
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
{
 const env=makeEnv({pathname:"/admin",adminPage:2,zone:"admin"});
 const result=await env.back();
 t("管理员模块返回被消费",result==="handled",result);
 t("管理员模块回到管理员首页",env.pages.length===1&&env.pages[0]===0,JSON.stringify(env.pages));
 t("模块返回不注销",env.fetched.length===0&&env.replaced.length===0);
}
{
 const env=makeEnv({pathname:"/admin",adminPage:0,zone:"admin"});
 t("管理员首页第一次返回只武装",(await env.back())==="exit-armed");
 t("管理员提示与普通用户一致",env.toasts[0]==="再按一次退出应用",JSON.stringify(env.toasts));
 t("管理员第二次返回只退出应用",(await env.back())==="exit");
 t("管理员返回不调用注销 API",env.fetched.length===0,JSON.stringify(env.fetched));
 t("管理员返回不跳转登录页",env.replaced.length===0,JSON.stringify(env.replaced));
 t("管理员会话凭证全部保留",env.session.has("zpAuth")&&env.session.has("zpRole"),JSON.stringify([...env.session]));
 t("管理员自动登录标记保留",env.local.has("zpLastAuth")&&env.local.has("zpLastRole"),JSON.stringify([...env.local]));
}
{
 const env=makeEnv({pathname:"/pages/order_detail",zone:"business"});
 t("用户子页面仍逐级返回",(await env.back())==="leave"&&env.replaced[0]==="/home",JSON.stringify(env.replaced));
 const root=makeEnv({pathname:"/home",zone:"business"});
 t("用户首页第一次返回只武装",(await root.back())==="exit-armed");
 t("用户首页第二次返回只退出应用",(await root.back())==="exit");
 t("用户返回不注销",root.fetched.length===0);
 t("用户登录凭证保留",root.session.has("zpAuth")&&root.session.has("zpRole"));
 t("用户自动登录标记保留",root.local.has("zpLastAuth")&&root.local.has("zpLastRole"));
}
{
 const start=SRC.indexOf("function zpDoExit()");
 const end=SRC.indexOf("// 顶部返回按钮专用出口");
 if(start<0||end<=start)throw new Error("切片失败：zpDoExit 源码未找到");
 const body=SRC.slice(start,end);
 const calls={nativeExit:0,historyBack:0};
 const state=new Set(["zpAuth","zpRole","zpLastAuth","zpLastRole"]);
 const storage={getItem:k=>state.has(k)?"1":null,setItem:k=>state.add(k),removeItem:k=>state.delete(k)};
 const win={ZhipeiNative:{exitApp:()=>{calls.nativeExit++;}},matchMedia:()=>({matches:false}),navigator:{}};
 const fn=new Function("window","sessionStorage","history","location","let zpLeaving=false;"+body+";return zpDoExit;")(
   win,storage,{back:()=>{calls.historyBack++;}},{});
 fn();
 t("App 调用原生 exitApp",calls.nativeExit===1,JSON.stringify(calls));
 t("App 不回退 WebView 历史",calls.historyBack===0,JSON.stringify(calls));
 t("App 退出保留登录凭证",state.has("zpAuth")&&state.has("zpRole"),JSON.stringify([...state]));
}
{
 const start=SRC.indexOf("function zpDoExit()");
 const end=SRC.indexOf("// 顶部返回按钮专用出口");
 const body=SRC.slice(start,end);
 const calls={historyBack:0};
 const state=new Set(["zpAuth","zpRole","zpLastAuth","zpLastRole"]);
 const storage={getItem:k=>state.has(k)?"1":null,setItem:k=>state.add(k),removeItem:k=>state.delete(k)};
 const win={matchMedia:()=>({matches:false}),navigator:{}};
 const fn=new Function("window","sessionStorage","history","location","let zpLeaving=false;"+body+";return zpDoExit;")(
   win,storage,{back:()=>{calls.historyBack++;}},{});
 fn();
 t("Web 交由浏览器历史返回",calls.historyBack===1,JSON.stringify(calls));
 t("Web 离开保留登录凭证",state.has("zpAuth")&&state.has("zpRole")&&state.has("zpLastAuth")&&state.has("zpLastRole"),JSON.stringify([...state]));
}
console.log(`管理员/用户统一返回契约：${pass} 通过 / ${fail} 失败`);
if(fail){failures.forEach(x=>console.error("  ✗ "+x));process.exit(1);}
console.log("✓ 管理员与普通用户返回规则一致：模块逐级返回，首页两次返回退出应用，登录态保留");
