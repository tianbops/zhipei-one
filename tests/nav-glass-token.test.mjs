/**
 * 浮岛表面契约（2026-11-05 五版，用户定稿「A · 纯白不透明」）
 * ------------------------------------------------------------------
 * 运行：node tests/nav-glass-token.test.mjs
 *
 * 文件名沿用历史（它曾经守护「毛玻璃」那一版材质）。四版之前这里是玻璃契约：
 * alpha 区间、backdrop-filter、板感渐变、内高光、投影。五版用户逐项否掉 ——
 * 「不要阴影，按钮区域不要高亮，保持以前版本原有色」—— 表面退回不透明实色，
 * 于是本文件改成守护**实色契约**，语义与断言一一对应地翻了过来：
 *
 *   1) 表面必须是 var(--zp-nav-bg) 的实色，不得出现 rgba / 渐变 / 模糊；
 *   2) 不得有投影、内高光、按下背景块（用户逐条点名去掉的三样）；
 *   3) 1px 描边必须保留（浅色下是唯一轮廓，深色下是唯一分界）；
 *   4) 缺口几何：圆心落在浮岛顶边、缝 7px —— 「加号独立」的全部实现就是这两个数；
 *   5) 收起后加号反向补偿到距屏底 21px，且 pointer-events 单独放开（可点）；
 *   6) 配色零改动：文字 / 选中态 / 主色两套主题一个都没变。
 *
 * 为什么这些要写成测试而不是靠肉眼验收：本项目已经出现过两次「改了但看起来一样」
 * （alpha .86 与 .80 都算不出与实心色的差别）。只有把「表面是什么、凸出多少、
 * 缝多宽、收起停在哪」量化，才能在下次顺手调参时立刻发现偏离。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW_BASE = readFileSync(fileURLToPath(new URL("../css/ui-base.css", import.meta.url)), "utf8");
const RAW_THEME = readFileSync(fileURLToPath(new URL("../css/ui-theme.css", import.meta.url)), "utf8");
/* 注释里也写着旧值（例：`transform:translateY(-24px)` 的历史说明），
   不剥离会匹配到注释里的数字，得到「圆心偏移 32px」的假红。 */
const BASE = RAW_BASE.replace(/\/\*[\s\S]*?\*\//g, "");
const THEME = RAW_THEME.replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ---- 取值辅助：只在第一个 :root（浅色基底）与深色主题块里找，避免命中组件层 ---- */
function rootBlock(css) {
  const i = css.indexOf(":root{");
  const j = css.indexOf("}", i);
  return css.slice(i, j);
}
function darkBlock(css) {
  const i = css.indexOf(':root[data-zp-theme="dark"]');
  const j = css.indexOf("\n}", i);
  return css.slice(i, j);
}
const LIGHT = rootBlock(BASE);
const DARK = darkBlock(THEME);

const pickHex = (block, name) => {
  const m = block.match(new RegExp("--" + name + "\\s*:\\s*(#[0-9A-Fa-f]{6})"));
  return m ? m[1].toUpperCase() : null;
};
const pickVar = (block, name) => {
  const m = block.match(new RegExp("--" + name + "\\s*:\\s*var\\((--[\\w-]+)\\)"));
  return m ? m[1] : null;
};
const pickPx = (block, name) => {
  const m = block.match(new RegExp("--" + name + "\\s*:\\s*(-?\\d+)px"));
  return m ? +m[1] : null;
};
const rule = (css, selector) => {
  /* 必须锚在行首 + 精确选择器：`.zp-nav-plus .zp-nav-icon` 是
     `.zp-nav.is-nav-hidden .zp-nav-plus .zp-nav-icon` 的后缀，
     用 indexOf 会先命中隐藏态那条，量出来的 translateY 是补偿值 -103。 */
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp("(?:^|\\n)" + esc + "\\{([^}]*)\\}"));
  return m ? m[1] : "";
};

const NAV = rule(BASE, ".zp-nav");
const SURFACE = rule(BASE, ".zp-nav::before");
const PLUS = rule(BASE, ".zp-nav-plus .zp-nav-icon");
const HIDDEN_PLUS = rule(BASE, ".zp-nav.is-nav-hidden .zp-nav-plus .zp-nav-icon");
const ITEM = rule(BASE, ".zp-nav-item");

