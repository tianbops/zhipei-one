/**
 * CSS 变量解析等价性验证器（Commit 2A 专用）
 *
 * 为什么需要它：
 *   AST 指纹只能证明「规则文本没变」，但本次改动把变量定义换成了 var() 别名。
 *   浏览器的行为是在运行时求值的，因此必须证明「每个页面最终解析出的具体颜色」不变，
 *   才算真的没有视觉漂移。指纹工具管不了这一层。
 *
 * 做法：模拟浏览器的级联与求值 ——
 *   1. 解析每个页面 HTML 的 <link> 顺序，得到该页加载的 CSS 序列；
 *   2. 按序收集所有 :root 内的自定义属性（后加载覆盖先加载，模拟层叠）；
 *   3. 递归求值 var()，把每个变量解析到最终的落值（色值/长度等）；
 *   4. 对「改动前 / 改动后」两套 CSS 目录分别求解，逐项比对。
 *
 * 用法：
 *   node tests/tools/css-var-resolve.cjs <beforeDir> <afterDir> <repoForHtml>
 *   EXIT=0 表示所有页面所有变量的解析值完全一致。
 */

const fs = require("fs");
const path = require("path");

const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

/**
 * 无参自检模式（Commit 3A 补）：
 *   Commit 2A 把本工具挂成了 npm run verify:css-vars，但没带 <beforeDir> <afterDir>，
 *   结果这个脚本从挂上去那天起就永远 EXIT=2 —— 一个跑不动的检查比没有检查更危险，
 *   它让「我们有变量等价验证」这句话变成假的。
 *   现在不传参数时自动用 git HEAD 版本的 css/ 作基线，与工作区比对，
 *   于是任何时候（包括 CI）都能直接跑：验证「本次改动有没有造成变量解析漂移」。
 */
function baselineFromGit(repo) {
  const os = require("os");
  const { execFileSync } = require("child_process");
  const files = fs.readdirSync(path.join(repo, "css")).filter((f) => f.endsWith(".css"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cssbase-"));
  fs.mkdirSync(path.join(tmp, "css"), { recursive: true });
  let n = 0;
  for (const f of files) {
    let content;
    try {
      content = execFileSync("git", ["show", `HEAD:css/${f}`], { cwd: repo, encoding: "utf8" });
    } catch {
      continue; // HEAD 里不存在的文件（本次新增）无从比对，跳过即可
    }
    fs.writeFileSync(path.join(tmp, "css", f), content);
    n++;
  }
  console.log(`自检模式：以 git HEAD 的 css/ 为基线（${n} 个文件），工作区为改动后`);
  return tmp;
}

let [beforeDir, afterDir, htmlRepo] = process.argv.slice(2);
if (!beforeDir && !afterDir && !htmlRepo) {
  const repo = process.cwd();
  beforeDir = baselineFromGit(repo);
  afterDir = repo;
  htmlRepo = repo;
}
if (!beforeDir || !afterDir || !htmlRepo) {
  console.error("用法: node css-var-resolve.cjs [beforeDir] [afterDir] [htmlRepo]");
  console.error("      不带参数 = 以 git HEAD 的 css/ 为基线自检");
  process.exit(2);
}

/** 从 HTML 提取按顺序加载的本地 CSS 路径 */
function cssLinksOf(htmlFile) {
  const html = fs.readFileSync(htmlFile, "utf8");
  const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]);
  return hrefs
    .map((h) => h.split("?")[0])          // 去掉 ?v=dark1 之类的缓存戳
    .filter((h) => h.startsWith("/css/"))
    .map((h) => h.replace(/^\//, ""));     // -> css/xxx.css
}

/** 收集一个 CSS 文件里 :root 的变量定义（原始值，可能含 var()） */
function collectVars(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
  const walk = (node) => {
    if (node.type === "rule" && node.selector.includes(":root")) {
      node.each((d) => {
        if (d.type === "decl" && d.prop.startsWith("--")) {
          out.set(d.prop, String(d.value).trim());
        }
      });
      return;
    }
    node.each?.((c) => {
      if (c.type === "rule" || c.type === "atrule") walk(c);
    });
  };
  root.each((n) => walk(n));
  return out;
}

/** 按页面 CSS 序列合并变量（后覆盖先），然后递归求值 */
function resolvePage(linkNames, baseDir, varCache) {
  const raw = new Map();
  for (const rel of linkNames) {
    const key = rel + "@" + baseDir;
    let m = varCache.get(key);
    if (!m) {
      m = collectVars(path.join(baseDir, rel));
      varCache.set(key, m);
    }
    for (const [k, v] of m) raw.set(k, v);   // 后加载覆盖先加载
  }

  // 递归求值，maxDepth 防环
  const value = (name, depth = 0) => {
    if (depth > 12) return "<<递归过深>>";
    const v = raw.get(name);
    if (v === undefined) return undefined;
    // 替换其中的 var(--x) / var(--x, fallback)
    return v.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,([^)]*))?\)/g, (whole, ref, fallback) => {
      const got = value(ref, depth + 1);
      if (got !== undefined) return got;
      return fallback !== undefined ? fallback.trim() : whole;  // 未定义则用 fallback，否则保留原式
    });
  };

  const final = new Map();
  for (const name of raw.keys()) final.set(name, value(name));
  return final;
}

const varCache = new Map();
const htmlFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".git", "tools", "tests"].includes(e.name)) walk(p);
    } else if (e.name.endsWith(".html")) htmlFiles.push(p);
  }
})(htmlRepo);

console.log(`比对目录：before=${beforeDir}  after=${afterDir}`);
console.log(`页面数：${htmlFiles.length}\n`);

let totalDiff = 0;
const newVars = new Set();
const removedVars = new Set();

for (const htmlFile of htmlFiles.sort()) {
  const links = cssLinksOf(htmlFile);
  if (!links.length) continue;
  const rel = path.relative(htmlRepo, htmlFile);
  const before = resolvePage(links, beforeDir, varCache);
  const after = resolvePage(links, afterDir, varCache);

  const names = new Set([...before.keys(), ...after.keys()]);
  const diffs = [];
  for (const n of names) {
    const b = before.get(n);
    const a = after.get(n);
    if (b === undefined && a !== undefined) { newVars.add(n); continue; }
    if (a === undefined && b !== undefined) { removedVars.add(n); continue; }
    if (b !== a) diffs.push(`    ${n}\n      BEFORE: ${b}\n      AFTER : ${a}`);
  }
  if (diffs.length) {
    console.log(`[差异] ${rel}  (${diffs.length} 处)`);
    console.log(diffs.join("\n"));
    totalDiff += diffs.length;
  } else {
    console.log(`[一致] ${rel}  变量 ${names.size} 个，加载 CSS ${links.length} 个`);
  }
}

console.log("\n========== 汇总 ==========");
console.log(`解析值发生变化：${totalDiff} 处`);
if (newVars.size) console.log(`新增变量（应当是对外可用的新口径）：${[...newVars].join(", ")}`);
if (removedVars.size) console.log(`⚠️ 消失的变量（危险）：${[...removedVars].join(", ")}`);

const ok = totalDiff === 0 && removedVars.size === 0;
console.log(ok ? "\n=== 变量解析完全等价 EXIT=0 ===" : "\n=== 存在不一致 EXIT=1 ===");
process.exit(ok ? 0 : 1);
