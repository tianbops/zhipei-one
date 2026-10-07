/**
 * CSS 死代码扫描器（Commit 4A 引入）
 *
 * 为什么需要它：
 *   前面几轮审计是「手工 grep 已知的 3 个类名」，这种方式的致命问题是
 *   —— **你只能找到你已经知道的东西**。真正该回答的问题是：
 *   「全站 CSS 里，究竟有多少 class 从头到尾没有任何元素会用到？」
 *   这个数字不扫全量是拿不到的，而它直接决定了阶段 10 清理的范围和收益。
 *
 * 判定口径（保守优先）：
 *   一个 class 只有在 **HTML（含内联 <script>）或 js/*.js 里出现过** 才算「活」。
 *   CSS 自己引用自己（.a .b、.a:hover）不算活 —— 那只说明它还有样式，不说明它还有元素。
 *
 * 必须说清的三条局限（不能假装扫干净了）：
 *   1. **动态拼接的 class 名扫不到**：`el.className = "btn-" + type` 这种，静态全文检索看不到
 *      最终字符串。本工具对这类一律判「活」（宁可漏报不误删），不会把它列进死代码清单。
 *   2. **子串匹配会救活一批真正的死代码**：搜 `store-row` 会命中 `data-store-row`，
 *      于是 `.store-row` 被判活。这是**刻意**的保守行为 —— 删错活的样式是线上事故，
 *      漏删死代码只是清理不彻底，两者代价差一个量级。
 *   3. **attribute 选择器、JS 里的 classList.add("x") 常量**：能扫到（是明文字符串），
 *      但 JS 里经过变量传递再拼接的扫不到，同第 1 条。
 *
 * 用法: node css-deadcode-audit.cjs        （从仓库根目录跑，自动扫 css/ + pages/ + js/ + *.html）
 *   EXIT 恒为 0 —— 它是审计工具不是门禁。删除动作必须人工逐个核实后再做。
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const ROOT = process.cwd();
const CSS_DIR = path.join(ROOT, "css");

/**
 * 收集「可能渲染出元素」的源文件。
 * 范围刻意放宽到 .py —— 仓库的 e2e 脚本（tests/e2e-*.py）会用 CSS 选择器定位元素，
 * 某个 class 若在测试里被引用，说明它在真实页面上**是活的**，绝不能当死代码删掉。
 * 少扫一类文件就多一种「假装扫干净了」的方式，所以宁可范围大。
 *
 * 但必须排除 tests/tools/ —— 那是本工具及其同类的源码。踩过的坑：
 * 第一版把 tests/tools/*.cjs 也扫进「业务源码」，结果我在注释里写的举例
 * `.page2-row` 把真正的死代码 .page2-row 救活了 —— 工具自己的注释成了自己的输入。
 * 这类自污染不会报错，只会让清单静默变短，是最难发现的一种假阴性。
 */
const SRC_RE = /\.(html|js|mjs|cjs|py)$/;
const SELF_DIR = path.join(ROOT, "tests", "tools");
function collectSourceFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    if (dir === SELF_DIR) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "css") walk(p); continue; }
      if (SRC_RE.test(e.name)) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

const cssFiles = fs.existsSync(CSS_DIR)
  ? fs.readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).sort().map((f) => path.join(CSS_DIR, f))
  : [];

if (!cssFiles.length) { console.error("未找到 css/*.css —— 请在仓库根目录运行"); process.exit(2); }

/** 把所有 HTML/JS 拼成一个大文本做检索（够用且快） */
const srcFiles = collectSourceFiles();
const HAY = srcFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
/** CSS 自身文本：用于判断「是不是只有 CSS 自己在引用」 */
const CSS_HAY = cssFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

/** 哪些 class 名出现在 CSS 注释里 —— 注释里的类名是说明文字，不是引用 */
const commentNames = new Set();
{
  const cmtRe = /\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = cmtRe.exec(CSS_HAY))) {
    for (const w of m[0].matchAll(/\.([A-Za-z_][\w-]*)/g)) commentNames.add(w[1]);
  }
}

/** 从 CSS 里提取所有 class 名，并记录定义位置 */
const defs = new Map(); // name -> [{file, selector, decls}]
for (const f of cssFiles) {
  const root = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
  const walk = (node) => {
    if (node.type === "rule") {
      const sel = String(node.selector);
      const nDecls = node.nodes.filter((d) => d.type === "decl").length;
      for (const w of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
        const name = w[1];
        if (!defs.has(name)) defs.set(name, []);
        defs.get(name).push({
          file: path.basename(f), line: node.source?.start?.line ?? 0,
          selector: sel.replace(/\s+/g, " "), decls: nDecls,
        });
      }
    }
    node.each?.((c) => { if (c.type === "rule" || c.type === "atrule") walk(c); });
  };
  root.each(walk);
}

const pad = (s, n) => String(s).padEnd(n);
const results = { dead: [], weak: [] };

