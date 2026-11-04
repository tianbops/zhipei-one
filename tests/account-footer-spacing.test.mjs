/**
 * 设置页底部三块「版权 / 退出登录 / 注销账号」等距契约
 * (node tests/account-footer-spacing.test.mjs)
 * ------------------------------------------------------------------
 * 守护需求：用户要求「© 2026 智配One All Rights Reserved / 退出登录 /
 * 注销账号 三者间距调整为适当等距」。
 *
 * 真机 Chromium 390×844 实测（改动前，按文字/按钮视觉边界量）：
 *   gap1 版权文字底 → 退出按钮顶 = 18px
 *   gap2 退出按钮底 → 注销文字顶 = 60px   （差 42px，明显不等距）
 * gap2 偏大的两个来源：
 *   - 空 <p id="message" class="message"> 带 min-height:20px + margin-top:10px，
 *     没内容也占 30px；
 *   - .acct-destroy-link 的 margin-top:16px + padding-top:12px。
 *
 * 修法（纯 CSS，不动 DOM，24px 等距）：
 *   gap1 = .account-logout-section margin-top 18→24，版权 margin-bottom 4→0
 *   gap2 = 空 .message 用 :empty{display:none} 不占位 + 注销链接 margin-top 16→10
 *          （10 + padding-top 12 + 文字行内 2 = 24）
 * 注销链接 padding 12px 是 ≥44px 点击热区，绝不拿来折算间距。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 三段数值 24 / 10 / 12 不得回退到 18 / 16 / 4；
 *   2) 空 .message 不占位，但有文案时仍显示（app.css 的 min-height 不被删）；
 *   3) 三块 DOM 顺序与文案不变，版权字号/居中/颜色不变；
 *   4) 底部 88px 让位与 env 安全区不动（与 account-bottom-gap 同一口径）；
 *   5) 不用 !important；account.css?v 在页面与 SW 中一致。
 * 几何等距的实测由 tests/e2e-account-footer-spacing.cjs 负责（7 项，gap1=gap2=24）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const ACCT = rd("../css/account.css");
const APP = rd("../css/app.css");
const HTML = rd("../pages/account.html");
const SW = rd("../sw.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}
const rule = (re, src = ACCT) => (re.exec(src) || [])[1] || "";

console.log("设置页底部三块等距契约（14 条）");
{
  const crRule = rule(/\.acct-about-copyright\s*\{([^}]*)\}/);
  const secRule = rule(/\.account-page \.account-logout-section\s*\{([^}]*)\}/);
  const dzRule = rule(/\.acct-destroy-link\s*\{([^}]*)\}/);
  const emptyRule = rule(/\.account-page \.account-logout-section \.message:empty\s*\{([^}]*)\}/);

  t("版权行 margin-bottom 归零（下方间距交给 section 统一定义）",
    /margin:14px 0 0/.test(crRule) && !/margin:14px 0 4px/.test(crRule), crRule);

  t("退出登录 section margin-top 为 24px（gap1=24）",
    /margin:24px 0 0/.test(secRule) && !/margin:18px 0 0/.test(secRule), secRule);

  t("注销链接 margin-top 为 10px（不再 16px）",
    /margin:10px auto 0/.test(dzRule) && !/margin:16px auto 0/.test(dzRule), dzRule);

  t("注销链接保留 padding:12px 24px（≥44px 点击热区不缩水）",
    /padding:12px 24px/.test(dzRule), dzRule);

  t("空提示 .message:empty 隐藏，不占 30px",
    /display:none/.test(emptyRule), emptyRule);

  t("等距口径成立：section 24 = dz margin 10 + padding 12 + 文字行内 2",
    (() => {
      const sec = Number((/margin:(\d+)px 0 0/.exec(secRule) || [])[1]);
      const dzM = Number((/margin:(\d+)px auto 0/.exec(dzRule) || [])[1]);
      const dzP = Number((/padding:(\d+)px 24px/.exec(dzRule) || [])[1]);
      return sec === 24 && dzM === 10 && dzP === 12 && dzM + dzP + 2 === sec;
    })(), `sec=${secRule} dz=${dzRule}`);

  t("有错误文案时 .message 仍能显示（app.css min-height 未被删）",
    /\.message\s*\{[^}]*min-height:\s*20px/.test(APP));

  t("三块 DOM 顺序不变：版权 → 退出登录 → 注销账号",
    HTML.indexOf("acct-about-copyright") < HTML.indexOf("account-logout-section") &&
    HTML.indexOf("account-logout-section") < HTML.indexOf('id="dangerToggle"'));

  t("三块文案一字未改",
    HTML.includes('<div class="acct-about-copyright">© 2026 智配One All Rights Reserved</div>') &&
    /id="logout"[^>]*>退出登录</.test(HTML) &&
    /id="dangerToggle"[^>]*>注销账号</.test(HTML));

  t("版权行仍是 12px / 居中 / muted（不靠改字号拉间距）",
    /font-size:var\(--zp-fs-12\)/.test(crRule) &&
    /text-align:center/.test(crRule) &&
    /color:var\(--zp-muted\)/.test(crRule), crRule);

  t("底部 88px 让位与 env 安全区保持不变",
    /padding-bottom:calc\(88px\s*\+\s*env\(safe-area-inset-bottom\)\)/.test(ACCT));

  t("三条规则均不使用 !important（项目禁止优先级硬压）",
    !/!important/.test(crRule) && !/!important/.test(secRule) &&
    !/!important/.test(dzRule) && !/!important/.test(emptyRule));

  const hv = (s) => (/account\.css\?v=([0-9a-f]+)/.exec(s) || [])[1];
  t("account.html 与 sw.js 的 account.css?v 一致（缓存能刷新）",
    !!hv(HTML) && hv(HTML) === hv(SW), `html=${hv(HTML)} sw=${hv(SW)}`);

  t("改动集中在 CSS，未给三块加内联 style",
    !/acct-about-copyright[^>]*style=/.test(HTML) &&
    !/id="dangerToggle"[^>]*style=/.test(HTML) &&
    !/id="logout"[^>]*style=/.test(HTML));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
}
finish();
