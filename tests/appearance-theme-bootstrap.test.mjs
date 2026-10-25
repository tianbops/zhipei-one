/**
 * 主题首屏初始化与设计令牌纪律（appearance-theme-bootstrap）
 * ============================================================================
 * 2026-10-23 全局视觉整改后，本测试改写为「新设计终态」断言——护栏先行：
 * Phase 4（换色落地）完成前它为红，转绿即整改完成。断言分五组：
 *
 *   A. 首屏结构：早脚本先于首个样式表、首屏前设置 data-zp-theme、
 *      UI 四件套严格按 base→overlay→theme→shell 引入（顺序乱则层叠失效）；
 *   B. color-scheme：深色主题块必须显式 color-scheme:dark、其余 :root 块必须
 *      color-scheme:light——否则 WebView 里表单控件/滚动条会保持系统配色，
 *      深色模式下出现「白底黑字的滚动条」之类穿透（历史教训）；
 *   C. 设计令牌：浅色默认 :root 块持用户 spec 全套取值（#F6F7F9/#FFFFFF/#111111/
 *      #666666/#999999/#EEEEEE/#1677FF/#00B42A/#FF7D00/#F53F3F/阴影 .06），
 *      深色块持深色 spec（#121826/#1E293B/#F1F5F9/#94A3B8/#64748B/#334155/
 *      #3B82F6/#22C55E/#FB923C/#EF4444/阴影 .25），logo 底板令牌 --zp-logo-plate 在册；
 *   D. 按钮体系：危险操作按钮 = 中性底 + 红字（var(--zp-secondary-bg) +
 *      var(--zp-error)，用户 2026-10 明确决策），旧「灰底灰字中性化」字面量必须绝迹；
 *   E. 壳色同步：appearance.js 与首屏早脚本把 #121826/#F6F7F9 回传安卓壳，
 *      静态 meta theme-color 默认浅色（#F6F7F9），修补 Group-B 五页不同步的漏洞。
 * ============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const htmlFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "tests") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".html")) htmlFiles.push(full);
  }
}
walk(root);

const themedPages = htmlFiles.filter(file => fs.readFileSync(file, "utf8").includes("ui-base.css"));
assert.ok(themedPages.length >= 8, "应覆盖主要业务页面");

// ============================ A. 首屏结构 ============================
for (const file of themedPages) {
  const html = fs.readFileSync(file, "utf8");
  const firstCss = html.search(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/i);
  const themeScript = html.indexOf("zp_appearance_theme");
  assert.ok(themeScript >= 0 && firstCss >= 0 && themeScript < firstCss,
    path.relative(root, file) + " 必须在首个样式表之前读取主题偏好");
  const early = html.slice(0, firstCss);
  assert.match(early, /data-zp-theme/, path.relative(root, file) + " 必须在首屏绘制前设置主题");
}

// 2026-10-22：ui-unified.css（55KB / 1207 行）按职责拆成 ui-base/ui-overlay/ui-theme/ui-shell 四份，
// 各页按此顺序引入 → 层叠顺序与原文件完全一致。这里按同样顺序拼接后断言，等价于断言原文件。
const UI_CSS_PARTS = ["css/ui-base.css", "css/ui-overlay.css", "css/ui-theme.css", "css/ui-shell.css"];
// 拆分后最容易出错的不是内容，而是「引入顺序」——顺序一乱，层叠就变、主题覆盖失效。
// 这里钉死：四个文件必须齐全且严格按 base→overlay→theme→shell 出现。
for (const file of themedPages) {
  const html = fs.readFileSync(file, "utf8");
  const at = UI_CSS_PARTS.map(p => html.indexOf("/" + p));
  assert.ok(at.every(i => i >= 0), path.relative(root, file) + " 缺少拆分后的 UI 样式文件");
  assert.ok(at.every((v, i) => i === 0 || v > at[i - 1]),
    path.relative(root, file) + " 的 UI 样式引入顺序错误（必须 base→overlay→theme→shell）");
}

const unified = UI_CSS_PARTS
  .map(p => fs.readFileSync(path.join(root, p), "utf8"))
  .join("\n");
for (const p of UI_CSS_PARTS) {
  assert.ok(fs.readFileSync(path.join(root, p), "utf8").trim().length > 0, p + " 不应为空");
}
for (const selector of [
  '.history-dialog-panel', '.dispatch-page', '.data-import-panel', '.account-page',
  '.bottom-nav', '.row', '.dialog', 'input'
]) {
  assert.ok(unified.includes(selector), "全局浅色适配未覆盖关键组件: " + selector);
}

// ============================ B/C. color-scheme 与设计令牌 ============================
// :root 块提取（先剥注释，否则选择器文本以 /* 开头不匹配）
const rootBlocks = css => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const re = /:root(?:\[[^\]]*\])?(?:\.theme-[a-z]+)?/g;
  let m;
  while ((m = re.exec(clean))) {
    const i = clean.indexOf("{", m.index + m[0].length - 1);
    if (i < 0) continue;
    let depth = 0, j = i;
    for (; j < clean.length; j++) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") { depth--; if (!depth) break; }
    }
    // lastIndexOf 从 i-1 起找，避免把当前 { 自己算进边界（自匹配 bug）
    const selStart = clean.lastIndexOf("}", i - 1) + 1;
    blocks.push({ sel: clean.slice(selStart, i).trim(), body: clean.slice(i + 1, j) });
    re.lastIndex = j;
  }
  return blocks;
};
const allRootBlocks = UI_CSS_PARTS.flatMap(p => rootBlocks(fs.readFileSync(path.join(root, p), "utf8")));
assert.ok(allRootBlocks.length > 0, "UI 四件套中应存在 :root 令牌块");
const darkBlocks = allRootBlocks.filter(b => /dark/i.test(b.sel));
const lightBlocks = allRootBlocks.filter(b => !/dark/i.test(b.sel));

// B. color-scheme：深色块显式 dark；其余（浅色默认）显式 light
for (const b of darkBlocks) {
  assert.match(b.body, /color-scheme:\s*dark/, "深色主题块必须显式 color-scheme:dark（WebView 控件配色穿透）：" + b.sel);
}
for (const b of lightBlocks) {
  assert.match(b.body, /color-scheme:\s*light/, "非深色 :root 块必须显式 color-scheme:light：" + b.sel);
}

// C. 设计令牌：用户 spec 的浅色默认 + 深色覆盖（token 名沿用现有 --zp-* 体系）
const LIGHT_TOKENS = [
  ["--zp-bg", "#F6F7F9"], ["--zp-surface", "#FFFFFF"], ["--zp-text", "#111111"],
  ["--zp-muted", "#666666"], ["--zp-soft", "#999999"], ["--zp-line", "#EEEEEE"],
  ["--zp-primary", "#1677FF"], ["--zp-on-primary", "#FFFFFF"],
  ["--zp-success", "#00B42A"], ["--zp-warning", "#FF7D00"], ["--zp-error", "#F53F3F"],
  ["--zp-shadow", "0 2px 8px rgba(0,0,0,.06)"],
];
const DARK_TOKENS = [
  ["--zp-bg", "#121826"], ["--zp-surface", "#1E293B"], ["--zp-text", "#F1F5F9"],
  ["--zp-muted", "#94A3B8"], ["--zp-soft", "#64748B"], ["--zp-line", "#334155"],
  ["--zp-primary", "#3B82F6"], ["--zp-success", "#22C55E"], ["--zp-warning", "#FB923C"],
  ["--zp-error", "#EF4444"], ["--zp-shadow", "0 2px 8px rgba(0,0,0,.25)"],
];
for (const [name, value] of LIGHT_TOKENS) {
  assert.ok(lightBlocks.some(b => b.body.includes(name + ":" + value)),
    "浅色默认 :root 块缺少设计令牌 " + name + ":" + value);
}
for (const [name, value] of DARK_TOKENS) {
  assert.ok(darkBlocks.some(b => b.body.includes(name + ":" + value)),
    "深色主题块缺少设计令牌 " + name + ":" + value);
}
// logo 底板（登录页 brand badge / 顶栏 logo 的近黑底）双主题同值，命名令牌白名单
assert.ok(allRootBlocks.some(b => b.body.includes("--zp-logo-plate:#05070A")),
  "缺少 --zp-logo-plate:#05070A（logo 底板双主题同值，禁字面量直写）");

// ============================ D. 按钮体系 ============================
// 危险操作按钮唯一标准：中性底 + 红字（用户 2026-10 决策「中性底+红字」——
// 破坏性操作不用红底恐吓、也不延续灰字，与全站次按钮同底、仅文字取错误色）。
// .history-delete（历史页整行滑动动作条）保持实底专用样式，显式排除；
// .account-collapse-head（我的页折叠行）不是动作按钮，同样排除。
// 取规则体后逐条断言（顺序无关），避免Phase 2 调整声明次序就误报。
const ruleBodyOf = (css, selector) => {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{]*\\{([^}]*)\\}"));
  return m ? m[1] : null;
};
const DANGER_SEL = 'button[class*="delete"]:not(.account-collapse-head):not(.history-delete)';
const dangerBody = ruleBodyOf(unified, DANGER_SEL);
assert.ok(dangerBody !== null, "危险操作按钮唯一标准缺失：" + DANGER_SEL);
assert.match(dangerBody, /background:\s*var\(--zp-secondary-bg\)\s*(?:!important)?/,
  "危险操作按钮必须用中性底 var(--zp-secondary-bg)");
assert.match(dangerBody, /color:\s*var\(--zp-error\)\s*(?:!important)?/,
  "危险操作按钮必须用红字 var(--zp-error)");
assert.ok(unified.includes(":not(.history-delete)"),
  "滑动动作条 .history-delete 必须从全站普通按钮危险样式中显式排除（透视+圆角直角混绘）");
assert.ok(unified.includes('button[class*="delete"]:not(.account-collapse-head):not(.history-delete):active'), "危险操作按钮缺少按压状态");
assert.ok(unified.includes('button[class*="delete"]:not(.account-collapse-head):disabled'), "危险操作按钮缺少禁用状态");
assert.ok(unified.includes('button[class*="danger"]:not(.account-collapse-head)'),
  "折叠行组件不得套用危险动作按钮实底样式（保留排除写法）");
for (const selector of [".history-choice-delete", ".data-swipe-actions .data-swipe-delete", ".page2-danger-btn"]) {
  assert.ok(unified.includes(selector), "全局危险操作按钮样式缺少覆盖: " + selector);
}
// 旧「灰底灰字中性化」字面量必须绝迹（Phase 2 删除 ui-theme.css 中性化块后转绿）
for (const dead of [
  "background:#11171D!important", "border:1px solid #35404C!important", "color:#E8EDF2!important",
  "background:#F0F2F4!important", "border:1px solid #D7DDE3!important", "color:#17202A!important",
]) {
  assert.ok(!unified.includes(dead), "旧危险按钮中性化字面量仍在：" + dead);
}
assert.ok(
  fs.readFileSync(path.join(root, "css/history-shell.css"), "utf8").includes(".history-delete{"),
  "history.css 必须接管 .history-delete 专用样式"
);

// ============================ E. 主题底色同步 ============================
// 底色真值唯一：深色 #121826 ↔ 浅色 #F6F7F9，由映射表统一给出，杜绝多处各写一半对不齐。
const unifiedJs = fs.readFileSync(path.join(root, "js/ui/appearance.js"), "utf8");
assert.ok(/const\s+dark\s*=\s*resolved\s*!==\s*"light"/.test(unifiedJs) && unifiedJs.includes('"#121826":"#F6F7F9"'),
  "主题底色必须与网页主题一致（深色 #121826 / 浅色 #F6F7F9）");
// js/ui/appearance.js 在页面底部，加载线上页面时可能晚于首帧，
// 因此 <head> 里的内联主题脚本（比任何外链 JS 都早）也必须同步一次，否则浅色用户会先看到深色再跳变。
// 2026-10-23：原 Group-B 五页（index/register/setup/offline/admin-bootstrap）只设属性不同步 meta，
// 是「meta theme-color 匹配漏洞」；基底反转为浅色默认后，全部页面必须统一同步。
for (const file of themedPages) {
  const html = fs.readFileSync(file, "utf8");
  assert.ok(html.includes('meta[name="theme-color"]'),
    path.relative(root, file) + " 缺少 meta[name=theme-color]");
  assert.ok(/<meta name="theme-color" content="#F6F7F9">/.test(html),
    path.relative(root, file) + " 静态 meta theme-color 默认值必须为浅色 #F6F7F9（浅色为默认外观）");
  const firstCss = html.search(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/i);
  const early = html.slice(0, firstCss);
  assert.ok(early.includes("theme-color"),
    path.relative(root, file) + " 的首屏内联主题脚本必须同步 meta theme-color");
}
console.log("主题首屏初始化与设计令牌纪律检查通过（" + themedPages.length + " 个页面）");