const namesIn = (sel) => [...sel.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);

for (const [name, where] of [...defs.entries()].sort()) {
  // 1) HTML/JS/PY 里出现过 → 活
  if (HAY.includes(name)) continue;
  // 2) 是否也在 CSS 注释里被提到 —— 这只是**提示**，不能据此分组。
  //    最初的写法把「注释里出现过」直接判成「只在注释里存在」，于是
  //    .page2-row（business-pages.css 里有 4 条真实定义，只是恰好被 ui-unified.css
  //    的注释举例提到）被踢出了死代码清单 —— 那是漏报，不是保守。
  const files = [...new Set(where.map((w) => w.file))].sort();
  const selectors = [...new Set(where.map((w) => w.selector))];
  results.dead.push({ name, files, selectors, inComment: commentNames.has(name), defs: where });
}

// 死 class 全集 —— 用于 T1/T2 分类
const deadSet = new Set(results.dead.map((d) => d.name));
/**
 * 分类（这决定了「能怎么删」）：
 *   T1 整条规则里**所有** class 都是死的        → 整条规则可以删掉
 *   T2 规则里混着活的 class（如 .a,.b 中只有 .a 死）→ 只能把 .a 这一个选择器名摘掉，规则体必须留着
 * 分错类的后果完全不同：把 T2 当 T1 整条删掉，等于把活元素的样式一起删了 —— 那是线上事故。
 */
for (const d of results.dead) {
  d.T1 = [];
  d.T2 = [];
  for (const w of d.defs) {
    const all = namesIn(w.selector);
    const allDead = all.length > 0 && all.every((n) => deadSet.has(n));
    (allDead ? d.T1 : d.T2).push(w);
  }
}

console.log("========== CSS 死代码扫描（Commit 4A） ==========");
console.log(`CSS 文件: ${cssFiles.length} 个   参与检索的 HTML/JS: ${srcFiles.length} 个`);
console.log(`提取到 class 名: ${defs.size} 个`);
console.log("");
const t1 = results.dead.filter((d) => d.T1.length && !d.T2.length);
const t2 = results.dead.filter((d) => !d.T1.length && d.T2.length);
const mix = results.dead.filter((d) => d.T1.length && d.T2.length);
console.log(`【A】HTML/JS/PY 零引用的 class：${results.dead.length} 个`);
console.log(`   T1 纯死规则（可整条删）: ${t1.length}    T2 混在活规则里（只摘选择器名）: ${t2.length}    两者兼有: ${mix.length}`);
console.log("-".repeat(110));
console.log(pad("class", 24) + pad("定级", 6) + pad("定义文件", 22) + "规则（T1 条数 / T2 条数）");
for (const d of [...t1, ...mix, ...t2]) {
  const lv = d.T1.length && !d.T2.length ? "T1" : (!d.T1.length && d.T2.length ? "T2" : "T1+T2");
  console.log(pad("." + d.name, 24) + pad(lv, 6) + pad(d.files.join(",").slice(0, 20), 22) +
    `T1:${d.T1.length}  T2:${d.T2.length}` + (d.inComment ? "  （CSS 注释中也提到）" : ""));
}

// T1 明细：给出 文件:行号 + 选择器，删除时按这个清单逐条定位
console.log("");
console.log("========== T1 明细（纯死规则，可整条删） ==========");
for (const d of results.dead) {
  if (!d.T1.length) continue;
  console.log(`\n.${d.name}  (${d.T1.length} 条)`);
  for (const w of d.T1) console.log(`   ${pad(w.file + ":" + w.line, 26)} ${w.selector.slice(0, 90)}`);
}
console.log("");
console.log("========== T2 明细（混在活规则里，只能摘选择器名） ==========");
for (const d of results.dead) {
  if (!d.T2.length) continue;
  console.log(`\n.${d.name}  (${d.T2.length} 条)`);
  for (const w of d.T2) console.log(`   ${pad(w.file + ":" + w.line, 26)} ${w.selector.slice(0, 90)}`);
}

console.log("");
console.log(`【B】CSS 中被注释举例提到、但确实有真实定义的 class：${results.dead.filter((d) => d.inComment).length} 个`);
console.log("-".repeat(110));
for (const d of results.dead.filter((d) => d.inComment)) console.log(pad("." + d.name, 26) + pad(d.files.join(","), 34) + d.selectors[0]);
if (!results.dead.some((d) => d.inComment)) console.log("  无");

console.log("");
console.log("========== 局限与免责 ==========");
console.log("  1. 动态拼接 class（`\"btn-\"+t`）静态扫不到，一律判活，不会出现在上面的清单里；");
console.log("  2. 子串匹配会救活真死代码（如 `.store-row` 被 `data-store-row` 救活）—— 刻意保守；");
console.log("  3. 因此本清单是**零引用的下界**，不是全部。删除前仍需逐个 grep 人工核实。");
