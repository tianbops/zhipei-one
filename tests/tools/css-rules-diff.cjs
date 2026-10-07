/**
 * 非 :root 规则比对器（Commit 2A 专用）
 *
 * 背景：在 :root 里新增变量行之后，逐行指纹比对会因为行号整体推移而报出大量「假差异」。
 *       （ui-unified.css 一度报 562 处，实际是错位，不是语义变化。）
 *
 * 本工具只比对「除 :root 之外的全部规则」，即真正的样式规则集合。
 * 用法: node tests/tools/css-rules-diff.cjs <fileA> <fileB>
 * EXIT=0 表示非 :root 部分完全一致。
 */

const fs = require("fs");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function lines(node, depth = 0) {
  const out = [];
  const pad = "  ".repeat(depth);
  const emit = (n, d) => {
    if (n.type === "atrule") {
      if (n.nodes && n.nodes.length) {
        out.push(`${pad}@${n.name} ${norm(n.params)} {`);
        n.each((c) => emit(c, d + 1));
        out.push(`${pad}}`);
      } else {
        out.push(`${pad}@${n.name} ${n.params ? " " + norm(n.params) : ""};`);
      }
    } else if (n.type === "rule") {
      out.push(`${pad}SEL ${norm(n.selector)} {`);
      n.each((c) => {
        if (c.type === "decl") out.push(`${pad}  ${c.prop}:${norm(c.value)}${c.important ? "!i" : ""}`);
        else emit(c, d + 1);
      });
      out.push(`${pad}}`);
    }
  };
  emit(node, depth);
  return out;
}

function nonRootRules(file) {
  const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
  const out = [];
  root.each((node) => {
    const isRootSelector =
      (node.type === "rule" && node.selector.includes(":root")) ||
      (node.type === "atrule" && node.name === "keyframes");
    if (isRootSelector) return;      // 跳过 :root 与 @keyframes 同名干扰
    out.push(...lines(node, 0));
  });
  return out;
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) {
  console.error("用法: node css-rules-diff.cjs <fileA> <fileB>");
  process.exit(2);
}

const a = nonRootRules(fa);
const b = nonRootRules(fb);

if (a.length !== b.length) {
  console.log(`⚠️ 行数不同：A=${a.length}  B=${b.length}`);
}
const max = Math.max(a.length, b.length);
const diffs = [];
for (let i = 0; i < max; i++) {
  if (a[i] !== b[i]) diffs.push(`  行${i + 1}\n    A: ${a[i] ?? "(无)"}\n    B: ${b[i] ?? "(无)"}`);
}

console.log(`${fa}  ->  ${fb}`);
console.log(`非 :root 规则指纹行数：A=${a.length}  B=${b.length}`);
if (diffs.length) {
  console.log(`\n[差异] ${diffs.length} 处：`);
  console.log(diffs.slice(0, 30).join("\n"));
  if (diffs.length > 30) console.log(`  ...（另有 ${diffs.length - 30} 处省略）`);
  console.log("\n=== 存在差异 EXIT=1 ===");
  process.exit(1);
}
console.log("\n=== 非 :root 规则完全一致 EXIT=0 ===");
process.exit(0);
