/**
 * 站内导航不产生历史记录（ZP-NAV-2026-002 追加约束，2026-10-30）
 * ------------------------------------------------------------------
 * 运行：node tests/nav-no-history.test.mjs
 *
 * 背景（线上实测）：
 *   多页架构下每个 <a href> 都会 push 一条历史。收口模型让「任何页面返回都回首页」，
 *   但栈里仍压着历史页、详情页，于是首页按返回的序列变成
 *   「首页(toast 再按一次) → 运单详情 → 历史查询 → 才退出浏览器」，
 *   方向完全不可预期，用户连按多次也退不出去。
 *
 * 修法：站内跳转一律 location.replace，历史栈只保留当前页一条正式记录。
 * 本测试锁住三件事：
 *   1. back.js 有站内 <a> 拦截，且走 replace；
 *   2. 拦截不抢业务自己处理的点击（冒泡阶段 + defaultPrevented）；
 *   3. 全仓 js/ 不得再出现站内 location.href 赋值（它会 push 历史）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0;
const failures = [];
function t(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " —— " + detail : ""));
    console.log("  ✗ " + name + (detail ? " —— " + detail : ""));
  }
}

const src = readFileSync(fileURLToPath(new URL("../js/ui/back.js", import.meta.url)), "utf8");

console.log("一、站内链接拦截（4 条）");
{
  t("back.js 注册了 a[href] 点击拦截", /closest\("a\[href\]"\)/.test(src));
  t("站内跳转使用 location.replace", /location\.replace\(url\.href\)/.test(src));
  t("同源判定存在（外链放行）", /url\.origin!==location\.origin/.test(src));
  t("放过 target/_blank 与 download", /a\.target&&a\.target!=="_self"/.test(src) && /hasAttribute\("download"\)/.test(src));
}

console.log("\n二、不抢业务点击（3 条）");
{
  // 冒泡阶段（useCapture=false）→ 业务在捕获/自身 onclick 里 preventDefault 后，本拦截直接跳过
  t("监听在冒泡阶段", /\},false\);\s*\n\s*function zpBindPageBack|closest\("a\[href\]"\)[\s\S]{0,900}?\},false\);/.test(src));
  t("检查 e.defaultPrevented", /e\.defaultPrevented\|\|/.test(src));
  t("同页链接不重复导航", /url\.pathname===location\.pathname&&url\.search===location\.search/.test(src));
}

console.log("\n三、全仓不得再有站内 href 赋值（3 条）");
{
  const hits = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !e.name.includes("bundle")) {
        const s = readFileSync(p, "utf8");
        // location.href = "/..." 会 push 一条历史；location.assign 同理
        if (/location\.href\s*=\s*["']\//.test(s) || /location\.assign\(/.test(s)) hits.push(p);
      }
    }
  })("js");
  t("js/ 下无 location.href=站内路径", hits.length === 0, hits.join(","));

  const navJs = readFileSync(fileURLToPath(new URL("../js/ui/nav.js", import.meta.url)), "utf8");
  t("nav.js 处理中离开也走 replace", /location\.replace\(href\)/.test(navJs) && !/location\.href=href/.test(navJs));

  const histRender = readFileSync(fileURLToPath(new URL("../js/history/render.js", import.meta.url)), "utf8");
  t(
    "历史页日期点击也走 replace",
    (histRender.match(/location\.replace\("\/pages\/order_detail/g) || []).length === 2 &&
      !/location\.href="\/pages\/order_detail/.test(histRender),
  );
}

console.log("\n四、占位只在工作区根（2 条）");
{
  // 子页面压占位会让 replace 替换「占位」而不是页面本身，旧页面记录永久残留，
  // 连按返回就退回已离开的内页（2026-10-30 实测：首页 → 首页 → 历史 → 首页）。
  t("压占位以 zpIsWorkspaceRoot 为前提", /if\(zpIsWorkspaceRoot&&!\(history\.state&&history\.state\.zpGuard\)\)zpPushGuard\(\)/.test(src));
  t("子页面不无条件压占位", !/if\(!\(history\.state&&history\.state\.zpGuard\)\)zpPushGuard\(\);/.test(src));
}

console.log("\n五、退出路径仍是「越过首条记录」（2 条）");
{
  t("zpDoExit 用 history.back 越界", /function zpDoExit\(\)\{[\s\S]{0,400}?history\.back\(\)/.test(src));
  t("根页两次返回才退桌面（有武装窗口）", /zpExitArmed=true/.test(src) && /if\(zpExitArmed\)return "exit"/.test(src));
}

console.log(`\n${failures.length === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exitCode = 1;
}
