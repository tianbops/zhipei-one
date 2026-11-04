/**
 * 设置页版权信息契约（node tests/account-copyright.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：用户要求把「© 2026 智配One」补全为
 * 「© 2026 智配One All Rights Reserved」。
 *
 * 真机 Chromium 390×844 实测：加长后文本宽 202px、容器 358px，仍是单行居中，
 * 版权行高度 18px 不变，下方「退出登录」位置不变 —— 因此只改 HTML 文案，
 * 不动字号/颜色/居中（放大字号或加 nowrap 反而会在窄屏折行或溢出）。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 完整文案一字不差，不得退回简写或写成「版权所有」等变体；
 *   2) 仍挂在 .acct-about-copyright 上，位置在「退出登录」之前；
 *   3) 样式保持 12px / center / muted，且不加 white-space:nowrap；
 *   4) 全仓没有第二处残留的简写版权行；
 *   5) account.css?v 在页面与 SW 中一致（改动能随缓存刷新生效）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const HTML = rd("../pages/account.html");
const ACCT = rd("../css/account.css");
const SW = rd("../sw.js");
const FULL = "© 2026 智配One All Rights Reserved";
const SHORT = '<div class="acct-about-copyright">© 2026 智配One</div>';

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const cssRule = (/\.acct-about-copyright\s*\{([^}]*)\}/.exec(ACCT) || [])[1] || "";
const pages = readdirSync(fileURLToPath(new URL("../pages/", import.meta.url)))
  .filter((f) => f.endsWith(".html"))
  .map((f) => [f, rd("../pages/" + f)]);

console.log("设置页版权信息契约（10 条）");
{
  t("版权行是完整文案「© 2026 智配One All Rights Reserved」",
    HTML.includes('<div class="acct-about-copyright">' + FULL + '</div>'));

  t("简写版权行已不存在（不得回退）", !HTML.includes(SHORT));

  t("文案一字不差：© + 2026 + 品牌名 + All Rights Reserved，无多余空格",
    (() => {
      const m = /<div class="acct-about-copyright">([^<]*)<\/div>/.exec(HTML);
      return !!m && m[1] === FULL && !/\s{2,}/.test(m[1]) && !/\s$/.test(m[1]);
    })(), (/<div class="acct-about-copyright">([^<]*)<\/div>/.exec(HTML) || [])[1]);

  t("仍使用 .acct-about-copyright 类（样式钩子不变）",
    /class="acct-about-copyright"/.test(HTML));

  t("位置不变：版权行在「退出登录」按钮之前",
    HTML.indexOf("acct-about-copyright") < HTML.indexOf("account-logout-section"));

  t("样式仍是 12px / 居中 / muted（不加字号以免折行）",
    /font-size:var\(--zp-fs-12\)/.test(cssRule) &&
    /text-align:center/.test(cssRule) &&
    /color:var\(--zp-muted\)/.test(cssRule), cssRule);

  t("不加 white-space:nowrap（窄屏允许自然折行，不硬撑溢出）",
    !/white-space:nowrap/.test(cssRule));

  t("全仓只有一处版权行，其它页面无简写残留",
    pages.filter(([, s]) => s.includes("acct-about-copyright")).length === 1 &&
    pages.every(([, s]) => !s.includes(SHORT)));

  const hv = (s) => (/account\.css\?v=([0-9a-f]+)/.exec(s) || [])[1];
  t("account.html 与 sw.js 的 account.css?v 一致（缓存口径同步）",
    !!hv(HTML) && hv(HTML) === hv(SW), `html=${hv(HTML)} sw=${hv(SW)}`);

  t("版权文案未使用 !important / 内联 style（样式仍由 CSS 单一来源控制）",
    !/acct-about-copyright[^>]*style=/.test(HTML) && !/!important/.test(cssRule));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
