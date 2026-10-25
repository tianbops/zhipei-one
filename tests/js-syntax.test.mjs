/* 智配One · 全量 JS 语法护栏（P1-2a）
 * ----------------------------------------------------------------------------
 * 为什么必须存在：
 *   历史事故——`css/ui-unified.css` 的规则被整段误粘贴进 `js/ui-unified.js`，
 *   文件变成语法错误 → 浏览器整段跳过 → **全站弹窗/Toast/返回键/底部导航一起失效**。
 *   而当时 CI 只有 `npm run test:node`，没有任何一个环节会解析前端 JS 的语法，
 *   于是这个「整站 UI 变砖」的改动一路绿着上了生产。
 *
 * 本测试做的事只有一件：**仓库里每一个 .js 都能被 V8 解析**。
 * 不做 lint、不做风格、不做语义——只挡「上线即变砖」这一类事故。
 *
 * 覆盖范围：
 *   - js/**\/*.js          （浏览器经典脚本，CommonJS 解析）
 *   - functions/**\/*.js   （Pages Functions，ES Module 解析）
 *   - sw.js
 *   - tests/**\/*.cjs / *.mjs 也一并检查（测试自己语法错了等于没护栏）
 *
 * 模块类型判定：Cloudflare Pages Functions 是 ESM（用 export/import），
 * 前端脚本是经典脚本（用 window.*）。`node --check` 按扩展名决定解析模式，
 * 故先按「是否含顶层 export/import」选 .mjs / .cjs，**任一模式通过即算通过**，
 * 避免启发式误判造成假红灯。
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "assets", "docs"]);
const EXTS = new Set([".js", ".cjs", ".mjs"]);

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(e.name))) out.push(p);
  }
  return out;
}

const files = walk(root).sort();
const tmp = mkdtempSync(join(tmpdir(), "zp-syntax-"));

/** 用 node --check 解析一次；返回 null 表示通过，否则返回错误信息。 */
function check(src, mode) {
  const probe = join(tmp, "probe." + mode);
  writeFileSync(probe, src, "utf8");
  try {
    execFileSync(process.execPath, ["--check", probe], { stdio: "pipe" });
    return null;
  } catch (err) {
    return String((err && err.stderr) || err.message || err);
  }
}

/** 顶层 export / import 判定（行首，允许前置空白） */
const looksEsm = src => /(^|\n)[ \t]*(export|import)\s/.test(src);

let failed = 0;
const failures = [];

for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  // 按「疑似模块类型」先试一次，失败再试另一种；任一通过即可。
  const first = looksEsm(src) ? "mjs" : "cjs";
  const second = first === "mjs" ? "cjs" : "mjs";
  let err = check(src, first);
  if (err) {
    const alt = check(src, second);
    if (!alt) err = null;
    else err = alt;
  }
  if (err) {
    failed++;
    const line = (err.match(/probe\.[mc]js:(\d+)/) || [])[1] || "?";
    failures.push(`  ✗ ${rel} (第 ${line} 行附近)\n    ${err.split("\n").filter(Boolean).slice(0, 3).join("\n    ")}`);
  }
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n【JS 语法护栏】扫描 ${files.length} 个文件（js/ · functions/ · sw.js · tests/）`);
if (failed) {
  console.log(failures.join("\n"));
  console.log(`\n❌ ${failed} 个文件存在语法错误——这类改动上线会让整段脚本被浏览器丢弃（全站 UI 变砖）。\n`);
  process.exit(1);
}
console.log(`✅ 全部 ${files.length} 个文件均可被 V8 正常解析\n`);
