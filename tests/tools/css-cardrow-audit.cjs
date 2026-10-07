/**
 * Card / Row 参数审计器（方案第十四、十五章，Commit 3C 引入）
 *
 * 为什么需要它：
 *   第十四章给了 Card 标准、第十五章要求「Row 成为主要业务单位」。
 *   但真正动手前必须先分清两件事 ——
 *     · 结构问题：某个列表项是不是被错误地用 Card 实现了（要改 DOM）
 *     · 参数问题：Card / Row 各自的 padding、radius、间距是否统一（只改数值）
 *   这两件事的风险差一个量级：前者改结构、必须看渲染才能确认；后者可以纯数值验证。
 *   本工具只解决「看清参数离散度」，把结构问题留给人工判断。
 *
 * 用法: node css-cardrow-audit.cjs [文件...]
 *   EXIT 恒为 0 —— 它是审计工具不是门禁，门禁由 check 模式承担。
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const CARD_RE = /card(-|\b|$)/i;
const ROW_RE = /(-|\b|^)(row|item|entry|line)(-|\b|$)/i;
/** 只取「看起来是容器/行」的选择器末段，排除 .row-main / .row-index 这类内部零件 */
const PART_RE = /(-main|-index|-title|-head|-body|-meta|-status|-surface|-actions|-icon|-text|-label|-value|-nav|-drag|-open|-swiped)(-|\b|$)/i;

const WANT = new Set([
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "border-radius", "min-height", "margin-bottom", "margin",
  "background", "background-color", "border", "border-bottom",
]);

function kindOf(sel) {
  const parts = sel.split(/[\s,>~+]+/).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (PART_RE.test(last)) return null;      // 内部零件，不是容器本身
  if (CARD_RE.test(last)) return "card";
  if (ROW_RE.test(last)) return "row";
  return null;
}

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

function buildVarMap(files) {
  const raw = new Map();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const root = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
    const grab = (n) => {
      if (n.type === "rule" && String(n.selector).includes(":root")) {
        n.each((d) => { if (d.type === "decl" && d.prop.startsWith("--")) raw.set(d.prop, String(d.value).trim()); });
        return;
      }
      n.each?.((c) => { if (c.type === "rule" || c.type === "atrule") grab(c); });
    };
    root.each(grab);
  }
  const value = (name, d = 0) => {
    if (d > 12) return undefined;
    const v = raw.get(name);
    if (v === undefined) return undefined;
    return v.replace(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,([^)]*))?\)/g, (w, ref, fb) => {
      const got = value(ref, d + 1);
      return got !== undefined ? got : (fb !== undefined ? fb.trim() : w);
    });
  };
  const out = new Map();
  for (const k of raw.keys()) out.set(k, value(k));
  return out;
}

const files = process.argv.slice(2);
if (!files.length) { console.error("用法: node css-cardrow-audit.cjs <file...>"); process.exit(2); }
const vars = buildVarMap(files);

const buckets = { card: new Map(), row: new Map() };
for (const f of files) {
  const root = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
  const walk = (node, prefix) => {
    if (node.type === "atrule") {
      if (node.nodes) node.each((c) => walk(c, `@${node.name}(${node.params}) `));
      return;
    }
    if (node.type !== "rule") return;
    const group = String(node.selector);
    for (const one of group.split(",").map((s) => s.trim()).filter(Boolean)) {
      const kind = kindOf(one);
      if (!kind) continue;
      const got = {};
      node.each((d) => {
        if (d.type !== "decl") return;
        if (WANT.has(d.prop)) got[d.prop] = String(d.value).trim();
      });
      if (!Object.keys(got).length) continue;
      const sel = `${prefix}${one}`;
      buckets[kind].set(sel, { ...(buckets[kind].get(sel) || {}), ...got, __file: path.basename(f), __ctx: prefix.trim() });
    }
    node.each((c) => { if (c.type === "rule" || c.type === "atrule") walk(c, prefix); });
  };
  root.each((n) => walk(n, ""));
}

const pad = (s, n) => String(s).padEnd(n);
for (const kind of ["card", "row"]) {
  const rows = [...buckets[kind].entries()].filter(([, o]) => o.padding || o["border-radius"] || o["min-height"]);
  console.log(`\n========== ${kind.toUpperCase()}（${rows.length} 条） ==========`);
  console.log(pad("文件", 20) + pad("选择器", 40) + pad("padding", 14) + pad("radius", 9) + pad("minH", 7) + "背景/边");
  console.log("-".repeat(100));
  for (const [sel, o] of rows) {
    const r = px(o["border-radius"], vars);
    const h = px(o["min-height"], vars);
    console.log(
      pad(o.__file, 20) + pad(sel.slice(0, 38), 40) +
      pad((o.padding || "-").slice(0, 12), 14) +
      pad(r === null ? "-" : r + "px", 9) +
      pad(h === null ? "-" : h + "px", 7) +
      (o.background || o["background-color"] || o.border || "").slice(0, 30)
    );
  }
  // 离散度统计
  const tally = (get) => {
    const m = new Map();
    for (const [, o] of rows) {
      const v = get(o);
      if (v === null || v === undefined) continue;
      m.set(String(v), (m.get(String(v)) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log(`\n  padding 分布: ${tally((o) => o.padding).map(([v, c]) => `${v}×${c}`).join("  ") || "无"}`);
  console.log(`  radius  分布: ${tally((o) => px(o["border-radius"], vars)).map(([v, c]) => `${v}×${c}`).join("  ") || "无"}`);
  console.log(`  minH    分布: ${tally((o) => px(o["min-height"], vars)).map(([v, c]) => `${v}×${c}`).join("  ") || "无"}`);
}
