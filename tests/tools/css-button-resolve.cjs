/**
 * 页面级按钮最终生效值计算器（Commit 3A 引入）
 *
 * 为什么必须有它：
 *   Commit 2B 踩过一次实坑 —— 在 history.css 行 326 把返回键改成 Token，
 *   结果行 505、508 的同选择器后续定义又把 44px 盖了回去，改动**完全不生效**。
 *   当时是靠「工具报 0 处变化」才发现的，不是人眼。
 *   根因是：逐文件看规则不等于看页面实际生效值。CSS 是层叠的，
 *   同一个按钮在 app.css / ui-unified.css / 页面专属 css 里可能被定义三四次，
 *   谁生效取决于<link>顺序，而不是谁写得「更合理」。
 *
 * 所以本工具按页面的真实 <link> 顺序合并全部 CSS，后加载覆盖先加载，
 *   得出每个按钮选择器在**该页面**上的最终触控高度，再判断达标与否。
 *   这是 Commit 3A 的验收标准：不看你改了哪一行，只看页面最终值 ≥48。
 *
 * 用法: node css-button-resolve.cjs [页面路径...]
 *   缺省则扫描仓库内全部业务页面。EXIT=1 表示存在未达标项。
 */

const fs = require("fs");
const path = require("path");
const { loadPostcss } = require("./_css-toolkit.cjs");
const postcss = loadPostcss();

const REPO = path.resolve(__dirname, "..", "..");
const MIN_TOUCH = 48;

/* 与 css-button-audit.cjs 保持同一套识别口径 */
const BTN_RE = /(btn|button)(-|\b|$)/i;
const INPUT_RE = /(input|select|textarea)(-|\b|$)/i;
const CONTAINER_RE = /(-actions|-list|-panel|-group|-row|-wrap|-head|-main|-status|-surface|-index|-vehicle)(-|\b|$)/i;
/** 视觉隐藏控件：不是触控靶区（经典的可访问性隐藏写法），不参与达标判定 */
const HIDDEN_RE = /(opacity:\s*0|pointer-events:\s*none|visibility:\s*hidden)/i;

/** 装饰性子元素：svg / path / icon 字体等是按钮**内部**的图形，不是触控靶区本身。
    靶区是父级按钮 —— 只改这些子元素的尺寸也点不到，改它们更是毫无意义。
    第一轮跑出「.order-icon-btn svg 21px」就是没排掉这类。 */
const DECOR_RE = /^(svg|path|circle|rect|g|polyline|line|use|i|span|em|strong|img|br|label)$/i;
/** 裸元素里本身就是靶区的 */
const ELEMENT_TARGET_RE = /^(a|button|input|select|textarea)$/i;

function isButtonLike(sel) {
  const parts = sel.split(/[\s,>~+]+/).filter(Boolean);
  if (!parts.length) return false;
  // 末段是装饰子元素 → 整条规则不是靶区定义
  if (DECOR_RE.test(parts[parts.length - 1])) return false;
  const hit = parts.some((s) => BTN_RE.test(s) || INPUT_RE.test(s) || ELEMENT_TARGET_RE.test(s));
  if (!hit) return false;
  return !CONTAINER_RE.test(parts[parts.length - 1]);
}

