/**
 * 退出接力契约：返回到首页后二次返回，必须真正离开站点（退回浏览器首页）。
 *
 * 背景（2026-11-04）：登录跳转写 /home?v=时间戳，底栏「首页」Tab 却是 /home。
 * 站内导航一律 location.replace，只替换当前项，栈底 /home?v= 永久残留。点 Tab
 * 回首页后，第二次返回落到这条 URL 不同的记录并**重新加载文档**；跨文档后退时
 * 旧文档收不到 popstate，zpHandleBack/zpDoExit 都不会跑，人就卡在 App 里。
 *
 * 修法三要点（任一缺失都会复发）：
 *   1. 第一次返回（exit-armed）把「武装中」落盘 zpExitReady —— 新文档只能靠它
 *      认出自己处在「再按一次退出」的窗口里；
 *   2. 第二次返回若同文档，popstate 同步执行 zpDoExit（不 await，避免被卸载打断）；
 *   3. 第二次返回若跨文档，zpZoneGuard 在 back/forward 到达的新文档上接力
 *      history.back()，直到离开站点；正常 navigate 打开 App 时清标记防误退。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");
const BUNDLE = readFileSync(fileURLToPath(new URL("../js/home.bundle.js", import.meta.url)), "utf8");
let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
const slice = (a, b) => { const i = SRC.indexOf(a), j = SRC.indexOf(b); assert.ok(i > 0 && j > i, `切片失败：${a}`); return SRC.slice(i, j); };

console.log("一、武装状态跨文档落盘（第 1 次返回）");
{
  const HANDLE = slice("window.zpHandleBack=async function", "// 真正离开应用");
  t("armed 分支写 zpExitReady 时间戳", /zpExitArmed=true;[\s\S]{0,200}sessionStorage\.setItem\("zpExitReady",String\(Date\.now\(\)\)\)/.test(HANDLE));
  t("退出窗口过期时清 zpExitReady", /setTimeout\(\(\)=>\{zpExitArmed=false;[\s\S]{0,120}removeItem\("zpExitReady"\)/.test(SRC));
  t("exit 分支同步写 zpExitAt 与 zpExitAdmin", /if\(zpExitArmed\)\{[\s\S]{0,400}setItem\("zpExitAt"[\s\S]{0,160}setItem\("zpExitAdmin","1"\)[\s\S]{0,80}return "exit"/.test(HANDLE));
  t("标记写入在 return \"exit\" 之前（不依赖 zpDoExit 是否跑完）", (() => {
    const i = HANDLE.indexOf('setItem("zpExitAt"'), j = HANDLE.indexOf('return "exit"');
    return i > 0 && j > i;
  })());
}

console.log("二、popstate 同步退出（同文档的第二次返回）");
{
  const POP = SRC.slice(SRC.indexOf('window.addEventListener("popstate"'));
  t("已武装时同步调用 zpDoExit，不 await", /if\(zpExitArmed&&zpIsWorkspaceRoot&&!zpLeaving&&!zpTopHook\(\)\)\{[\s\S]{0,320}zpDoExit\(\);/.test(POP));
  t("同步退出分支清掉 armed 预置", /zpExitArmed=false;clearTimeout\(zpExitTimer\);[\s\S]{0,160}removeItem\("zpExitReady"\)/.test(POP));
  t("同步分支位于 await zpHandleBack 之前", POP.indexOf("zpDoExit();") < POP.indexOf("const r=await zpHandleBack("));
  t("popstate 传 true（系统已退一层，不得二次 history.back）", /const r=await zpHandleBack\(true\)/.test(POP));
  t("同文档接力仍保留（标记不删）", /zpZone==="business"&&zpHasExit\(\)\)\{[\s\S]{0,160}history\.back\(\)/.test(POP));
}

console.log("三、跨文档接力（zpZoneGuard 行为）");
{
  const GUARD = slice("function zpZoneGuard()", "  (function zpInstallBack");
  t("接力条件含 zpExitReady 或 zpExitAdmin", /backNav&&\(zpHasExit\(\)\|\|zpHasExitReady\(\)\)/.test(GUARD));
  t("正常 navigate 清掉全部退出标记", /if\(!backNav\)zpClearExitMarks\(\)/.test(GUARD));
  t("接力时写正式退出标记供下一份文档继续", /setItem\("zpExitAt"[\s\S]{0,120}setItem\("zpExitAdmin","1"\)/.test(GUARD));
  t("接力调用 zpContinueExit", /zpContinueExit\(\);[\s\S]{0,60}return true/.test(GUARD));
  t("接力优先于管理员会话门禁（绝不弹回管理端）", GUARD.indexOf("zpContinueExit()") < GUARD.indexOf("zpIsAdminSession()"));

  // 真执行 zpZoneGuard：注入桩，只关心「是否接力」和「标记是否正确写回」
  function runGuard({ backNav, hasExit, hasReady, adminSession }) {
    const store = new Map();
    if (hasExit) store.set("zpExitAdmin", "1");
    if (hasReady) store.set("zpExitReady", String(Date.now()));
    const calls = { cont: 0, cleared: 0, replaced: [] };
    const sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    };
    const factory = new Function(
      "zpZone", "zpIsBackNav", "zpHasExit", "zpHasExitReady", "zpClearExitMarks",
      "zpContinueExit", "zpIsAdminSession", "sessionStorage", "location",
      GUARD + "\nreturn zpZoneGuard;",
    );
    const fn = factory(
      "business", () => backNav, () => hasExit, () => hasReady,
      () => { calls.cleared++; }, () => { calls.cont++; }, () => adminSession,
      sessionStorage, { replace: (u) => calls.replaced.push(u) },
    );
    const result = fn();
    return { result, calls, store };
  }
  const relay = runGuard({ backNav: true, hasExit: false, hasReady: true, adminSession: false });
  t("armed 窗口内跨文档返回 → 接力并写正式标记",
    relay.result === true && relay.calls.cont === 1 && relay.store.get("zpExitAdmin") === "1" && !relay.store.has("zpExitReady"),
    JSON.stringify({ result: relay.result, calls: relay.calls }));
  const chain = runGuard({ backNav: true, hasExit: true, hasReady: false, adminSession: false });
  t("已有正式标记的下一份文档继续接力", chain.result === true && chain.calls.cont === 1);
  const normal = runGuard({ backNav: false, hasExit: true, hasReady: true, adminSession: false });
  t("正常 navigate 打开 App 不接力且清标记", normal.result === false && normal.calls.cont === 0 && normal.calls.cleared === 1);
  const leave = runGuard({ backNav: true, hasExit: false, hasReady: false, adminSession: false });
  t("普通返回回首页（未武装）不接力", leave.result === false && leave.calls.cont === 0);
}

console.log("四、导航类型判定与延迟后退");
{
  const ISBACK = slice("function zpIsBackNav()", "  function zpContinueExit()");
  t("同步可读的 performance.navigation.type===2 兜底", /performance\.navigation&&performance\.navigation\.type===2/.test(ISBACK));
  t("同时兼容 Navigation Timing 的 back_forward", /type==="back_forward"/.test(ISBACK));
  function runIsBack(perf) {
    return new Function("performance", ISBACK + "\nreturn zpIsBackNav;")(perf)();
  }
  t("TYPE_BACK_FORWARD 判为返回", runIsBack({ navigation: { type: 2 }, getEntriesByType: () => [] }) === true);
  t("navigate 判为非返回", runIsBack({ navigation: { type: 0 }, getEntriesByType: () => [{ type: "navigate" }] }) === false);
  t("无 navigation API 时安全返回 false", runIsBack({ getEntriesByType: () => [{ type: "navigate" }] }) === false);

  const CONT = slice("function zpContinueExit()", "  async function zpConfirmDiscard");
  t("后退延到 load 之后（加载期同步 back 会被丢弃）", /addEventListener\("load"/.test(CONT) && /setTimeout\(go,0\)/.test(CONT));
  t("readyState 已 complete 时立即排队", /readyState==="complete"\)setTimeout\(go,0\)/.test(CONT));
}

console.log("五、首页 bundle 与源同步");
{
  t("bundle 内含退出接力实现", BUNDLE.includes("zpExitReady") && BUNDLE.includes("zpHasExitReady") && BUNDLE.includes("zpContinueExit"));
  t("bundle 内含同步 popstate 退出分支", BUNDLE.includes("zpExitArmed&&zpIsWorkspaceRoot&&!zpLeaving&&!zpTopHook()"));
}

console.log("\n" + "-".repeat(56));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log("\n失败用例："); failures.forEach((f) => console.log("  · " + f)); process.exit(1); }
