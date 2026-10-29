/**
 * 设计语言刻度守卫（ui-token-guard）
 * ============================================================================
 * 背景（2026-10-29 UI 专项整治）：
 *   整治前全站字号 28 种、圆角 32 种（8/9/10/11/12/13/14/17/18/19 十档同时在用）、
 *   字重 9 种。同一控件在不同页面各写一套度量，再靠 !important 压成「看起来一样」，
 *   这就是「东拼西凑」的来源。整治把刻度收成固定档位，全部住在 css/ui-base.css
 *   的 :root（--zp-fs-* / --zp-fw-* / --zp-lh-* / --zp-r-* / --zp-sp-*）。
 *
 *   本脚本是这套刻度的护栏：**组件层不得再写字面量**，否则新人换条选择器、
 *   换个页面就把第 33 种圆角带回来（历史上反复发生）。教训固化为 CI 不变量。
 *
 * 允许清单（带理由，逐条登记，不放宽）：
 *   · font-size 22px       —— 图表大数字（OV 指标、趋势峰值），展示型排版
 *   · font-size 26/28/31/32px —— 登录页品牌标题（"每一件货物，都有自己的线路。"），
 *                              展示型排版，不参与正文层级
 *   · border-radius ≤7px   —— 进度条、拖拽把手、微角标（2/4/5/6/7px），
 *                              小于最小档 10px，不构成"第二套圆角"
 *   · border-radius 含空格的复合值 —— 0 13px 13px 0 / 18px 18px 12px 12px 这类
 *                              「单边圆角」语义，不能压成单值
 *   · font-weight 450      —— 等宽数字的光学微调（介于 400/500 之间，仅图表刻度）
 *
 * 跑法：node scripts/ui-token-guard.mjs
 * ============================================================================
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const FS_ALLOW = new Set(["22px", "26px", "28px", "31px", "32px"]);
const RADIUS_ALLOW_NUM = new Set([2, 4, 5, 6, 7]);
const FW_ALLOW = new Set(["450"]);

// 只扫「组件层」：css/ 下的源文件（排除构建产物与令牌定义本身）+ HTML 的 <style> 块
const CSS_FILES = fs
  .readdirSync(path.join(root, "css"))
  .filter(f => f.endsWith(".css") && !f.includes("bundle"))
  .map(f => "css/" + f);

const HTML_FILES = [];
for (const d of [".", "pages"]) {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) HTML_FILES.push(d === "." ? e.name : d + "/" + e.name);
  }
}

const stripComments = t => t.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

/** 令牌定义块（:root{--zp-fs-15:15px}）是刻度的住所，不参与检查 */
function tokenBlockRanges(css) {
  const ranges = [];
  const re = /:root(?:\[[^\]]*\])?\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 0;
    const start = css.indexOf("{", m.index);
    for (let j = start; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (!depth) {
          ranges.push([m.index, j + 1]);
          re.lastIndex = j;
          break;
        }
      }
    }
  }
  return ranges;
}

const inRanges = (i, rs) => rs.some(([a, b]) => i >= a && i < b);

const violations = [];
function scanText(file, text, ranges) {
  for (const m of text.matchAll(/font-size\s*:\s*([\d.]+px)(\s*!important)?/g)) {
    if (ranges && inRanges(m.index, ranges)) continue;
    if (FS_ALLOW.has(m[1])) continue;
    violations.push({ file, line: lineOf(text, m.index), kind: "font-size", value: m[1] });
  }
  for (const m of text.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    if (ranges && inRanges(m.index, ranges)) continue;
    const v = m[1].trim().replace(/!important/, "").trim();
    if (v.startsWith("var(") || v === "0" || v === "50%") continue;
    if (/\s/.test(v)) continue; // 单边圆角复合值，语义不可压成单值
    const num = parseFloat(v);
    if (Number.isFinite(num) && RADIUS_ALLOW_NUM.has(num)) continue;
    violations.push({ file, line: lineOf(text, m.index), kind: "border-radius", value: v });
  }
  for (const m of text.matchAll(/font-weight\s*:\s*(\d{3})/g)) {
    if (ranges && inRanges(m.index, ranges)) continue;
    if (FW_ALLOW.has(m[1])) continue;
    violations.push({ file, line: lineOf(text, m.index), kind: "font-weight", value: m[1] });
  }
}

for (const f of CSS_FILES) {
  const raw = fs.readFileSync(path.join(root, f), "utf8");
  const text = stripComments(raw);
  scanText(f, text, tokenBlockRanges(text));
}
for (const f of HTML_FILES) {
  const raw = fs.readFileSync(path.join(root, f), "utf8");
  for (const m of raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = m.index + m[0].indexOf(m[1]);
    const body = stripComments(m[1]);
    const before = violations.length;
    scanText(f, body, null);
    for (let i = before; i < violations.length; i++) {
      // HTML 内联块的行号需要加上块起始偏移
      violations[i].line += lineOf(raw, start) - 1;
    }
  }
}

if (violations.length) {
  const byFile = new Map();
  for (const v of violations) byFile.set(v.file, (byFile.get(v.file) || 0) + 1);
  console.log(
    "\n【设计语言刻度违规】共 " + violations.length + " 处，分布：" +
      [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, c]) => f + " " + c).join(" | ")
  );
  for (const v of violations) console.log("  " + v.file + ":" + v.line + "  " + v.kind + "  " + v.value);
  console.log("\n改法：字号 → var(--zp-fs-*)，字重 → var(--zp-fw-*)，圆角 → var(--zp-r-*)。");
  console.log("确有必要的新档位，先加进 css/ui-base.css 的 :root，再改本脚本的允许清单。");
  process.exit(1);
}
console.log("设计语言刻度检查通过：字号/字重/圆角零字面量（允许清单内除外）");