function px(raw, vars) {
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

/** 按给定文件顺序合并变量表（后加载覆盖先加载） */
function buildVarMap(files) {
  const raw = new Map();
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error("缺少 CSS 文件: " + f); process.exit(2); }
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

/** 合并按钮规则：key = "@media(...) ::selector"，后加载覆盖先加载 */
function collectButtons(files, vars) {
  const flat = new Map();   // 全局（非 media）规则
  const media = new Map();  // media 内规则，单独存
  for (const f of files) {
    const root = postcss.parse(fs.readFileSync(f, "utf8"), { from: f });
    const walk = (node, prefix) => {
      if (node.type === "atrule") {
        if (node.nodes) node.each((c) => walk(c, `@${node.name}(${node.params}) `));
        return;
      }
      if (node.type !== "rule") return;
      const sel = `${prefix}${String(node.selector).trim()}`;
      if (isButtonLike(sel)) {
        const decls = {};
        let hidden = false;
        node.each((d) => {
          if (d.type !== "decl") return;
          if (d.prop === "opacity" || d.prop === "pointer-events" || d.prop === "visibility") {
            if (HIDDEN_RE.test(`${d.prop}:${d.value}`)) hidden = true;
          }
          if (["min-height", "height", "min-width", "width"].includes(d.prop)) decls[d.prop] = String(d.value).trim();
        });
        if (Object.keys(decls).length || hidden) {
          const bucket = prefix ? media : flat;
          bucket.set(sel, { ...(bucket.get(sel) || {}), ...decls, __hidden: hidden, __file: path.basename(f) });
        }
      }
      node.each((c) => { if (c.type === "rule" || c.type === "atrule") walk(c, prefix); });
    };
    root.each((n) => walk(n, ""));
  }
  return { flat, media };
}

function touchOf(o, vars) {
  if (!o) return null;
  const a = px(o["min-height"], vars);
  if (a !== null) return a;
  return px(o.height, vars);
}

/** 从 HTML 提取按序的本地 CSS 列表 */
function cssLinksOf(htmlPath) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const out = [];
  const re = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const h = /href=["']([^"']+)["']/.exec(m[0]);
    if (!h) continue;
    let href = h[1];
    if (href.startsWith("http")) continue;
    href = href.split("?")[0];
    out.push(path.join(REPO, href.replace(/^\//, "")));
  }
  return out;
}

const pages = process.argv.slice(2);
const targets = pages.length ? pages : [
  "index.html", "home.html", "admin.html", "register.html", "setup.html",
  "pages/account.html", "pages/data.html", "pages/dispatch.html",
  "pages/history.html", "pages/order_detail.html", "pages/route_apply.html", "pages/today.html",
].map((p) => path.join(REPO, p)).filter(fs.existsSync);

let totalBad = 0;
let totalRules = 0;

for (const page of targets) {
  const files = cssLinksOf(page).filter((f) => fs.existsSync(f));
  if (!files.length) { console.log(`\n— ${path.relative(REPO, page)}：无 CSS 引用，跳过`); continue; }
  const vars = buildVarMap(files);
  const { flat, media } = collectButtons(files, vars);

  const rows = [];
  for (const [sel, o] of flat) {
    const h = touchOf(o, vars);
    if (h === null) continue;
    totalRules++;
    rows.push({ sel, h, hidden: o.__hidden, file: o.__file });
  }
  const bad = rows.filter((r) => !r.hidden && r.h < MIN_TOUCH);
  totalBad += bad.length;

  console.log(`\n── ${path.relative(REPO, page)}  （${files.length} 个 CSS，按钮规则 ${rows.length} 条）`);
  for (const r of bad.sort((a, b) => a.h - b.h)) {
    console.log(`   🔴 ${String(r.h + "px").padEnd(6)} ${r.sel.slice(0, 88)}`);
  }
  if (!bad.length) console.log("   ✅ 全部达标");

  const mrows = [];
  for (const [sel, o] of media) {
    const h = touchOf(o, vars);
    if (h !== null && !o.__hidden && h < MIN_TOUCH) mrows.push({ sel, h });
  }
  if (mrows.length) {
    console.log(`   ⚪ 媒体查询内降级（已知例外，不强制）：`);
    for (const r of mrows) console.log(`      ${String(r.h + "px").padEnd(6)} ${r.sel.slice(0, 80)}`);
  }
}

console.log(`\n========== 汇总 ==========`);
console.log(`覆盖 ${targets.length} 个页面，按钮/输入规则最终生效值 ${totalRules} 条`);
console.log(`⚠️ 最终生效触控高度 < ${MIN_TOUCH}px：${totalBad} 处`);
const ok = totalBad === 0;
console.log(ok ? "\n=== 全部页面按钮触控达标 EXIT=0 ===" : "\n=== 存在未达标按钮 EXIT=1 ===");
process.exit(ok ? 0 : 1);
