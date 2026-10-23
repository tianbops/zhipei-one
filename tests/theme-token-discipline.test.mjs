/**
 * 主题 Token 纪律护栏（theme-token-discipline）
 * ============================================================================
 * 背景与教训（③）——为什么要有本文件：
 *
 * 1. 2026-10 收口确认框/系统菜单时总结的教训：「主题变量优先、禁止高特异度写死配色」。
 *    当时管理员页用 #18212B 之类蓝灰色以 ID 选择器写死，绕过了全部主题变量，
 *    导致 App 切到浅色外观后确认框/系统菜单仍是深色——主题切换出现「漏网之鱼」。
 *    同类问题在历史整改中反复出现（换条选择器、换个马甲就复活），
 *    因此把教训固化为 CI 不变量，而不是依赖 review 记性。
 *
 * 2. 2026-10-23 启动全局视觉体系整改（对标 Uber 极简风格 + 浅/深双主题）：
 *    - 两段式落地：Phase 1-3 先把硬编码色令牌化（持旧值、零漂移，每个中间态可部署），
 *      Phase 4 一次性换令牌值（Big Bang 单提交），Phase 5 修剪冗余补丁。
 *    - 本护栏是该项计划的不变量，两条检查 + 一条兼容地板：
 *      ① 组件层不得用字面量（hex/rgba）重复实现任何全局 Token 的取值——
 *         防止有人写死 #1A2230 之类灰蓝色把浅色主题绕过；
 *      ② 旧设计退休色板不得复现——旧 palette 换条选择器换个马甲回来；
 *      ③ WebView 兼容地板：禁 color-mix()（安卓 WebView 老版本不支持）。
 *
 * 3. 权威源自我维护：① 的 Token 取值从三份主题文件的 :root 块动态提取
 *    （css/ui-base.css、css/ui-theme.css、css/mobile-ui.css），
 *    将来改主题色不用改本测试；纯黑纯白排除（双主题同值、无主题风险），零误报。
 *
 * 4. 投毒验证（写入时实测）：组件写死 Token 值 / overlay 复现 #18212B /
 *    menu-bg 复现 #D5DCE2 / 新增 color-mix()——四类投毒全部拦截，撤销后复绿。
 * ============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();

// ---------------------------------------------------------------------------
// 基础工具：注释剥离、:root 块定位（brace 配对，兼容 @media 嵌套与选择器列表）
// ---------------------------------------------------------------------------
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 定位全部 :root / :root[data-zp-theme="..."] / :root.theme-* 块的字符区间 */
function rootRanges(css) {
  css = stripComments(css);
  const ranges = [];
  const re = /:root(?:\[[^\]]*\])?(?:\.theme-[a-z]+)?/g;
  let m;
  while ((m = re.exec(css))) {
    const i = css.indexOf("{", m.index + m[0].length - 1);
    if (i < 0) continue;
    let depth = 0, j = i;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") { depth--; if (!depth) break; }
    }
    ranges.push([m.index, j + 1]);
    re.lastIndex = j;
  }
  return ranges;
}

