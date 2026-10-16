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
for (const token of ["--zp-bg:#F4F6F8", "--zp-surface:#FFFFFF", "--zp-text:#17202A", "--zp-line:#D7DDE3"]) {
  assert.ok(unified.includes(token), "浅色主题缺少基础 token: " + token);
}
for (const selector of [
  '.history-list', '.dispatch-page', '.data-import-panel', '.account-page',
  '.bottom-nav', '.row', '.dialog', 'input'
]) {
  assert.ok(unified.includes(selector), "全局浅色适配未覆盖关键组件: " + selector);
}
console.log("主题首屏初始化与浅色基础对比度规则检查通过（" + themedPages.length + " 个页面）");
