/**
 * 线路页「线路维护」文案与文字布局契约（node tests/dispatch-text-layout.test.mjs）
 * ------------------------------------------------------------------------------
 * 背景（2026-11-04 用户截图反馈）：
 *   顶栏「线路」下方还挂着一个 18px 的「线路工作区」+ 一行说明，再往下才是
 *   13px 的分组标题 —— 首屏三级标题堆叠，且与顶栏只差 2px 字号，层级靠字号硬撑。
 *   要求：顶栏改「线路维护」、删掉「线路工作区」文字、重新优化整页文字布局。
 *
 * 定稿的文字层级（靠字号 + 留白，不再靠卡片套标题）：
 *   顶栏 20px → 分组标题 14px 实色 → 线路名 22px / 功能名 16px → 说明 13px 灰字
 *   当前线路卡片内改成「名称 / 已匹配 N 家门店」上下两行，「切换」右侧垂直居中。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 顶栏与 <title> 都是「线路维护」；底部 Tab 仍叫「线路」（Tab 名要短，别跟着改）；
 *   2) 「线路工作区」及其说明文案、.dispatch-intro 的 HTML 与 CSS 全部清零
 *      （留着死规则/空 section 会重新把首屏推低）；
 *   3) 两个分组标题文案保留（删的是冗余板块标题，不是功能分组）；
 *   4) CSS 的三级字号令牌与 22px 分组留白；
 *   5) 当前线路卡片是两行结构（.dispatch-current-info 包住名称与状态）；
 *   6) 页面引用的 business-pages.css?v 与文件内容一致（防止改了样式忘刷缓存）。
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const PAGE = read("pages/dispatch.html");
const CSS = read("css/business-pages.css");

console.log("线路页文案与文字布局契约");
{
  /* 一、顶栏与 Tab */
  t("顶栏标题改为「线路维护」",
    /<header class="topbar is-root"><h1>线路维护<\/h1><\/header>/.test(PAGE));
  t("页面 <title> 同步「线路维护」",
    /<title>线路维护 · 智配One<\/title>/.test(PAGE));
  t("底部 Tab 仍是「线路」（不跟着顶栏改长文案）",
    PAGE.includes("<span>线路</span>") && !PAGE.includes("<span>线路维护</span>"));

  /* 二、冗余板块标题清零 */
  t("「线路工作区」文字已删除", !PAGE.includes("线路工作区"));
  t("其说明「管理当前配送线路与线路资料。」一并删除", !PAGE.includes("管理当前配送线路与线路资料。"));
  t("HTML 里不再有 .dispatch-intro 空壳", !/class="dispatch-intro"/.test(PAGE));
  t("CSS 里不再有 .dispatch-intro 死规则", !/\.dispatch-intro/.test(CSS));
  t("两个功能分组标题文案保留",
    PAGE.includes("当前配送线路") && PAGE.includes("线路功能"));
  t("两条功能说明文案保留（没被当成冗余删掉）",
    PAGE.includes("申请维护线路、查看审核状态、解除绑定") &&
    PAGE.includes("查看当前线路门店资料，具备权限时可维护"));

  /* 三、文字层级：字号令牌 + 留白 */
  const titleRule = (CSS.match(/\.dispatch-section-title\{[^}]*\}/) || [""])[0];
  t("分组标题 14px 实色（--zp-text），不再是 13px 灰字",
    /--zp-fs-14/.test(titleRule) && /color:var\(--zp-text\)/.test(titleRule) && !/--zp-fs-13/.test(titleRule),
    titleRule);
  t("两个分组之间用 22px 留白分层",
    /\.dispatch-section \+ \.dispatch-section\{margin-top:22px\}/.test(CSS));
  t("线路名仍用全站唯一的 22px 展示字号",
    /\.dispatch-current-name\{[^}]*--zp-fs-22/.test(CSS));
  const statusRule = (CSS.match(/\.dispatch-current-status\{[^}]*\}/) || [""])[0];
  t("匹配状态提升到 13px、与名称分两行（margin-top:6px）",
    /--zp-fs-13/.test(statusRule) && /margin-top:6px/.test(statusRule), statusRule);
  const strongRule = (CSS.match(/\.dispatch-action-main strong\{[^}]*\}/) || [""])[0];
  const smallRule = (CSS.match(/\.dispatch-action-main small\{[^}]*\}/) || [""])[0];
  t("功能名 16px / 说明 13px（原来 15px / 12px 太挤）",
    /--zp-fs-16/.test(strongRule) && /--zp-fs-13/.test(smallRule),
    strongRule + " | " + smallRule);

  /* 四、卡片内两行结构 */
  t("renderCurrent 用 .dispatch-current-info 包住名称与状态（上下两行）",
    /class="dispatch-current-info"/.test(PAGE) &&
    /dispatch-current-info[^']*dispatch-current-name[\s\S]{0,220}dispatch-current-status/.test(PAGE));
  t("状态文案改为「已匹配 N 家门店」（数字前后留空格，不再黏连）",
    /已匹配 <span class="dispatch-current-count">/.test(PAGE) && / 家门店/.test(PAGE));
  t("右侧「切换」按钮仍在（文字布局优化不改交互）",
    PAGE.includes('id="switchRouteBtn" class="dispatch-switch"'));

  /* 五、缓存版本 */
  const ref = (PAGE.match(/\/css\/business-pages\.css\?v=([a-f0-9]+)/) || [])[1];
  const actual = createHash("md5").update(read("css/business-pages.css")).digest("hex").slice(0, 8);
  t("business-pages.css 的 ?v 与内容哈希一致（改样式必刷缓存）",
    !!ref && ref === actual, `页面 ${ref} / 实际 ${actual}`);
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