/** 取出 :root 块的选择器与声明体（动态提取 Token 真值用） */
function rootBlocks(css) {
  css = stripComments(css);
  const blocks = [];
  for (const [a, b] of rootRanges(css)) {
    const i = css.indexOf("{", a);
    // lastIndexOf 从 i-1 起找，避免把当前 { 自己算进边界（自匹配 bug）
    const selStart = css.lastIndexOf("}", i - 1) + 1;
    blocks.push({ sel: css.slice(selStart, i).trim(), body: css.slice(i + 1, b - 1) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 字面量归一：大小写/3位/4位/8位 hex 统一，rgba 去空白小写，triple 去 alpha
// ---------------------------------------------------------------------------
// \b 收尾防误匹配：#backBtn 的 "#bac" 片段不是颜色（会被展开成 #BBAACC）
const HEX_LITERAL = /#[0-9A-Fa-f]{3,8}\b/g;
const RGBA_LITERAL = /rgba?\([^)]+\)/gi;
const COLOR_MIX_LITERAL = /color-mix\(/gi;

const normHex = h => {
  h = h.toUpperCase();
  if (h.length === 4) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (h.length === 5) return "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] + h[4] + h[4];
  return h;
};
const normRgba = r => r.replace(/\s+/g, "").toLowerCase();
const rgbaTriple = r => {
  const m = r.match(/rgba?\(([^)]+)\)/i);
  return m ? m[1].split(",").slice(0, 3).map(s => s.trim()).join(",") : null;
};

// ---------------------------------------------------------------------------
// ① 令牌索引：从权威主题文件的 :root 块动态提取 --zp-*/--ui-* 的取值
//    纯黑纯白（hex #000/#FFF、triple 0,0,0 / 255,255,255）排除：双主题同值、无主题风险
// ---------------------------------------------------------------------------
const AUTH_FILES = ["css/ui-base.css", "css/ui-theme.css", "css/mobile-ui.css"];
const TOKEN_HEX = new Set();
const TOKEN_RGBA = new Set();
for (const f of AUTH_FILES) {
  const css = fs.readFileSync(path.join(root, f), "utf8");
  for (const block of rootBlocks(css)) {
    for (const decl of block.body.split(";")) {
      const m = decl.match(/--(?:zp|ui)-[\w-]+\s*:\s*(.+)$/);
      if (!m) continue;
      const v = m[1].trim();
      for (const h of v.match(HEX_LITERAL) || []) {
        const n = normHex(h);
        if (n !== "#000000" && n !== "#FFFFFF") TOKEN_HEX.add(n);
      }
      for (const r of v.match(RGBA_LITERAL) || []) {
        const t = rgbaTriple(r);
        if (t !== "0,0,0" && t !== "255,255,255") TOKEN_RGBA.add(normRgba(r));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ② 退休色板：旧设计（深色 Uber 中性 + admin 蓝灰 + 旧浅色蓝灰 + 旧状态色族）
//    冻结快照——2026-10-23 重建时从旧代码库机械导出（组件层字面量 ∪ 令牌值，
//    去纯黑白、去新设计值）。即使旧用法被全部清除，本清单继续阻止其复活。
//    新设计色板（用户 spec）永不在列：
const NEW_DESIGN_HEX = [
  "#F6F7F9", "#FFFFFF", "#111111", "#666666", "#999999", "#EEEEEE",
  "#1677FF", "#00B42A", "#FF7D00", "#F53F3F",
  "#121826", "#1E293B", "#F1F5F9", "#94A3B8", "#64748B", "#334155",
  "#3B82F6", "#22C55E", "#FB923C", "#EF4444",
];
const RETIRED_HEX = new Set([
  // 旧深色 Uber 中性族
  "#05070A", "#0A0A0A", "#0A0E13", "#0B1015", "#0C1117", "#0D1217", "#0E141A",
  "#10161D", "#11171D", "#141414", "#141B22", "#141C25", "#17202A", "#18212B",
  "#1A1A1A", "#1A222C", "#1C1C1C", "#1C2530", "#1D2A24", "#1D2A36", "#1F1F1F",
  "#1F2C38", "#202A31", "#202B36", "#222C36", "#262626", "#26313C", "#27323D",
  "#2A2A2A", "#2A3540", "#2C3742", "#2E2E2E", "#2E3A46", "#2E3B47", "#303943",
  "#303C48", "#333333", "#3A3A3A", "#3A4651", "#3A4652", "#404040", "#46515D",
  "#4A5A68", "#4F5A65", "#53606D", "#536170", "#536273", "#59636E", "#596674",
  "#5A2A2A", "#5A5A5A", "#5B7188", "#5D6975", "#5F6E7C", "#66717D", "#68737E",
  "#687584", "#6A3940", "#6B6B6B", "#6F7B87", "#75818C", "#767676", "#778795",
  "#778796", "#7D8A98", "#7F8A95", "#7F8B98", "#85919C", "#8793A0", "#8A95A0",
  "#8A97A5", "#8B98A5", "#8F9AA5", "#8F9AA6", "#8F9BA7", "#93A3B1", "#9AA5AF",
  "#9AA6B2", "#9BA7B3", "#9DA8B3", "#A0A0A0", "#A8A8A8", "#B8C1C8", "#B8C2CC",
  "#C2CBD4", "#C7D0D9", "#C7D2DB", "#C9D1D9", "#D1D8DF", "#D4D4D4", "#D5DCE2",
  "#D6DEE6", "#D7DDE3", "#DCE3E9", "#DCE5EC", "#E0E0E0", "#E1E7EC", "#E3E8ED",
  "#E4E9EE", "#E6E6E6", "#E8EDF1", "#E8EDF2", "#EAEAEA", "#EDF1F5", "#EFEFEF",
  "#F0F0F0", "#F0F2F4", "#F0F3F6", "#F2F2F2", "#F2F5F7", "#F4F6F8", "#F5F5F5",
  "#F5F7F9",
  // admin 蓝灰与旧输入框/底栏族
  "#34414D", "#35404C", "#35414D",
  // 旧红族（danger/error/soft）
  "#4A2528", "#51282E", "#6A3940", "#8A2630", "#A0372E", "#B8A0A0",
  "#B93B32", "#C2453A", "#C98C7F", "#D9534B", "#E5483F", "#E8BFC3", "#FCEBEC",
  "#FF6B5E", "#FF8278", "#FF8A80", "#FFB4AB", "#FFB4B0", "#FFB4B4", "#FFD5D1",
  // 旧绿族
  "#157A45", "#1D2A24", "#2ECC71", "#4ADE80", "#7FB38A", "#8FD6A8",
  // 旧琥珀族
  "#9A5B00", "#B4232F", "#D99A42", "#E0B341", "#E8B34B", "#E8C283", "#F5A623",
  "#FFB020",
  // 旧蓝族（admin primary / info）
  "#1E6FD0", "#31455A", "#4DA3FF", "#5B7188",
]);
// rgba 三元组（任意 alpha 变体均命中）：旧「卡内浅染」白 tint、旧深色表面、
// 旧彩色 soft 底、旧阴影/遮罩。阴影与遮罩在新设计中一律走 Token（--zp-shadow 等）。
const RETIRED_TRIPLES = new Set([
  "255,255,255", "0,0,0",
  // 旧深色表面（输入框/按压态/浮层）
  "10,14,19", "13,18,24", "16,24,32", "17,23,29", "2,5,9", "20,28,37",
  "20,30,40", "20,31,40", "20,33,44", "26,26,26", "26,38,46", "28,40,52",
  "42,53,64", "5,7,10", "8,12,18", "10,10,10", "240,242,244",
  // 旧彩色 soft 底（状态徽标/提示底）
  "154,91,0", "180,35,47", "194,69,58", "21,122,69", "30,111,208", "46,204,113",
  "74,222,128", "77,163,255", "120,40,40", "143,214,168", "232,194,131",
  "245,166,35", "255,107,94", "255,130,120", "255,176,32", "184,194,204",
]);
// 自检：退休清单不得误含新设计值（否则 Phase 4 换色后护栏误伤）
for (const v of NEW_DESIGN_HEX) {
  assert.ok(!RETIRED_HEX.has(v), "退休色板误含新设计值 " + v + "（清单维护错误）");
}

// ---------------------------------------------------------------------------
// 扫描范围
//   ① 组件层（css/ 去 :root + HTML <style> 块 + style="" 属性）
//   ② 退休色板（css/ 去 :root + 根与 pages 目录 HTML 全文含内联脚本 + js/ 全量 + manifest.json）
//   tests/ 与 tools/ 豁免（护栏自身与工程脚本不参与）
// ---------------------------------------------------------------------------
const cssFiles = fs.readdirSync(path.join(root, "css")).filter(f => f.endsWith(".css")).map(f => "css/" + f);
const htmlFiles = [];
for (const d of [".", "pages"]) {
  for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".html")) htmlFiles.push(d === "." ? e.name : d + "/" + e.name);
  }
}
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = dir + "/" + e.name;
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".js")) jsFiles.push(full);
  }
})("js");

