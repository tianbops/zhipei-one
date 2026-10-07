/**
 * 触控区不缩水验证器（Commit 2B 专用，长期复用）
 *
 * 为什么需要它：
 *   方案第十一章明确原则「视觉可以轻，触控不能小」。UI 轻量化最容易犯的错，
 *   就是为了「看起来更紧凑」而顺手把按钮、返回箭头、图标靶区改小 ——
 *   视觉确实轻了，但在真机上手指点不中。这类回退肉眼几乎看不出来，必须靠工具兜住。
 *
 * 做法：提取两条已知尺寸的 —— width / min-width / height / min-height，
 *       比对改动前后同一选择器（含 @media 上下文）的数值：
 *         增大 → 允许（合规）
 *         减小 → 视为违规，EXIT=1
 *       非尺寸类的10% 改动（如颜色、圆角）不在本工具职责内。
 *
 * 用法: node tests/tools/css-touch-audit.cjs <beforeDir|file> <afterDir|file> [文件名...]
 *   目录模式会对每个文件名做 <dir>/css/<file> 查找。
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const SIZE_PROPS = new Set(["width", "min-width", "height", "min-height"]);

/** 触控靶区识别：命中者其尺寸缩小才算违规 */
const TOUCH_RE = /(^|[^a-z-])(button|btn|back|menu|icon|tap|link|action|close|cancel|fab|chip|tab)(\b|-)/i;
/** 容器/布局类：即使是尺寸变化也不属于触控靶区（Header 收敛到统一高度正是本轮目标） */
const CONTAINER_RE = /(topbar|top-bar|head|shell|panel|card|row|list|wrap|viewport|page2)(^|[^-a-z])/i;

function isTouchTarget(sel) {
  if (CONTAINER_RE.test(sel) && !TOUCH_RE.test(sel)) return false;
  return TOUCH_RE.test(sel);
}

/** 数值化：先把 var(--x) 解析为真实值（否则 token 化的改动会被整体跳过），再提取 px */
function px(raw, vars = new Map()) {
  let v = String(raw).trim();
  for (let i = 0; i < 8 && v.includes("var("); i++) {
    v = v.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,([^)]*))?\)/g, (whole, ref, fb) => {
      const got = vars.get(ref);
      if (got !== undefined) return got;
      return fb !== undefined ? fb.trim() : whole;
    });
  }
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** 建立某个目录下全部 CSS 的变量真值表（后加载覆盖先加载，与 css-var-resolve 同口径） */
function buildVarMap(dir, files) {
  const raw = new Map();
  for (const rel of files) {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) continue;
    const root = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
    const grab = (node) => {
      if (node.type === "rule" && String(node.selector).includes(":root")) {
        node.each((d) => { if (d.type === "decl" && d.prop.startsWith("--")) raw.set(d.prop, String(d.value).trim()); });
        return;
      }
      node.each?.((c) => { if (c.type === "rule" || c.type === "atrule") grab(c); });
    };
    root.each((n) => grab(n));
  }
  const value = (name, depth = 0) => {
    if (depth > 12) return "<<递归过深>>";
    const v = raw.get(name);
    if (v === undefined) return undefined;
    return v.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,([^)]*))?\)/g, (w, ref, fb) => {
      const got = value(ref, depth + 1);
      return got !== undefined ? got : (fb !== undefined ? fb.trim() : w);
    });
  };
  const out = new Map();
  for (const k of raw.keys()) out.set(k, value(k));
  return out;
}

