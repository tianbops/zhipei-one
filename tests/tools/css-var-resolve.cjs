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

/**
 * 已登记的变量语义变更 —— 有意为之，不是漂移。
 * 每登记一条都要写清「为什么变、影响面、怎么确认视觉没坏」；
 * 否则这个工具会退化成「谁都不敢改」的拦路石。
 * 未登记的差异仍然 EXIT=1。
 */
const ACCEPTED_REMOVALS = {
  "--zp-card-translucent":
    "2026-11-04 全局取消半透明：容器底收敛到实色 --zp-card（=--zp-surface），避免正文透出弹窗。",
  "--zp-card-translucent-2":
    "同日同上：收敛到 --zp-card-2（=--zp-surface-2）。",
};
const ACCEPTED_CHANGES = {
  // 2026-11-04 外观改版（Uber 实测色板）：深色由 slate 族换为中性黑，浅色翻为白底灰块。
  // 深色底色与块取 Uber App 截图的像素实测值（#161616 / #292929）：纯黑 #000000
  // 已在真机复现 OLED 拖影，故上移一档。其余层级按同一亮度步进外推。
  // 本表由 `node tests/tools/css-var-resolve.cjs` 的差异输出聚合生成，逐条登记
  // from（基线值）→ values（现值）：只接受「从这些旧值恰好变成这些新值」。
  // 再漂移一档（比如有人把 --zp-bg 改成 #0A0A0A）照样 EXIT=1 —— 登记不等于豁免。
  // 2026-11-04 主按钮合规：白字压主色由 4.10(浅)/3.68(深) 提到 5.37/4.91，
  // 三态（base/hover/active）全部 ≥4.5。浅色同步调整但未被本工具采样到（它只比对
  // 深色覆盖值），故 from/values 同时列出两套主题的值。
  "--bg": { from: ["#000000"], values: ["#161616"], why: "旧别名跟随对应 --zp-* 令牌变化（仅兼容保留，组件层零引用）" },
  "--card": { from: ["#1D1D1D"], values: ["#292929"], why: "旧别名跟随对应 --zp-* 令牌变化（仅兼容保留，组件层零引用）" },
  "--card2": { from: ["#282828"], values: ["#363636"], why: "旧别名跟随对应 --zp-* 令牌变化（仅兼容保留，组件层零引用）" },
  "--line": { from: ["#2B2B2B"], values: ["#3D3D3D"], why: "旧别名跟随对应 --zp-* 令牌变化（仅兼容保留，组件层零引用）" },
  "--panel": { from: ["#232323"], values: ["#303030"], why: "旧别名跟随对应 --zp-* 令牌变化（仅兼容保留，组件层零引用）" },
  "--zp-accent": { from: ["#0958D9", "#93C5FD"], values: ["#6EA8FE"], why: "深色强调色由天蓝 212° 改为 216°，与主色同支、只是提亮" },
  "--zp-bg": { from: ["#000000"], values: ["#161616"], why: "深色底由纯黑 #000000 上移到 Uber 实测 #161616：纯黑在 OLED 上有滚动拖影" },
  "--zp-block": { from: ["#1D1D1D"], values: ["#292929"], why: "内容块令牌：深色取 Uber 实测 #292929" },
  "--zp-card": { from: ["#1D1D1D"], values: ["#292929"], why: "内容块令牌：深色取 Uber 实测 #292929" },
  "--zp-card-2": { from: ["#282828"], values: ["#363636"], why: "内容块令牌：深色取 Uber 实测 #292929" },
  "--zp-disabled-bg": { from: ["#282828"], values: ["#363636"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
  "--zp-input-bg": { from: ["#1D1D1D"], values: ["#292929"], why: "输入框组随表面色阶外推（禁用态压暗、保留描边）" },
  "--zp-input-bg-disabled": { from: ["#191919"], values: ["#212121"], why: "输入框组随表面色阶外推（禁用态压暗、保留描边）" },
  "--zp-input-focus": { from: ["#1677FF", "#60A5FA"], values: ["#6EA8FE"], why: "聚焦描边跟随强调色" },
  "--zp-input-line": { from: ["#2B2B2B"], values: ["#3D3D3D"], why: "输入框组随表面色阶外推（禁用态压暗、保留描边）" },
  "--zp-input-line-disabled": { from: ["#202020"], values: ["#2B2B2B"], why: "输入框组随表面色阶外推（禁用态压暗、保留描边）" },
  "--zp-line": { from: ["#2B2B2B"], values: ["#3D3D3D"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
  "--zp-line-inset": { from: ["#252525"], values: ["#323232"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
  "--zp-nav-bg": { from: ["#1D1D1D"], values: ["#292929"], why: "底栏浮岛化：浮岛取块色，靠亮度差与描边从底色中浮起" },
  "--zp-primary": { from: ["#0F62E6", "#1677FF", "#2A6BE0", "#3B82F6"], values: ["#2C6CE2"], why: "两套主题统一为同一支蓝：白字 4.83、深底 3.75、卡片 3.01，四种落点全过线" },
  "--zp-primary-active": { from: ["#0958D9", "#1E56B8", "#2563EB"], values: ["#0B52BC"], why: "active 与浅色同值" },
  "--zp-primary-hover": { from: ["#2F6FE8", "#4096FF", "#60A5FA"], values: ["#1A6FEB"], why: "hover 与浅色同值，切换主题不变蓝" },
  "--zp-secondary-active": { from: ["#383838"], values: ["#444444"], why: "次按钮组随表面色阶外推" },
  "--zp-secondary-bg": { from: ["#282828"], values: ["#363636"], why: "次按钮组随表面色阶外推" },
  "--zp-secondary-border": { from: ["#3D3D3D"], values: ["#4A4A4A"], why: "次按钮组随表面色阶外推" },
  "--zp-secondary-hover": { from: ["#2C2C2C"], values: ["#3E3E3E"], why: "次按钮组随表面色阶外推" },
  "--zp-sk-a": { from: ["#232323"], values: ["#2F2F2F"], why: "骨架微光条随表面色阶外推" },
  "--zp-sk-b": { from: ["#282828"], values: ["#363636"], why: "骨架微光条随表面色阶外推" },
  "--zp-surface": { from: ["#232323"], values: ["#303030"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
  "--zp-surface-2": { from: ["#282828"], values: ["#363636"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
  "--zp-surface-3": { from: ["#383838"], values: ["#414141"], why: "Uber 中性色阶：深色由 slate 族换为实测中性黑" },
};

let totalDiff = 0;
let acceptedHits = 0;
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
    if (a === undefined && b !== undefined) {
      if (ACCEPTED_REMOVALS[n]) { acceptedHits++; continue; }
      removedVars.add(n);
      continue;
    }
    if (b !== a) {
      const acc = ACCEPTED_CHANGES[n];
      // 双向登记：after 必须落在 values，且 before 必须落在 from。
      // 只写 values 时退化为单向放行（兼容尚未补 from 的旧条目）。
      if (acc && acc.values.includes(a) && (!acc.from || acc.from.includes(b))) { acceptedHits++; continue; }
      diffs.push(`    ${n}\n      BEFORE: ${b}\n      AFTER : ${a}`);
    }
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
if (acceptedHits) console.log(`已登记变更：${acceptedHits} 处（见 ACCEPTED_* 常量，需人工确认仍成立）`);

const ok = totalDiff === 0 && removedVars.size === 0;
console.log(ok ? "\n=== 变量解析完全等价 EXIT=0 ===" : "\n=== 存在不一致 EXIT=1 ===");
process.exit(ok ? 0 : 1);
