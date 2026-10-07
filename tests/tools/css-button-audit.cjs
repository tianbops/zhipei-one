/**
 * 按钮 / 输入框规范审计器（方案第十三章，Commit 3A 引入，长期复用）
 *
 * 为什么需要它：
 *   第十三章给了 Button 的四条硬标准 —— 触控 ≥48px、padding 0 16px、
 *   radius 10–12px、font 14–16px，以及一条容易被忽略的定性要求：
 *   「禁止每一个按钮都做成 Primary」。
 *   前四条可以用数值查，最后一条只能靠统计分布：如果全站找不出几个
 *   Secondary / Destructive，说明层级其实是用颜色深浅而不是语义表达的。
 *
 * 两个模式：
 *   report  列出全部按钮/输入选择器的实测参数与偏差（现状台账）
 *   check   比对改动前后，规则：
 *             · 触控尺寸只许增大，不许缩小（沿用 Commit 2B 红线）
 *             · radius / font-size / padding-x 的改动必须「朝规范区间靠拢」，
 *               离规范更远的一律判违规 —— 防止「轻量化」变成随手改数值
 *
 * 用法: node css-button-audit.cjs report  [文件...]
 *       node css-button-audit.cjs check <beforeDir> <afterDir> <文件...>
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

/* ===== 规范常量（方案第十三章） ===== */
const SPEC = {
  minTouch: 48,
  radiusMin: 10,
  radiusMax: 12,
  fontMin: 14,
  fontMax: 16,
  padX: 16,
};

/* ===== 识别规则 =====
   命中「是按钮」：类/元素名以 btn / button 结尾，或典型的输入控件名。
   命中「是容器」：-actions / -list / -panel / -group / -row / -wrap 这类复数容器，
   它们内部才放按钮，自身不是触控靶区。 */
const BTN_RE = /(btn|button)(-|\b|$)/i;
const INPUT_RE = /(input|select|textarea)(-|\b|$)/i;
const CONTAINER_RE = /(-actions|-list|-panel|-group|-row|-wrap|-head|-main|-status|-surface|-index|-vehicle)(-|\b|$)/i;
/** 需要采集的声明 */
const WANT = new Set([
  "width", "min-width", "height", "min-height",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "border-radius", "font-size", "background", "background-color", "color",
]);

function isButtonLike(sel) {
  const single = sel.split(/[\s,>~+]+/).filter(Boolean);
  // 只要选择器任一段命中按钮/输入，且没有任何一段是纯容器，就当作按钮规则
  const hit = single.some((s) => BTN_RE.test(s) || INPUT_RE.test(s));
  if (!hit) return false;
  const last = single[single.length - 1];
  return !CONTAINER_RE.test(last);
}

/** 数值化：先把 var(--x) 解析为真实值，再提取 px。
    不解析 var() 的话，token 化过的规则会被整体跳过 —— Commit 2B 已经踩过这个坑。 */
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
    if (depth > 12) return undefined;
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

const missing = [];
/** 采集 { 文件::上下文::selector : { prop: 原文 } }，同一 key 后覆盖先（模拟层叠） */
function collect(file, bucket, vars = new Map()) {
  if (!fs.existsSync(file)) { missing.push(file); return; }
  const root = postcss.parse(fs.readFileSync(file, "utf8"), { from: file });
  const walk = (node, prefix) => {
    if (node.type === "atrule") {
      if (node.nodes) node.each((c) => walk(c, `${prefix}@${node.name}(${node.params}) `));
      return;
    }
    if (node.type !== "rule") return;
    const sel = `${prefix}${String(node.selector).trim()}`;
    if (isButtonLike(sel)) {
      const got = {};
      node.each((d) => {
        if (d.type !== "decl") return;
        if (!WANT.has(d.prop)) return;
        got[d.prop] = String(d.value).trim();
      });
      if (Object.keys(got).length) {
        bucket.set(sel, { ...(bucket.get(sel) || {}), ...got, __ctx: prefix.trim(), __file: path.basename(file) });
      }
    }
    node.each((c) => { if (c.type === "rule" || c.type === "atrule") walk(c, prefix); });
  };
  root.each((n) => walk(n, ""));
}