/* ============ 一、表面 = 不透明实色（无玻璃、无渐变、无模糊） ============ */
console.log("一、表面是不透明实色 (5 条)");
{
  t(".zp-nav 本体不画背景（表面在 ::before，理由见 CSS 注释）",
    /background:\s*none/.test(NAV), NAV.trim().slice(0, 60));
  t("::before 的底色就是 var(--zp-nav-bg)（不是另取一支颜色）",
    /background:\s*var\(--zp-nav-bg\)/.test(SURFACE),
    (/background:[^;]+/.exec(SURFACE) || [])[0]);
  t("::before 底色里没有 rgba（不透明实色，不再叠 alpha）",
    !/rgba\(/.test((/background:[^;]+/.exec(SURFACE) || [""])[0]));
  t("没有 background-image（板感渐变已下线）",
    !/background-image/.test(SURFACE), (/background-image:[^;]+/.exec(SURFACE) || [])[0]);
  t("没有 backdrop-filter（不透明底上模糊无产出，白付合成开销）",
    !/backdrop-filter:\s*(?!none)/.test(SURFACE));
}

/* ============ 二、无阴影 / 无高光 / 无按下高亮 ============ */
console.log("\n二、无阴影、无高光、无按下高亮 (4 条)");
{
  t("浮岛无投影（box-shadow:none）", /box-shadow:\s*none/.test(SURFACE),
    (/box-shadow:[^;]+/.exec(SURFACE) || [])[0]);
  t("加号无投影（box-shadow:none）", /box-shadow:\s*none/.test(PLUS),
    (/box-shadow:[^;]+/.exec(PLUS) || [])[0]);
  const activeRule = (/\.zp-nav-item:active\{([^}]*)\}/.exec(BASE) || [])[1] || "";
  t("按下不铺背景块（用户：「按钮区域不要高亮」）",
    !/background/.test(activeRule), activeRule);
  t("加号按下不加亮度滤镜（filter:brightness 已删）",
    !/brightness\(/.test(BASE));
}

/* ============ 三、1px 描边与配色零改动 ============ */
console.log("\n三、描边与配色 (6 条)");
{
  t("::before 保留 1px 实边 var(--zp-nav-edge)",
    /border:\s*1px solid var\(--zp-nav-edge\)/.test(SURFACE));
  t("浅色描边 rgba(0,0,0,.16) / 深色 rgba(255,255,255,.15) 都在",
    /--zp-nav-edge:\s*rgba\(0,0,0,\.16\)/.test(LIGHT) &&
    /--zp-nav-edge:\s*rgba\(255,255,255,\.15\)/.test(DARK));
  /* 2026-11-05 六版：浅色描边下限 .12、上限 .20。
     下限 —— 浮岛 #FFFFFF 与页面底 #FFFFFF 同色（实测两侧采样都是 255），
     去掉投影后这条 1px 是唯一轮廓；.08 算出来 #EBEBEB 只差 20 阶，
     3x 屏上被抗锯齿摊开就看不出边界，回退到那个档位等于又变回「贴纸」。
     上限 —— 同一个令牌还给缺口环用，.20 起外沿会先于内容抢注意力，
     整块板从「有边」变成「套了灰框」。区间外都判红。 */
  const edgeAlpha = +(/(--zp-nav-edge:\s*rgba\(0,0,0,\.(\d+)\))/.exec(LIGHT) || [])[2];
  const ea = Number("0." + String(edgeAlpha));
  t("浅色描边对比度落在 .12~.20 区间（低于 .12 读不出轮廓，高于 .20 成灰框）",
    ea >= 0.12 && ea <= 0.2, "alpha=" + ea);
  t("浅色表面 = --zp-surface（导航底色仍是那支白）",
    pickVar(LIGHT, "zp-nav-bg") === "--zp-surface");
  t("深色表面 = --zp-block（比页面底亮一档）",
    pickVar(DARK, "zp-nav-bg") === "--zp-block");
  const navText = pickHex(DARK, "zp-nav-text") + "/" + pickHex(DARK, "zp-nav-text-active");
  t("导航文字与选中态零改动（#666/#000 · #A3A3A3/#FFF · 主色 #2C6CE2）",
    pickHex(LIGHT, "zp-nav-text") === "#666666" && pickHex(LIGHT, "zp-nav-text-active") === "#000000" &&
    navText === "#A3A3A3/#FFFFFF" &&
    pickHex(LIGHT, "zp-primary") === "#2C6CE2" && pickHex(DARK, "zp-primary") === "#2C6CE2");
}

/* ============ 四、加号缺口几何（「加号独立」的全部实现） ============ */
console.log("\n四、加号缺口几何 (8 条)");
{
  const padY = pickPx(LIGHT, "zp-nav-pad-y");
  const cy = pickPx(LIGHT, "zp-nav-notch-cy");
  const r = pickPx(LIGHT, "zp-nav-notch-r");
  const ty = +(/(?:translateY|translate)\(\s*(-?\d+)px\)/.exec(PLUS) || [])[1];
  const plusD = +(/width:\s*(\d+)px/.exec(PLUS) || [])[1];

  t("缺口圆心与加号圆心重合（padY + 行高52/2 + translateY = cy）",
    [padY, cy, r, ty, plusD].every(Number.isFinite) &&
      Math.abs((padY + 52 / 2 + ty) - cy) <= 1,
    `padY=${padY} ty=${ty} cy=${cy} 期望=${Number.isFinite(padY) && Number.isFinite(ty) ? padY + 26 + ty : "?"}`);
  t("圆心正好落在浮岛顶边（cy = 0，即上下各露一半）", cy === 0, String(cy));
  t("凸出量 = 加号半径 26px（四版是 18px，直径的 34%）",
    ty === -32 && plusD === 52, `ty=${ty} plusD=${plusD}`);
  t("缺口半径 > 加号半径（缝必须存在，否则又变回「贴上去的圆」）",
    Number.isFinite(r) && Number.isFinite(plusD) ? r > plusD / 2 : false, `r=${r} plus=${plusD}`);
  t("缝宽在 4~12px（太窄看不见、太宽像洞）",
    Number.isFinite(r) && Number.isFinite(plusD) ? (r - plusD / 2) >= 4 && (r - plusD / 2) <= 12 : false,
    `缝=${r - plusD / 2}`);
  t("mask 打在 ::before 上、不在 .zp-nav 本体（否则连加号圆顶一起裁掉）",
    /mask:var\(--zp-nav-notch\)/.test(SURFACE) && !/^\s*mask:/m.test(NAV));
  t("按钮层抬到表面层之上（绝对定位的 ::before 会盖住按钮）",
    /position:\s*relative/.test(ITEM) && /z-index:\s*1/.test(ITEM));
  /* 圆心能对上，前提是表面盒不能被负 margin 撑出浮岛 —— 撑出去多少，
     mask 的圆心就跟着偏多少（四版撑了 6px，结果上缝 1px、下缝 13px）。 */
  t("表面盒不再用负 margin 外扩（外扩会让缺口圆心比加号高 6px，缝一边 1px 一边 13px）",
    !/margin:\s*calc\(-1 \* var\(--zp-nav-pad/.test(SURFACE) && /inset:\s*0/.test(SURFACE),
    (/margin:[^;]+/.exec(SURFACE) || [])[0]);
}

/* ============ 五之一、缺口描边环（用户：下面缺口要描边） ============ */
console.log("\n五、缺口描边环 (4 条)");
{
  const RING = rule(BASE, ".zp-nav::after");
  const r = pickPx(LIGHT, "zp-nav-notch-r");
  const cy = pickPx(LIGHT, "zp-nav-notch-cy");

  t("::after 是描边环（1px 实边 + 圆形 + 与浮岛外沿同一支描边色）",
    /border:\s*1px solid var\(--zp-nav-edge\)/.test(RING) && /border-radius:\s*50%/.test(RING),
    RING.slice(0, 60));
  t("环径 = 缺口直径 + 2（边框正好落在实体侧 33~34，不吃窄 7px 的缝）",
    new RegExp("width:calc\\(var\\(--zp-nav-notch-r\\) \\* 2 \\+ 2px\\)").test(RING) &&
    new RegExp("height:calc\\(var\\(--zp-nav-notch-r\\) \\* 2 \\+ 2px\\)").test(RING));
  t("环心与缺口同心（top = cy - r - 1，即盒中心落在圆心）",
    /top:calc\(var\(--zp-nav-notch-cy\) - var\(--zp-nav-notch-r\) - 1px\)/.test(RING),
    (/top:[^;]+/.exec(RING) || [])[0]);
  t("只保留下半圆（上半露在浮岛外，描上去会成悬空弧；切口下移 1px 让端点藏进顶边线）",
    /mask:linear-gradient\(180deg,transparent calc\(50% \+ 1px\),#000/.test(RING) &&
    Number.isFinite(r) && Number.isFinite(cy));
}

/* ============ 五、收起后加号独立留在底部 ============ */
console.log("\n六、收起态：浮岛沉下去、加号留在距底 21px (4 条)");
{
  const bottom = +(/(?:^|;)bottom:calc\((\d+)px/.exec(NAV.replace(/\n\s*/g, ";")) || [])[1];
  const navH = +(/min-height:\s*(\d+)px/.exec(NAV) || [])[1];
  const ty0 = +(/(?:translateY|translate)\(\s*(-?\d+)px\)/.exec(PLUS) || [])[1];
  const ty1 = +(/(?:translateY|translate)\(\s*(-?\d+)px\)/.exec(HIDDEN_PLUS) || [])[1];
  const plusD = +(/width:\s*(\d+)px/.exec(PLUS) || [])[1];
  const shift = navH + 32; // 隐藏位移 = 100%（本体高）+ 32px 余量
  const shown = bottom + navH - plusD / 2;      // 展开态加号底边距屏底 = 46
  const hiddenDist = shown - shift + (Math.abs(ty1) - Math.abs(ty0));

  t("隐藏态对加号做了单独的反向补偿（不是跟着浮岛一起沉下去）",
    !!HIDDEN_PLUS && Number.isFinite(ty1) && ty1 < ty0, `ty0=${ty0} ty1=${ty1}`);
  t("补偿后的停靠位置距屏底 21px（与参考软件收起态同位置）",
    Math.abs(hiddenDist - 21) <= 2, `实算=${hiddenDist.toFixed(1)}px`);
  t("隐藏态放行加号的 pointer-events（父级 none 之下单独 auto，才点得到）",
    /pointer-events:\s*auto/.test(BASE.slice(BASE.indexOf(".zp-nav.is-nav-hidden .zp-nav-plus"), BASE.indexOf(".zp-nav-item{"))));
  t("隐藏仍是位移、不是淡出（隐藏态不含 opacity）",
    !/opacity/.test(rule(BASE, ".zp-nav.is-nav-hidden")));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { for (const f of failures) console.log("  - " + f); process.exit(1); }
