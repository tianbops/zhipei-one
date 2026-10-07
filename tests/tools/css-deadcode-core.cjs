/**
 * 死代码判定核心（Commit 4A）—— css-deadcode-audit / css-deadcode-prune 共用的单一真相源。
 *
 * 为什么要抽成单独模块：
 *   「哪些 class 是死的」和「按什么粒度删」如果写成两份，迟早漂移 ——
 *   audit 说死的、prune 删的却是另一套，这类不一致不会报错，只会静默删错或漏删。
 *   判定逻辑只此一份，报告与删除都从这里取。
 *
 * 【关键正确性】删除粒度是「逗号并列项」，不是「class 名」。
 *   CSS 选择器里逗号是 OR、空格是 AND：
 *     .a, .b            → 匹配 .a 或 .b，两者互不相干，可以只删其中一个
 *     .a .b             → 祖先 .a 且后代 .b，.a 不存在则**整项永不匹配**
 *   所以「从 .a .b 里把 .a 摘掉留下 .b」是错的 —— 那等于凭空造出一条
 *   会命中所有 .b 的新规则（.b 本来只在 .a 下才有样式），是新增影响面而不是删代码。
 *   正确做法：只要并列项内含任一死 class，就把**整个并列项**删掉。
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

/** 参与「是否有元素会用到」检索的源码范围（含 .py：e2e 脚本会引用 class 作选择器） */
const SRC_RE = /\.(html|js|mjs|cjs|py)$/;

function collectSourceFiles(root) {
  const out = [];
  const selfDir = path.join(root, "tests", "tools");
  const walk = (dir) => {
    if (!fs.existsSync(dir) || dir === selfDir) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "css") walk(p); continue; }
      if (SRC_RE.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {string} root 仓库根目录
 * @returns {{cssFiles:string[], srcFiles:string[], defs:Map, dead:Array, hay:string}}
 */
function analyze(root) {
  const CSS_DIR = path.join(root, "css");
  const cssFiles = fs.existsSync(CSS_DIR)
    ? fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort().map((f) => path.join(CSS_DIR, f))
    : [];
  if (!cssFiles.length) throw new Error("未找到 css/*.css —— 请在仓库根目录运行");

  const srcFiles = collectSourceFiles(root);
  const hay = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

  const defs = new Map();
  const rules = []; // {file, line, selector, node}
  for (const f of cssFiles) {
    const root2 = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
    const walk = (node) => {
      if (node.type === "rule") {
        const sel = String(node.selector);
        const rec = { file: path.basename(f), line: node.source?.start?.line ?? 0, selector: sel, node };
        rules.push(rec);
        for (const w of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
          const n = w[1];
          if (!defs.has(n)) defs.set(n, []);
          defs.get(n).push(rec);
        }
      }
      node.each?.((c) => { if (c.type === "rule" || c.type === "atrule") walk(c); });
    };
    root2.each(walk);
  }

  // 死 class：HTML/JS/PY 里一次都没出现过
  const dead = [];
  for (const [name, where] of [...defs.entries()].sort()) {
    if (hay.includes(name)) continue;
    dead.push({ name, defs: where });
  }
  const deadSet = new Set(dead.map((d) => d.name));

  /**
   * 把每条规则拆成并列项，逐项判定。
   * 返回 { pruneAll, keepParts, dropParts }
   */
  /**
   * 按顶层逗号切分，但**保留每段的原始前导分隔符**（`,` 及其空白）。
   * 这样切除某段时直接把它的 raw 换成空串即可，其余字符一个字节都不动 ——
   * 压缩文件里 `.a,.b,.c` 删掉 .b 得到 `.a,.c`，不会无端多出空格。
   */
  const splitTop = (sel) => {
    const raws = [];
    let buf = "";
    let depth = 0;
    for (const ch of sel) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { raws.push(buf); buf = ","; continue; }
      buf += ch;
    }
    raws.push(buf);
    return raws
      .map((raw) => ({ raw, text: raw.replace(/^[\s,]*/, "").replace(/\s+$/, "") }))
      .filter((p) => p.text);
  };

  const plan = [];
  for (const r of rules) {
    const parts = splitTop(r.selector);
    const drop = [], keep = [];
    for (const p of parts) {
      const names = [...p.text.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
      (names.some((n) => deadSet.has(n)) ? drop : keep).push(p);
    }
    if (drop.length) {
      // 重建选择器：保留段的 raw 原样拼接，再去掉开头残留的逗号/空白
      const next = keep.map((p) => p.raw).join("").replace(/^[\s,]+/, "").replace(/\s+$/, "");
      plan.push({ ...r, drop, keep, pruneAll: keep.length === 0, nextSelector: next });
    }
  }

  return { cssFiles, srcFiles, defs, dead, deadSet, plan, rules, hay };
}

module.exports = { analyze, loadPostcss, postcss };