/** 提取 { "上下文::selector" : {width, height, ...} } */
const missing = [];
function collect(file, bucket, ctx = "", vars = new Map()) {
  // 找不到文件必须显式报错并记入 missing：否则两侧都空 → 比对「0 差异」，
  // 会变成典型的「工具失效却报成功」，比工具报错危险得多。
  if (!fs.existsSync(file)) { missing.push(file); return; }
  const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
  const walk = (node, prefix) => {
    if (node.type === "atrule") {
      if (node.nodes) node.each((c) => walk(c, `${prefix}@${node.name}(${node.params}) `));
      return;
    }
    if (node.type !== "rule") return;
    const sel = `${prefix}${String(node.selector).trim()}`;
    const dims = {};
    node.each((d) => {
      if (d.type !== "decl") { walk(d, prefix); return; }
      if (!SIZE_PROPS.has(d.prop)) return;
      const n = px(d.value, vars);
      if (n !== null) dims[d.prop] = n;
    });
    if (Object.keys(dims).length) {
      const key = `${sel}`;
      // 同一选择器多次出现时保留「最后一条」（模拟层叠覆盖）
      bucket.set(key, { ...(bucket.get(key) || {}), ...dims, __ctx: prefix.trim() });
    }
    node.each((c) => { if (c.type === "rule" || c.type === "atrule") walk(c, prefix); });
  };
  root.each((n) => walk(n, ctx));
}

const [aArg, bArg, ...names] = process.argv.slice(2);
if (!aArg || !bArg) {
  console.error("用法: node css-touch-audit.cjs <beforeDir> <afterDir> <file1> [file2...]");
  process.exit(2);
}

const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const pathIn = (base, name) => {
  if (!isDir(base)) return base;
  return path.join(base, name);
};

let shrunk = 0;
let grew = 0;
let layoutChanged = 0;
const details = [];

// 两个版本各自建一套变量真值表：before 无 Token（走字面值），after 已 token 化（需解析）
const varsA = buildVarMap(aArg, names);
const varsB = buildVarMap(bArg, names);
if (varsB.size) console.log(`变量真值表：before ${varsA.size} 个 / after ${varsB.size} 个`);

for (const name of names) {
  const A = new Map();
  const B = new Map();
  collect(pathIn(aArg, name), A, "", varsA);
  collect(pathIn(bArg, name), B, "", varsB);

  const keys = new Set([...A.keys(), ...B.keys()]);
  for (const k of keys) {
    const a = A.get(k);
    const b = B.get(k);
    if (!a || !b) continue;
    for (const prop of SIZE_PROPS) {
      const va = a[prop];
      const vb = b[prop];
      if (va === undefined || vb === undefined || va === vb) continue;
      const touch = isTouchTarget(k);
      if (vb < va) {
        if (touch) {
          shrunk++;
          details.push(`  🔴 触控缩小  ${k}\n             ${prop}: ${va}px -> ${vb}px   [${b.__ctx || "全局"}]`);
        } else {
          layoutChanged++;
          details.push(`  🔵 容器高度变化（不计违规）  ${k}\n             ${prop}: ${va}px -> ${vb}px   [${b.__ctx || "全局"}]`);
        }
      } else {
        grew++;
        details.push(`  🟢 增大  ${k}\n           ${prop}: ${va}px -> ${vb}px   [${b.__ctx || "全局"}]`);
      }
    }
  }
}

console.log(`比对：${names.join(", ")}`);
console.log(`\n${details.join("\n")}\n`);
if (missing.length) {
  console.error("以下文件未能读取，比对结果不可信：");
  console.error(missing.map((m) => "  - " + m).join("\n"));
  console.error("请检查传入的文件名是否含 css/ 前缀，或目录是否正确。");
  process.exit(2);
}

console.log("========== 汇总 ==========");
console.log(`触控/尺寸增大：${grew} 处`);
console.log(`容器高度变化（Header 收敛，不判违规）：${layoutChanged} 处`);
console.log(`⚠️ 触控区缩小：${shrunk} 处`);
const ok = shrunk === 0;
console.log(ok ? "\n=== 无任何触控区变小 EXIT=0 ===" : "\n=== 存在触控区变小，违反「触控不能小」 EXIT=1 ===");
process.exit(ok ? 0 : 1);
