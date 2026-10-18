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

const themedPages = htmlFiles.filter(file => fs.readFileSync(file, "utf8").includes("ui-unified.css"));
assert.ok(themedPages.length >= 8, "应覆盖主要业务页面");

for (const file of themedPages) {
  const html = fs.readFileSync(file, "utf8");
  const firstCss = html.search(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/i);
  const themeScript = html.indexOf("zp_appearance_theme");
  assert.ok(themeScript >= 0 && firstCss >= 0 && themeScript < firstCss,
    path.relative(root, file) + " 必须在首个样式表之前读取主题偏好");
  const early = html.slice(0, firstCss);
  assert.match(early, /data-zp-theme/, path.relative(root, file) + " 必须在首屏绘制前设置主题");
}

const unified = fs.readFileSync(path.join(root, "css/ui-unified.css"), "utf8");
assert.match(unified, /:root\[data-zp-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light/);
// Uber 风格中性灰阶（浅色）：底色/文字/分割线均去蓝，仅 surface/danger 保留语义色。
for (const token of ["--zp-bg:#F2F2F2", "--zp-surface:#FFFFFF", "--zp-text:#141414", "--zp-line:#E0E0E0", "--zp-danger:#C2453A"]) {
  assert.ok(unified.includes(token), "浅色主题缺少基础 token: " + token);
}
for (const selector of [
  '.history-dialog-panel', '.dispatch-page', '.data-import-panel', '.account-page',
  '.bottom-nav', '.row', '.dialog', 'input'
]) {
  assert.ok(unified.includes(selector), "全局浅色适配未覆盖关键组件: " + selector);
}
// 危险操作按钮统一使用醒目的危险语义红（与页面背景明确区分），深浅主题仅切换对应标准配色。
// 深色 = --ui-danger-soft 红晕底 + var(--ui-danger)=#FF8278 字；浅色 = #FCEBEC 浅红底 + #B4232F 字。
assert.ok(
  unified.includes('button[class*="delete"]') &&
  unified.includes('background:var(--ui-danger-soft)!important;') &&
  unified.includes('color:var(--ui-danger)!important;') &&
  unified.includes('background:#FCEBEC!important;') &&
  unified.includes('border:1px solid #E8BFC3!important;'),
  "全站危险操作按钮必须使用统一的危险语义红，且与页面背景明确区分"
);
for (const selector of [".history-choice-delete", ".history-delete", ".data-swipe-actions .data-swipe-delete", ".page2-danger-btn"]) {
  assert.ok(unified.includes(selector), "全局危险操作按钮样式缺少覆盖: " + selector);
}
assert.ok(unified.includes('button[class*="delete"]:not(.account-collapse-head):active'), "危险操作按钮缺少按压状态");
assert.ok(unified.includes('button[class*="delete"]:not(.account-collapse-head):disabled'), "危险操作按钮缺少禁用状态");
// 折叠行组件（我的页「危险操作」展开头）不是动作按钮，必须被排除在实底红样式之外，保持与其它折叠行形状统一。
assert.ok(
  unified.includes('button[class*="danger"]:not(.account-collapse-head)') &&
  !/\bbutton\[class\*="danger"\](?!:not)/.test(unified.split("/* 全站删除/危险动作唯一标准")[1] || ""),
  "折叠行组件不得套用危险动作按钮实底样式"
);
console.log("主题首屏初始化与浅色基础对比度规则检查通过（" + themedPages.length + " 个页面）");
