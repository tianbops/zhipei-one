/**
 * 返回仲裁 · 管理员空间出口（tests/nav-admin-exit.test.mjs）
 * ------------------------------------------------------------
 * 对应 ZP-NAV-2026-002 修订 A1（2026-10-30 定稿）：
 *   · 管理员空间任意模块按返回 → 先收口到管理员首页（模块 0），不退出、不注销；
 *   · 管理员首页连续两次返回 → 注销管理员会话并进入登录页，不进入业务首页；
 *   · 管理员最终返回与菜单「退出登录」语义一致：POST /api/logout，清理本地身份并进入登录页。
 *
 * 实现方式：截取 js/ui/back.js 中真实的 zpHandleBack 源码求值（不是复制逻辑），
 * 注入假的 window/document/location，断言分支结果与副作用。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const start = SRC.indexOf("window.zpHandleBack=async function");
const end = SRC.indexOf("// 真正离开应用");
assert.ok(start > 0 && end > start, "切片失败：zpHandleBack 源码未找到");
const BODY = SRC.slice(start, end);

/** 构造一个最小环境，返回 { back, replaced, fetched, pages } */
function makeEnv({ pathname = "/home", adminPage = 0, zone = "business" } = {}) {
  const env = { replaced: [], fetched: [], pages: [], toasts: [], session: new Set(["zpAuth","zpRole","zpExitAdmin","zpAutoHop"]), local: new Set(["zpLastAuth","zpLastRole"]) };
  const win = {
    zpDirtyProbes: [],
    zpConfirm: async () => true,
    zpToast: (m) => env.toasts.push(m),
    ZPAdmin: { S: { page: adminPage }, page: (i) => { env.pages.push(i); win.ZPAdmin.S.page = i; } },
  };
  const location = { pathname, replace: (u) => env.replaced.push(u), href: "https://x.invalid" + pathname };
  const UI = {
    normPath: (p) => String(p || "").replace(/\.html$/, "").replace(/\/$/, "") || "/",
  };
  win.__zpUi = UI;

  const prelude = `
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
  const factory = new Function(
    "window", "document", "location", "fetch", "setTimeout", "clearTimeout", "sessionStorage", "localStorage",
    prelude + BODY + "\nreturn window.zpHandleBack;"
  );
  env.back = factory(win, { querySelector: () => null }, location, async (url, options) => { env.fetched.push({url,options}); return { ok: true }; },
    (fn) => 0, () => {}, win.sessionStorage, win.localStorage);
  return env;
}

/* 1. 管理员：模块 2 → 收口模块 0，不导航、不注销 */
{
  const env = makeEnv({ pathname: "/admin", adminPage: 2, zone: "admin" });
  const r = await env.back();
  t("管理员模块返回：结果为 handled", r === "handled", r);
  t("管理员模块返回：收口到模块 0", env.pages.length === 1 && env.pages[0] === 0, JSON.stringify(env.pages));
  t("管理员模块返回：不跳转页面", env.replaced.length === 0, JSON.stringify(env.replaced));
  t("管理员模块返回：不注销会话", env.fetched.length === 0, JSON.stringify(env.fetched));
}

/* 2. 管理员首页：两次返回注销并进入登录页 */
{
  const env = makeEnv({ pathname: "/admin", adminPage: 0, zone: "admin" });
  const r1 = await env.back();
  t("管理员首页首次返回：武装退出", r1 === "exit-armed", r1);
  const r2 = await env.back();
  t("管理员首页第二次返回：确认退出", r2 === "exit", r2);
  t("管理员首页退出：不跳转到业务首页/登录页", env.replaced.length === 0, JSON.stringify(env.replaced));
  t("管理员首页退出：不注销会话", env.fetched.length === 0, JSON.stringify(env.fetched));
}

/* 3. 业务子页面：一律收口首页（不看 from） */
{
  const env = makeEnv({ pathname: "/pages/order_detail", zone: "business" });
  const r = await env.back();
  t("业务子页面返回：leave", r === "leave", r);
  t("业务子页面返回：目标为 /home", env.replaced[0] === "/home", JSON.stringify(env.replaced));
}

/* 4. 业务首页：两次返回退桌面 */
{
  const env = makeEnv({ pathname: "/home", zone: "business" });
  t("业务首页首次返回：武装退出", (await env.back()) === "exit-armed");
  t("业务首页第二次返回：确认退出", (await env.back()) === "exit");
}

/* 5. 源码级红线：管理员最终返回必须显式登出；业务端仍不触发管理员登出 */
{
  // 只认真正的调用形态；注释里提到历史实现不算
  const hit = /fetch\(\s*["'`]\/api\/logout/.test(SRC);
  t("返回控制器不得调用 /api/logout（返回键永不登出）", !hit, "back.js 仍存在 fetch(\"/api/logout\") 调用");
}

console.log(`返回仲裁·管理员出口：${pass} 通过 / ${fail} 失败`);
if (fail) {
  failures.forEach((f) => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ 管理员返回收口模块 → 最终返回注销并进入登录页；业务子页面一律回首页");
