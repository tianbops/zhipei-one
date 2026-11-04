/**
 * 设置页（我的）底部留白契约（node tests/account-bottom-gap.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：用户反馈「底部留白太多，减小留白」，同时最后一项「注销账号」
 * 不得被底栏浮岛压住。
 *
 * 演进（两次都踩过，别再循环）：
 *   - 128px = 88（浮岛让位）+ 40（躲底栏「+」上凸）→ 用户嫌空白太多；
 *   - 64px  → 前提是「下滑到底底栏隐藏且不弹起」。同日 `滑到底不再自动弹起`
 *             + 触底强制显示上线后前提失效：390×844 滚到底，浮岛 top=770，
 *             注销账号 bottom=780，被压 10px（红字下半截看不见）。
 *   - 88px  → 全站浮岛让位口径：内容底 756，距浮岛顶 14px 呼吸，比 128 仍少 40。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 账号页 padding-bottom 是 88px，不得回到 128px，也不得低于 88px；
 *   2) 全站 .zp-scroll 88px 与 body.zp-has-nav 88px 都不动（其它页零影响）；
 *   3) 保留 env(safe-area-inset-bottom)（刘海/手势条机型不能贴底）；
 *   4) account.css?v 在页面与 SW 预缓存中一致，否则真机永远看到旧留白。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const ACCT = rd("../css/account.css");
const SHELL = rd("../css/ui-shell.css");
const BASE = rd("../css/ui-base.css");
const HTML = rd("../pages/account.html");
const SW = rd("../sw.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const acctScroll = (/\.account-page\s+\.zp-scroll\s*\{([^}]*)\}/.exec(ACCT) || [])[1] || "";
const globalScroll = (/\.zp-scroll\s*\{([^}]*)\}/.exec(SHELL) || [])[1] || "";
const bodyNav = (/body\.zp-has-nav\s*\{([^}]*)\}/.exec(BASE) || [])[1] || "";

console.log("设置页底部留白契约（11 条）");
{
  t("账号页 padding-bottom:calc(88px + env(...))",
    /padding-bottom:calc\(88px\s*\+\s*env\(safe-area-inset-bottom\)\)/.test(acctScroll), acctScroll);

  t("不再使用 128px（用户明确嫌空白多）",
    !/padding-bottom:calc\(128px/.test(ACCT));

  t("不得低于 88px（底栏触底常驻，再压缩会压住注销账号）",
    !/padding-bottom:calc\((?:[0-7]\d|8[0-7])px/.test(acctScroll), acctScroll);

  t("仍保留 env(safe-area-inset-bottom)（全面屏手势条不贴底）",
    /env\(safe-area-inset-bottom\)/.test(acctScroll));

  t("账号页让位与全站口径一致（88 = 88，不多留也不缺口）",
    /88px/.test(acctScroll) && /88px/.test(globalScroll));

  t("全站 .zp-scroll 仍是 88px（历史/线路/首页零影响）",
    /padding:14px 0 calc\(88px/.test(globalScroll), globalScroll.slice(0, 160));

  t("body.zp-has-nav 仍是 88px（全站让位口径未动）",
    /padding-bottom:calc\(88px/.test(bodyNav), bodyNav);

  t("规则不使用 !important（项目禁止用优先级硬压）",
    !/!important/.test(acctScroll));

  const hv = (s) => (/account\.css\?v=([0-9a-f]+)/.exec(s) || [])[1];
  t("account.html 与 sw.js 的 account.css?v 一致（缓存能刷新）",
    !!hv(HTML) && hv(HTML) === hv(SW), `html=${hv(HTML)} sw=${hv(SW)}`);

  t("最后一项仍是「注销账号」（未靠删内容来减小留白）",
    /id="dangerToggle"[^>]*>注销账号</.test(HTML) &&
    HTML.indexOf("acct-about-copyright") < HTML.indexOf("account-logout-section") &&
    HTML.indexOf("account-logout-section") < HTML.indexOf('id="dangerToggle"'));

  t("账号页仍使用 .zp-scroll 滚动容器（结构不变）",
    /<div class="zp-scroll">/.test(HTML) && /class="page2 account-page zp-shell"/.test(HTML));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