/** 取触控高度：min-height 优先（它才是「至少多大」的承诺），其次 height */
function touchHeight(o, vars) {
  const a = px(o["min-height"], vars);
  if (a !== null) return a;
  const b = px(o.height, vars);
  return b;
}

function padX(o, vars) {
  if (o.padding !== undefined) {
    const parts = String(o.padding).trim().split(/\s+/);
    const vals = parts.map((p) => px(p, vars));
    if (parts.length === 1) return vals[0];
    if (parts.length >= 2) return vals[1]; // 上下 左右
  }
  const l = px(o["padding-left"], vars);
  const r = px(o["padding-right"], vars);
  if (l !== null && r !== null) return Math.min(l, r);
  return l ?? r ?? null;
}

/* ============ 模式一：现状报告 ============ */
function modeReport(files) {
  const vars = buildVarMap(process.cwd(), files);
  const all = new Map();
  for (const f of files) collect(f, all, vars);

  const rows = [];
  for (const [sel, o] of all) {
    const h = touchHeight(o, vars);
    const r = px(o["border-radius"], vars);
    const fs2 = px(o["font-size"], vars);
    const p = padX(o, vars);
    const issues = [];
    if (h !== null && h < SPEC.minTouch) issues.push(`触控 ${h}<${SPEC.minTouch}`);
    if (r !== null && (r < SPEC.radiusMin || r > SPEC.radiusMax)) issues.push(`radius ${r}`);
    if (fs2 !== null && (fs2 < SPEC.fontMin || fs2 > SPEC.fontMax)) issues.push(`font ${fs2}`);
    if (p !== null && p < SPEC.padX) issues.push(`padX ${p}`);
    rows.push({ sel, file: o.__file, ctx: o.__ctx, h, r, f: fs2, p, issues, bg: o.background || o["background-color"] || "" });
  }
  rows.sort((a, b) => (a.h ?? 999) - (b.h ?? 999));

  console.log("========== 按钮 / 输入框现状台账（方案第十三章） ==========");
  console.log(`规范：触控≥${SPEC.minTouch}  radius ${SPEC.radiusMin}-${SPEC.radiusMax}  font ${SPEC.fontMin}-${SPEC.fontMax}  padX≥${SPEC.padX}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("文件", 20) + pad("选择器", 46) + pad("触控", 7) + pad("radius", 8) + pad("font", 6) + pad("padX", 6) + "偏差");
  console.log("-".repeat(120));
  for (const r of rows) {
    console.log(
      pad(r.file, 20) + pad(r.sel.slice(0, 44), 46) +
      pad(r.h === null ? "-" : r.h + "px", 7) +
      pad(r.r === null ? "-" : r.r + "px", 8) +
      pad(r.f === null ? "-" : r.f + "px", 6) +
      pad(r.p === null ? "-" : r.p + "px", 6) +
      (r.issues.length ? "⚠ " + r.issues.join(" / ") : "合规")
    );
  }

  const bad = rows.filter((r) => r.issues.some((i) => i.startsWith("触控")));
  console.log(`\n共 ${rows.length} 条按钮/输入规则，其中触控低于 ${SPEC.minTouch}px 的硬违规 ${bad.length} 条：`);
  for (const r of bad) console.log(`  🔴 ${r.file}  ${r.sel}  → ${r.h}px  ${r.ctx ? "[" + r.ctx + "]" : ""}`);

  // 第十三章定性要求：Primary / Secondary / Destructive 三层都要有人用
  const sem = { primary: 0, secondary: 0, destructive: 0, other: 0 };
  for (const r of rows) {
    const s = r.sel.toLowerCase();
    if (/danger|destructive|cancel|delete|remove/.test(s)) sem.destructive++;
    else if (/primary/.test(s)) sem.primary++;
    else if (/secondary|text-button|choice|ghost/.test(s)) sem.secondary++;
    else sem.other++;
  }
  console.log(`\n语义层级分布（第十三章「禁止每个按钮都是 Primary」）：`);
  console.log(`  Primary ${sem.primary} / Secondary ${sem.secondary} / Destructive ${sem.destructive} / 未分类 ${sem.other}`);
  return 0;
}

/* ============ 模式二：改动前后比对 ============ */
function modeCheck(beforeDir, afterDir, names) {
  const varsA = buildVarMap(beforeDir, names);
  const varsB = buildVarMap(afterDir, names);
  const A = new Map(), B = new Map();
  for (const n of names) { collect(path.join(beforeDir, n), A, varsA); collect(path.join(afterDir, n), B, varsB); }

  // 距离规范有多远：0 表示落在区间内，越大越离谱
  const distToSpec = (v, lo, hi) => (v === null ? null : v < lo ? lo - v : v > hi ? v - hi : 0);

  let violations = 0, improved = 0, neutral = 0;
  const lines = [];
  for (const sel of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(sel), b = B.get(sel);
    if (!a || !b) continue;
    const cmp = (label, get, lo, hi) => {
      const va = get(a, varsA), vb = get(b, varsB);
      if (va === null || vb === null || va === vb) return;
      const da = distToSpec(va, lo, hi), db = distToSpec(vb, lo, hi);
      if (da === null || db === null) return;
      if (db > da) {
        violations++;
        lines.push(`  🔴 ${label} 离规范更远  ${sel}\n        ${va} -> ${vb}  (规范 ${lo}-${hi})`);
      } else if (db < da) {
        improved++;
        lines.push(`  🟢 ${label} 朝规范靠拢  ${sel}\n        ${va} -> ${vb}  (规范 ${lo}-${hi})`);
      } else {
        neutral++;
        lines.push(`  ⚪ ${label} 等效改动  ${sel}\n        ${va} -> ${vb}`);
      }
    };
    // 触控：只许增大
    const ha = touchHeight(a, varsA), hb = touchHeight(b, varsB);
    if (ha !== null && hb !== null && ha !== hb) {
      if (hb < ha) { violations++; lines.push(`  🔴 触控缩小（硬违规）  ${sel}\n        ${ha}px -> ${hb}px`); }
      else { improved++; lines.push(`  🟢 触控增大  ${sel}\n        ${ha}px -> ${hb}px`); }
    }
    cmp("radius", (o, v) => px(o["border-radius"], v), SPEC.radiusMin, SPEC.radiusMax);
    cmp("font", (o, v) => px(o["font-size"], v), SPEC.fontMin, SPEC.fontMax);
  }

  console.log(`比对 ${names.length} 个文件（before=${beforeDir}  after=${afterDir}）\n`);
  console.log(lines.join("\n"));
  if (missing.length) {
    console.error("\n以下文件未能读取，比对结果不可信：\n" + missing.map((m) => "  - " + m).join("\n"));
    process.exit(2);
  }
  console.log("\n========== 汇总 ==========");
  console.log(`朝规范靠拢 / 触控增大：${improved} 处`);
  console.log(`等效改动（值变但合规度不变）：${neutral} 处`);
  console.log(`⚠️ 违规（触控缩小 或 离规范更远）：${violations} 处`);
  const ok = violations === 0;
  console.log(ok ? "\n=== 按钮改动全部合规 EXIT=0 ===" : "\n=== 存在违规 EXIT=1 ===");
  return ok ? 0 : 1;
}

/* ===== 入口 ===== */
const mode = process.argv[2];
if (mode === "report") {
  const files = process.argv.slice(3);
  if (!files.length) { console.error("用法: node css-button-audit.cjs report <file...>"); process.exit(2); }
  process.exit(modeReport(files));
} else if (mode === "check") {
  const [a, b, ...names] = process.argv.slice(3);
  if (!a || !b || !names.length) { console.error("用法: node css-button-audit.cjs check <beforeDir> <afterDir> <file...>"); process.exit(2); }
  process.exit(modeCheck(a, b, names));
} else {
  console.error("用法: node css-button-audit.cjs report <file...> | check <beforeDir> <afterDir> <file...>");
  process.exit(2);
}
