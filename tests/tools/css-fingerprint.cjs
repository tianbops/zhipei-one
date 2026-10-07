/**
 * CSS 等价性验证基线工具（Commit 2A 专用）
 *
 * 用途：在改动 CSS 之前/之后各生成一份「规范化指纹」，逐项比对，确保纯格式化与 Token 别名化
 *       没有改变任何实际的层叠计算结果。
 *
 * 为什么需要它：css/app.css 是 minified 单行（9 行 10KB），肉眼无法 review。
 *       任何手工整理都可能在无意识中增删规则。指纹比对是唯一可靠的防线。
 *
 * 比对维度：
 *   1. rule 序列（不含空白差异）
 *   2. 每个 rule 的 selector
 *   3. 每条 declaration 的 prop / value / important（顺序敏感）
 *   4. at-rule（@media / @keyframes 等）结构与嵌套内容
 *
 * 用法：
 *   node tests/tools/css-fingerprint.cjs <baseline|check> [files...]
 *   - baseline：写出指纹到 /tmp/css-fp/
 *   - check   ：与基线比对，输出差异；有差异则 EXIT=1
 */

const fs = require("fs");
const path = require("path");

const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const REPO = process.argv[2] === "--repo" ? process.argv[3] : process.cwd();
const OUT_DIR = "/tmp/css-fp";

/** 把值里的空白压缩、去掉尾部分号 —— 用于消除纯排版差异，但保留语义 */
function norm(str) {
  return String(str ?? "").replace(/\s+/g, " ").trim();
}

/** 递归生成 AST 指纹 */
function fingerprint(node, depth = 0) {
  const lines = [];
  const pad = "  ".repeat(depth);

  if (node.type === "atrule") {
    lines.push(`${pad}@${node.name} ${norm(node.params)} {`);
    node.each?.((child) => {
      if (child.type === "decl") {
        lines.push(`${pad}  ${child.prop}:${norm(child.value)}${child.important ? "!i" : ""}`);
      } else {
        lines.push(...fingerprint(child, depth + 1));
      }
    });
    lines.push(`${pad}}`);
    return lines;
  }

  if (node.type === "rule") {
    lines.push(`${pad}SEL ${norm(node.selector)} {`);
    node.each?.((child) => {
      if (child.type === "decl") {
        lines.push(`${pad}  ${child.prop}:${norm(child.value)}${child.important ? "!i" : ""}`);
      } else {
        lines.push(...fingerprint(child, depth + 1));
      }
    });
    lines.push(`${pad}}`);
    return lines;
  }

  return lines;
}

function build(file) {
  const css = fs.readFileSync(file, "utf8");
  const root = postcss.parse(css, { from: file });
  const lines = [];
  root.each?.((node) => {
    if (node.type === "decl") {
      // 顶层裸声明（理论上不该有，若有须显式暴露）
      lines.push(`TOPDECL ${node.prop}:${norm(node.value)}${node.important ? "!i" : ""}`);
    } else {
      lines.push(...fingerprint(node, 0));
    }
  });
  return lines.join("\n");
}

const mode = process.argv[2];
// argv = [node, script, mode, ...files]，因此文件列表从 index 3 开始
const files = process.argv.slice(3).filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("用法: node css-fingerprint.cjs <baseline|check> <file...>");
  process.exit(2);
}

// compare 模式：直接比对两个文件的 AST 指纹，不依赖缓存基线
// 用法: node css-fingerprint.cjs compare <fileA> <fileB>
if (mode === "compare") {
  if (files.length < 2) {
    console.error("用法: node css-fingerprint.cjs compare <fileA> <fileB>");
    process.exit(2);
  }
  const [fa, fb] = files;
  const a = build(fa).split("\n");
  const b = build(fb).split("\n");
  const max = Math.max(a.length, b.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) diffs.push(`  行${i + 1}\n    A: ${a[i] ?? "(无)"}\n    B: ${b[i] ?? "(无)"}`);
  }
  console.log(`A = ${fa}  (${a.length} 行)`);
  console.log(`B = ${fb}  (${b.length} 行)`);
  if (diffs.length) {
    console.log(`\n[差异] 共 ${diffs.length} 处：`);
    console.log(diffs.slice(0, 50).join("\n"));
    if (diffs.length > 50) console.log(`  ...（另有 ${diffs.length - 50} 处省略）`);
    console.log("\n=== 存在差异 EXIT=1 ===");
    process.exit(1);
  }
  console.log("\n=== AST 完全一致（0 差异）EXIT=0 ===");
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

if (mode === "baseline") {
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    const fp = build(abs);
    const out = path.join(OUT_DIR, rel.replace(/[\/\\]/g, "__") + ".fp");
    fs.writeFileSync(out, fp);
    console.log(`[BASELINE] ${rel}  ${fp.split("\n").length} 行指纹`);
  }
  console.log(`\n基线已写入 ${OUT_DIR}`);
  process.exit(0);
}

// check 模式
let diff = false;
for (const rel of files) {
  const abs = path.join(REPO, rel);
  const fp = build(abs);
  const out = path.join(OUT_DIR, rel.replace(/[\/\\]/g, "__") + ".fp");
  if (!fs.existsSync(out)) {
    console.log(`[缺失基线] ${rel} —— 请先运行 baseline`);
    diff = true;
    continue;
  }
  const oldFp = fs.readFileSync(out, "utf8");
  const a = oldFp.split("\n");
  const b = fp.split("\n");
  const max = Math.max(a.length, b.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      diffs.push(`  行${i + 1}\n    - ${a[i] ?? "(无)"}\n    + ${b[i] ?? "(无)"}`);
    }
  }
  if (diffs.length) {
    console.log(`\n[差异] ${rel}  共 ${diffs.length} 处`);
    console.log(diffs.slice(0, 40).join("\n"));
    if (diffs.length > 40) console.log(`  ...（另有 ${diffs.length - 40} 处省略）`);
    diff = true;
  } else {
    console.log(`[一致] ${rel}  ${b.length} 行指纹，0 差异`);
  }
}

console.log(diff ? "\n=== 存在差异 EXIT=1 ===" : "\n=== 全部一致 EXIT=0 ===");
process.exit(diff ? 1 : 0);
