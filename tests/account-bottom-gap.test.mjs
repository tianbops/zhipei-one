/**
 * 设置页（我的）底部留白契约（node tests/account-bottom-gap.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：用户反馈「底部留白太多，减小留白」。
 * 真机 Chromium 390×844 实测（改动前）：账号页 .zp-scroll 的 padding-bottom
 * 是 128px，滚到底时「注销账号」底边 y=716 → 视口底 844，出现 128px 纯空白。
 *
 * 根因：128px = 全站 88px（浮岛让位）+ 40px（躲开底栏「+」向上凸出 16px）。
 * 那 40px 的前提是底栏常驻；2026-11-04 改成 Uber 交互后，下滑到底底栏会隐藏
 * 且不自动弹起，让位成了没有内容的空白。收到 64px，留呼吸位即可。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 账号页 padding-bottom 是 64px，不得退回 128px；
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

console.log("设置页底部留白契约（10 条）");
{
  t("账号页 padding-bottom:calc(64px + env(...))",
    /padding-bottom:calc\(64px\s*\+\s*env\(safe-area-inset-bottom\)\)/.test(acctScroll), acctScroll);

  t("不再使用 128px（底栏到底隐藏后那段让位是纯空白）",
    !/padding-bottom:calc\(128px/.test(ACCT));

  t("仍保留 env(safe-area-inset-bottom)（全面屏手势条不贴底）",
    /env\(safe-area-inset-bottom\)/.test(acctScroll));

  t("账号页留白比全站口径更紧（64 < 88）",
    /64px/.test(acctScroll) && /88px/.test(globalScroll));

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
