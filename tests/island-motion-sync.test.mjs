/**
 * 浮岛运动「上下呼应」契约（node tests/island-motion-sync.test.mjs）
 * ------------------------------------------------------------------
 * 2026-11-07 用户：「让浮岛弹出和收回更利索些，如 Shadowrocket 一样设计效果」
 *              「上下浮岛保持呼应」。
 * 问题：顶部浮层 .18s + cubic-bezier(.22,.8,.3,1)，底部浮岛 .24s +
 *       cubic-bezier(.32,.72,0,1) —— 时长与曲线都不同，松手后顶部先停、
 *       底栏还在路上，看起来是两件互不相干的事；再加上跟手系数 0.85
 *       （拖 117px 就全开），拖动「发飘」，松手吸附前还有一段无效行程。
 *
 * 本契约锁死的四件事（任何一条回归都会让「呼应」失效）：
 *   1) 唯一真相源：--zp-island-dur / --zp-island-ease 定义在 ui-base.css :root，
 *      取值 .18s + cubic-bezier(.32,.72,0,1)（起步即高速、尾部收干净、无过冲）；
 *   2) 顶部浮层、底栏本体、底栏加号图标 —— 三处 transition 全部引用这对 token，
 *      不得写死时长或曲线（写死就会出现第二个节奏）；让位块已恒 0、无过渡；
 *   3) 底栏显隐由 syncNav() 跟随浮岛二态切换（p=1 弹出→沉下 / p=0 收回→升起），
 *      与浮岛同一次状态切换里完成，不能等松手、也不能单点反复穿越；
 *   4) 浮岛是二态弹收、方向驱动（2026-11-07 第七轮：方向对调）：
 *      上滑（内容上移）≥6px → 上方浮岛弹出、下方浮岛隐藏；
 *      下滑（内容下移）≥6px → 上方浮岛隐藏、下方浮岛弹出；整块切一次；
 *      不做 scrollTop 比例跟随、不靠 touch 手势（会被 touchcancel 截断）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rd = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const UI = rd("../css/ui-base.css");
const HOME = rd("../css/home-dashboard.css");
const JS = rd("../js/home/head-float.js");
const BUNDLE_CSS = rd("../css/home.bundle.css");
const BUNDLE_JS = rd("../js/home.bundle.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const tokenDur = /--zp-island-dur\s*:\s*\.14s/.test(UI);
const tokenEase = /--zp-island-ease\s*:\s*cubic-bezier\(\.32,\.72,0,1\)/.test(UI);
const floatRule = (/\.home-app\s+\.zp-head-float\s*\{([^}]*)\}/.exec(HOME) || [])[1] || "";
const navBlock = (/^\.zp-nav\{([\s\S]*?)\n\}/m.exec(UI) || [])[1] || "";
const plusIcon = (/\n\.zp-nav-plus\s+\.zp-nav-icon\{([^}]*)\}/.exec(UI) || [])[1] || "";

console.log("浮岛运动 · 上下呼应契约（15 条）");

/* 一、令牌 */
t("ui-base 定义 --zp-island-dur:.14s（第二轮提速）", tokenDur);
t("ui-base 定义 --zp-island-ease:cubic-bezier(.32,.72,0,1)", tokenEase);
t("曲线不含过冲（y 控制点均 ≤ 1，无回弹）", /cubic-bezier\(\.32,\.72,0,1\)/.test(UI));

/* 二、四处引用同一对 token */
t("顶部浮层 transition 引用 --zp-island-dur/.ease",
  /transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(floatRule), floatRule.trim().slice(0, 120));
t("没有让位块（浮岛只做 transform，列表不被文档流推动，也就无第二个节奏）",
  !/\.zp-head-spacer/.test(HOME), "仍存在 .zp-head-spacer 规则");
t("底栏本体 transition 引用同一对 token",
  /transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(navBlock), navBlock.trim().slice(-120));
t("底栏加号图标 transition 引用同一对 token",
  /transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(plusIcon), plusIcon.trim().slice(-120));

/* 三、禁止第二套节奏 */
t("底栏不再残留 .24s 写死时长", !/transform\s+\.24s/.test(UI));
t("全站不再残留 cubic-bezier(.22,.8,.3,1) 作为浮岛节奏",
  !/cubic-bezier\(\.22,\.8,\.3,1\)/.test(HOME) && !/cubic-bezier\(\.22,\.8,\.3,1\)/.test(UI));

/* 四、联动时机与跟手（滚动驱动） */
t("底栏切换在 syncNav() 里跟随浮岛二态（p=1 沉下 / p=0 升起），同一次切换内同步",
  /function syncNav\(\)/.test(JS) && /var want=p>=\.5;/.test(JS) && /navHide\(navHidden\)/.test(JS),
  (JS.match(/navHide\([^)]*\)/g) || []).join(" | "));
t("write() 内只写 transform 与 is-open，不切底栏（避免一帧多写）",
  /function write\(\)\{[\s\S]{0,220}?\}/.test(JS) &&
  !/function write\(\)\{[\s\S]{0,180}?navHide/.test(JS));
t("二态弹收：跨阈值只切一次（apply(show) 写 p=show?1:0），无比例跟随/放大系数",
  /function apply\(show\)\{/.test(JS) && /p=show\?1:0;/.test(JS) &&
  !/mapP/.test(JS) && !/\*0\.85/.test(JS) && !/pStart/.test(JS));
t("首帧用 .is-scrolling 关过渡（避免进首页时浮岛滑一下）",
  /\.is-scrolling\)\{transition:none\}|\.is-scrolling\{transition:none\}/.test(HOME));

/* 五、产物同步（首页只加载 bundle） */
t("home.bundle.css 含统一 transition（源→产物同步）",
  /transition:transform var\(--zp-island-dur\) var\(--zp-island-ease\)/.test(BUNDLE_CSS));
t("home.bundle.js 含二态弹收 + 方向驱动 + 无让位写入",
  /p=show\?1:0/.test(BUNDLE_JS) && /TOP_AT=6, MOVE=6/.test(BUNDLE_JS) &&
  /navHide\(navHidden\)/.test(BUNDLE_JS) && !/spacer\.style\.height/.test(BUNDLE_JS));

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
