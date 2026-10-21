#!/usr/bin/env node
/**
 * CSS 死代码清除（总控·减法打磨）—— 基于 postcss 解析，精确处理单行多规则
 *
 * 只处理「已人工核实：业务 HTML/JS 中零引用」的 class：
 *   · 规则的所有顶层选择器都依赖死 class        -> 整条删除
 *   · 仅部分选择器依赖死 class                  -> 只摘掉那些选择器
 *   · 选择器含 :where()/:is()                   -> 只摘括号内死项，通用元素与活 class 保留
 *   · 清除后变成孤儿的 @keyframes               -> 一并删除
 *
 * 用法：
 *   node tools/css-prune-dead.cjs           # dry-run，仅报告
 *   node tools/css-prune-dead.cjs --write   # 落盘
 *
 * 安全机制：
 *   1. 用 postcss 解析，天然支持「一行多条规则」，绝不误伤同行邻居规则
 *   2. class 名按 token 精确比对，.menu-panel 不会误伤 .menu-panel-item
 *   3. 只摘不增：绝不新增任何选择器或声明，保证零视觉变化
 */
const fs = require("fs");
const path = require("path");
const postcss = require("postcss");

const ROOT = path.resolve(__dirname, "..");
const WRITE = process.argv.includes("--write");

const CSS_FILES = [
  "css/app.css", "css/ui-base.css", "css/ui-overlay.css", "css/ui-theme.css", "css/ui-shell.css",
  "css/mobile-ui.css", "css/home-base.css", "css/home-trend.css", "css/home-dashboard.css", "css/home-light.css",
  "css/business-pages.css", "css/data.css", "css/history-shell.css", "css/history-list.css", "css/history-nav.css", "css/history-light.css", "css/history-overlays.css", "css/history-overlay-light.css", "css/order_detail.css",
];

// 已人工核实：业务 HTML/JS 中零引用（静态引用 + 动态拼接均已排查）
const DEAD = new Set([
  "history-actions-label", "history-date-copy", "history-date-cta",
  "history-date-icon", "history-page-head", "history-quick-action",
  "history-quick-chevron", "history-toolbar",
  "zp-btn--danger", "zp-btn--ghost", "zp-btn--primary",
  "menu-route-value", "menu-user-label", "menu-user-header",
  "home-menu-panel", "home-menu-button", "menu-panel", "menu-button", "menu-wrap",
  "function-icon", "function-list", "function-btn",
  "dispatch-list", "dispatch-route-meta", "dispatch-option",
  "data-float-up", "data-float-down",
  "route-meta", "page2-panel",
  "account-install-btn", "account-install-card", "account-install-main",
]);

const CLASS_RE = /\.([A-Za-z0-9_-]+)/g;

function classesOf(sel) {
  const out = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(sel)) !== null) out.push(m[1]);
  return out;
}

const usesDead = (sel) => classesOf(sel).some((c) => DEAD.has(c));

/** 按顶层逗号拆分选择器（忽略伪函数/属性选择器内的逗号） */
function splitTop(sel) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of sel) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const PSEUDO_LIST_RE = /:(where|is)\(([^)]*)\)/g;

/** 在 :where()/:is() 括号内按逗号剔除死项，保留通用元素与活 class */
function cleanPseudoList(selector) {
  let removed = 0;
  const out = selector.replace(PSEUDO_LIST_RE, (full, name, inner) => {
    const parts = inner.split(",").map((p) => p.trim()).filter(Boolean);
    const kept = parts.filter((p) => !usesDead(p));
    removed += parts.length - kept.length;
    return kept.length ? `:${name}(${kept.join(",")})` : "";
  });
  return { out, removed, emptied: /:(where|is)\(\s*\)/.test(out) };
}

/** 处理单个顶层选择器，返回 { keep, selector, removed } */
function pruneSelector(sel) {
  if (PSEUDO_LIST_RE.test(sel)) {
    PSEUDO_LIST_RE.lastIndex = 0;
    const r = cleanPseudoList(sel);
    if (r.emptied || !r.out.trim()) return { keep: false, removed: r.removed };
    return { keep: true, selector: r.out, removed: r.removed };
  }
  if (usesDead(sel)) return { keep: false, removed: 1 };
  return { keep: true, selector: sel, removed: 0 };
}

function pruneRule(selectorText) {
  const parts = splitTop(selectorText);
  const kept = [];
  let removed = 0;
  for (const p of parts) {
    const r = pruneSelector(p);
    removed += r.removed;
    if (r.keep) kept.push(r.selector);
  }
  return { selector: kept.join(", "), removed, all: parts.length, none: kept.length === 0 };
}

function processFile(rel) {
  const file = path.join(ROOT, rel);
  const before = fs.readFileSync(file, "utf8");
  const root = postcss.parse(before, { from: file });
  const removed = [];
  const trimmed = [];

  root.walkRules((rule) => {
    // 跳过 @keyframes 内部的百分比规则
    const parent = rule.parent;
    if (parent && parent.type === "atrule" && /^(-\w+-)?keyframes$/.test(parent.name)) return;

    const r = pruneRule(rule.selector);
    if (r.none) {
      removed.push(rule.selector);
      rule.remove();
    } else if (r.removed) {
      trimmed.push([rule.selector, r.selector]);
      rule.selector = r.selector;
    }
  });

  // 删除孤儿 @keyframes（本文件内已无人引用）
  const kfNames = [];
  root.walkAtRules((at) => {
    if (/^(-\w+-)?keyframes$/.test(at.name)) kfNames.push(at.params.trim());
  });
  const usedAnims = new Set();
  // 注意：要按「声明的属性名」判断，而不是在属性值里找 "animation:"
  root.walkDecls((decl) => {
    const prop = decl.prop.replace(/^-\w+-/, "");
    if (prop !== "animation" && prop !== "animation-name") return;
    decl.value.split(",").forEach((seg) => {
      const first = seg.trim().split(/\s+/)[0];
      if (first && first !== "none") usedAnims.add(first);
    });
  });
  const orphanKf = [];
  root.walkAtRules((at) => {
    if (/^(-\w+-)?keyframes$/.test(at.name) && !usedAnims.has(at.params.trim())) {
      orphanKf.push(at.params.trim());
      at.remove();
    }
  });

  const after = root.toString();
  return { rel, before, after, removed, trimmed, orphanKf };
}

const results = CSS_FILES.map(processFile);
let totalRemoved = 0;
let totalTrimmed = 0;
let totalBytes = 0;

for (const r of results) {
  console.log(`\n=== ${r.rel} ===`);
  for (const sel of r.removed) console.log(`  [删] ${sel.slice(0, 110)}`);
  for (const [old, neu] of r.trimmed) {
    console.log(`  [摘] ${old.slice(0, 78)}`);
    console.log(`       -> ${neu.slice(0, 78)}`);
  }
  for (const k of r.orphanKf) console.log(`  [动画孤儿] @keyframes ${k}`);
  totalRemoved += r.removed.length;
  totalTrimmed += r.trimmed.length;
  totalBytes += r.before.length - r.after.length;
  if (WRITE) fs.writeFileSync(path.join(ROOT, r.rel), r.after, "utf8");
}

console.log(
  `\n合计：整条删除 ${totalRemoved} 条 | 摘选择器 ${totalTrimmed} 条 | 孤儿动画 ${results.reduce((n, r) => n + r.orphanKf.length, 0)} | 体积减少 ${totalBytes} 字节`
);
console.log("模式：", WRITE ? "已落盘" : "DRY-RUN（未修改文件）");