/**
 * 原位屏蔽：把匹配区域按字符挖空（保留换行），使后续扫描的索引/行号
 * 与原始文件严格一致——「剥离式」扫描会让行号漂移，工作清单对不上行。
 */
const blankOut = (text, re) => text.replace(re, m => m.replace(/[^\n]/g, " "));
const cssScannable = css => blankOut(css, /\/\*[\s\S]*?\*\//g);
const htmlScannable = html => blankOut(html, /<!--[\s\S]*?-->/g);

/** HTML 中 <style> 块内联 CSS 与 style="" 属性的字符区间（① 的范围，原位保留行号） */
function htmlStyleRanges(html) {
  const ranges = [];
  const reStyle = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = reStyle.exec(html))) {
    const s = m.index + m[0].indexOf(m[1]);
    ranges.push([s, s + m[1].length]);
  }
  const reAttr = /style\s*=\s*(["'])([^"']*)\1/gi;
  while ((m = reAttr.exec(html))) {
    const s = m.index + m[0].indexOf(m[2]);
    ranges.push([s, s + m[2].length]);
  }
  return ranges;
}
const inRanges = (idx, ranges) => ranges.some(([a, b]) => idx >= a && idx < b);

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
function scan(file, text, kinds, opts = {}) {
  const { skip = [], only = null } = opts;
  const out = [];
  const consider = idx => !inRanges(idx, skip) && (!only || inRanges(idx, only));
  // matchAll（而非 match）：g 标志下 match 只回字符串数组、丢失 index
  for (const m of text.matchAll(HEX_LITERAL)) {
    if (!consider(m.index)) continue;
    const v = normHex(m[0]);
    if (kinds.includes("token") && TOKEN_HEX.has(v)) out.push({ file, kind: "token-hex", value: v, idx: m.index });
    if (kinds.includes("retired") && RETIRED_HEX.has(v)) out.push({ file, kind: "retired-hex", value: v, idx: m.index });
  }
  for (const m of text.matchAll(RGBA_LITERAL)) {
    if (!consider(m.index)) continue;
    const v = normRgba(m[0]), t = rgbaTriple(m[0]);
    if (kinds.includes("token") && TOKEN_RGBA.has(v)) out.push({ file, kind: "token-rgba", value: v, idx: m.index });
    if (kinds.includes("retired") && RETIRED_TRIPLES.has(t)) out.push({ file, kind: "retired-rgba", value: v, idx: m.index });
  }
  return out;
}
const withLines = (file, text, list) => list.map(v => ({ ...v, line: lineOf(text, v.idx) }));

// ① 组件层：css（:root 块原位屏蔽）+ HTML <style>/style="" 作用域
const v1 = [];
for (const f of cssFiles) {
  const text = cssScannable(fs.readFileSync(path.join(root, f), "utf8"));
  v1.push(...withLines(f, text, scan(f, text, ["token"], { skip: rootRanges(text) })));
}
for (const h of htmlFiles) {
  const text = htmlScannable(fs.readFileSync(path.join(root, h), "utf8"));
  v1.push(...withLines(h, text, scan(h, text, ["token"], { only: htmlStyleRanges(text) })));
}
// ② 退休色板：css（:root 块原位屏蔽）+ 根与 pages HTML 全文 + js/ 全量 + manifest
const v2 = [];
for (const f of cssFiles) {
  const text = cssScannable(fs.readFileSync(path.join(root, f), "utf8"));
  v2.push(...withLines(f, text, scan(f, text, ["retired"], { skip: rootRanges(text) })));
}
for (const h of htmlFiles) {
  const text = htmlScannable(fs.readFileSync(path.join(root, h), "utf8"));
  v2.push(...withLines(h, text, scan(h, text, ["retired"])));
}
for (const j of jsFiles) v2.push(...withLines(j, fs.readFileSync(path.join(root, j), "utf8"), scan(j, fs.readFileSync(path.join(root, j), "utf8"), ["retired"])));
const manifestText = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
v2.push(...withLines("manifest.json", manifestText, scan("manifest.json", manifestText, ["retired"])));

// ③ WebView 兼容地板：禁 color-mix()（安卓老 WebView 不支持；现存 2 处随危险按钮重设计一并消除）
const colorMix = [];
for (const f of cssFiles) {
  const text = cssScannable(fs.readFileSync(path.join(root, f), "utf8"));
  for (const m of text.matchAll(COLOR_MIX_LITERAL)) colorMix.push({ file: f, line: lineOf(text, m.index) });
}

// ---------------------------------------------------------------------------
// 输出：违规即工作清单（Phase 1-3 令牌化 / Phase 4 换色的逐项待办）
// ---------------------------------------------------------------------------
const MAX_DETAIL = 400;
const report = (title, list) => {
  const byFile = new Map();
  for (const v of list) byFile.set(v.file, (byFile.get(v.file) || 0) + 1);
  console.log("\n【" + title + "】共 " + list.length + " 处，分布：" +
    [...byFile.entries()].sort((a, b) => b[1] - a[1]).map(([f, c]) => f + " " + c).join(" | "));
  for (const v of list.slice(0, MAX_DETAIL)) {
    console.log("  " + v.file + ":" + v.line + "  " + v.kind + "  " + v.value);
  }
  if (list.length > MAX_DETAIL) console.log("  …… 其余 " + (list.length - MAX_DETAIL) + " 处从略");
};
if (v1.length) report("① 组件层重复实现 Token 取值（应改用 var(--zp-*)）", v1);
if (v2.length) report("② 旧设计退休色板复现（应清除或令牌化）", v2);
if (colorMix.length) {
  console.log("\n【③ color-mix() 违反 WebView 兼容地板】共 " + colorMix.length + " 处：");
  for (const c of colorMix) console.log("  " + c.file + ":" + c.line);
}

assert.equal(v1.length, 0, "组件层存在 " + v1.length + " 处字面量重复实现 Token 取值（见上清单）");
assert.equal(v2.length, 0, "旧设计退休色板复现 " + v2.length + " 处（见上清单）");
assert.equal(colorMix.length, 0, "存在 " + colorMix.length + " 处 color-mix()，违反安卓 WebView 兼容地板");
console.log("\n主题 Token 纪律检查通过：组件层零字面量绕过、退休色板零复现、无 color-mix()");
