/**
 * 死代码切除器（Commit 4A）—— 按 css-deadcode-core 的 plan 实际改 CSS 文件。
 *
 * 默认 **dry-run**：只打印将要发生的改动，不落盘。
 * 必须显式 `--apply` 才写文件。理由：这是全仓 CSS 的批量删除，
 * 不给 dry-run 的工具等于逼着人靠「应该没问题」去冒险。
 *
 * 用法: node css-deadcode-prune.cjs [--apply]
 *   EXIT 0 = 正常；2 = 用法错误
 */

const fs = require("fs");
const path = require("path");
const { analyze } = require("./css-deadcode-core.cjs");

const APPLY = process.argv.includes("--apply");
const root = process.cwd();

const { cssFiles, srcFiles, dead, plan } = analyze(root);

console.log("========== CSS 死代码切除" + (APPLY ? "（写入模式）" : "（DRY-RUN，不写文件）") + " ==========");
console.log(`CSS ${cssFiles.length} 个 / 检索源码 ${srcFiles.length} 个 / 死 class ${dead.length} 个`);
console.log(`涉及规则 ${plan.length} 条：整条删除 ${plan.filter((p) => p.pruneAll).length} 条，删部分并列项 ${plan.filter((p) => !p.pruneAll).length} 条`);
console.log("");

// 按文件分组执行
const byFile = new Map();
for (const p of plan) {
  if (!byFile.has(p.file)) byFile.set(p.file, []);
  byFile.get(p.file).push(p);
}

let removedRules = 0, trimmedRules = 0;
for (const [file, items] of byFile) {
  console.log(`--- css/${file}  (${items.length} 处) ---`);
  const abs = path.join(root, "css", file);
  const before = fs.readFileSync(abs, "utf8");
  const { postcss } = require("./css-deadcode-core.cjs");
  const tree = postcss.parse(before, { from: abs });

  // 用 selector 原文 + 行号定位节点（plan 里的 node 引用来自另一次 parse，需重新匹配）
  const targets = new Map();
  const walk = (node) => {
    if (node.type === "rule") {
      const key = `${node.source?.start?.line}:${String(node.selector).replace(/\s+/g, " ")}`;
      targets.set(key, node);
    }
    node.each?.((c) => { if (c.type === "rule" || c.type === "atrule") walk(c); });
  };
  tree.each(walk);

  for (const it of items) {
    const key = `${it.line}:${it.selector.replace(/\s+/g, " ")}`;
    const node = targets.get(key);
    if (!node) {
      console.log(`   !! 找不到节点，跳过: ${it.line}: ${it.selector.slice(0, 70)}`);
      continue;
    }
    if (it.pruneAll) {
      console.log(`   删整条  L${it.line}  ${it.selector.replace(/\s+/g, " ").slice(0, 88)}`);
      node.remove();
      removedRules++;
    } else {
      console.log(`   删并列项 L${it.line}  - ${it.drop.map((d) => d.text).join(" , ")}`);
      console.log(`     保留    → ${it.nextSelector.replace(/\s+/g, " ").slice(0, 84)}`);
      node.selector = it.nextSelector;
      trimmedRules++;
    }
  }

  const after = tree.toString();
  if (APPLY && after !== before) {
    fs.writeFileSync(abs, after);
    console.log(`   → 已写入（${before.length} → ${after.length} 字节）`);
  }
  console.log("");
}

console.log(`合计：整条删除 ${removedRules} 条，删并列项 ${trimmedRules} 条`);
if (!APPLY) console.log("（DRY-RUN：未写入任何文件。确认无误后加 --apply 重跑）");
