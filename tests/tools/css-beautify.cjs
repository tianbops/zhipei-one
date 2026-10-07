/**
 * CSS 可读化格式化器（Commit 2A 专用，一次性工具）
 *
 * 背景：css/app.css 是 minified 单行文件（9 行 10KB，第 2 行长 5383 字符），
 *       内含 129 条规则 + 4 个 @media，覆盖登录/上传/详情/数据/线路/门店等页面样式。
 *       这种形态无法阅读、无法 review、误删无法察觉。
 *
 * 做法：不是手工重写，而是「AST 解析 → 规范化序列化」。
 *       输出的每一个字符都由 AST 节点驱动，因此不可能引入或丢失规则。
 *       完成后由 tests/tools/css-fingerprint.cjs 做独立的 AST 指纹比对，证明零语义变更。
 *
 * 用法：node tests/tools/css-beautify.cjs <file> [--out=path]
 */

const fs = require("fs");

const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const INDENT = "  ";

function trimStr(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function serialize(node, depth) {
  const lines = [];
  const pad = INDENT.repeat(depth);

  if (node.type === "atrule") {
    if (node.nodes && node.nodes.length) {
      // 带块体的 at-rule（@media / @supports / @keyframes）
      lines.push(`${pad}@${node.name} ${trimStr(node.params)} {`);
      let prevWasBlock = false;
      node.each((child) => {
        const isBlock = child.type === "rule" || (child.type === "atrule" && child.nodes);
        if (prevWasBlock && isBlock) lines.push(""); // 块之间留空行提升可读性
        lines.push(...serialize(child, depth + 1));
        prevWasBlock = isBlock;
      });
      lines.push(`${pad}}`);
    } else {
      // 无块体（@charset / @import）
      lines.push(`${pad}@${node.name}${node.params ? " " + trimStr(node.params) : ""};`);
    }
    return lines;
  }

  if (node.type === "rule") {
    lines.push(`${pad}${trimStr(node.selector)} {`);
    node.each((child) => {
      if (child.type === "decl") {
        lines.push(`${pad}${INDENT}${child.prop}: ${trimStr(child.value)}${child.important ? " !important" : ""};`);
      } else {
        lines.push(...serialize(child, depth + 1));
      }
    });
    lines.push(`${pad}}`);
    return lines;
  }

  if (node.type === "comment") {
    const text = node.text.trim();
    // 整段块注释保持多行可读
    if (text.includes("\n")) {
      lines.push(`${pad}/*`);
      text.split("\n").forEach((l) => lines.push(`${pad}  ${l.trim()}`));
      lines.push(`${pad} */`);
    } else {
      lines.push(`${pad}/* ${text} */`);
    }
    return lines;
  }

  return lines;
}

const file = process.argv[2];
const outArg = process.argv.find((a) => a.startsWith("--out="));
const target = outArg ? outArg.slice(6) : file;

if (!file) {
  console.error("用法: node css-beautify.cjs <file> [--out=path]");
  process.exit(2);
}

const before = fs.statSync(file).size;
const css = fs.readFileSync(file, "utf8");
const root = postcss.parse(css, { from: file });

const lines = [];
let prevWasBlock = false;
root.each((node) => {
  const isBlock = node.type === "rule" || (node.type === "atrule" && node.nodes);
  if (node.type === "atrule" && !node.nodes) isBlock = false;
  if (prevWasBlock) lines.push("");
  lines.push(...serialize(node, 0));
  prevWasBlock = isBlock;
});

// 顶层裸声明（不应存在；若有，显式透出以免静默丢失）
root.each((node) => {
  if (node.type === "decl") {
    console.warn("[警告] 发现顶层裸声明，已透出:", node.prop);
    lines.push(`${node.prop}: ${trimStr(node.value)}${node.important ? " !important" : ""};`);
  }
});

fs.writeFileSync(target, lines.join("\n") + "\n");
const after = fs.statSync(target).size;

console.log(`格式化 ${file}`);
console.log(`  行数: ${css.split("\n").length} -> ${lines.length + 1}`);
console.log(`  字节: ${before} -> ${after}`);
console.log(`  输出: ${target}`);
