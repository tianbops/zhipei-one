#!/usr/bin/env node
/**
 * 从 functions/api/*.js 生成 API 契约文档 docs/API.md（P1-5）
 * ------------------------------------------------------------------
 * 背景：38 个端点、OpenAPI 0 份。本脚本以**静态扫描**方式，从 Pages Functions
 * 的导出签名提取「方法 + 路径 + 说明」，生成人类可读的 Markdown 契约表，
 * 避免手写文档与代码漂移。
 *
 * 提取规则：
 *   · 路径 = 文件相对 functions/ 的位置去 .js（functions/api/history.js → /api/history，
 *     functions/api/waybills/process.js → /api/waybills/process）；
 *   · 方法 = 导出的 onRequest 后缀（onRequestGet→GET、onRequestPost→POST、
 *     onRequestDelete→DELETE、onRequestPut→PUT、onRequestPatch→PATCH、
 *     onRequestHead→HEAD、onRequestOptions→OPTIONS、onRequest→ALL）；一个文件可导出多个；
 *   · 说明 = 文件首个块注释（JSDoc）或行首 // 注释的首行；无则「—」；
 *   · 跳过 `_` 前缀文件（内部助手，非端点）与子目录 package.json。
 *
 * 用法（repo-web 目录内）：node scripts/gen-api-docs.mjs [--check]
 *   --check：不写文件，仅校验 docs/API.md 是否与生成结果一致（供 CI 防漂移）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(root, "functions", "api");
const OUT = path.join(root, "docs", "API.md");

const METHOD_MAP = {
  "": "ALL", Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Head: "HEAD", Options: "OPTIONS",
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function leadingDoc(src) {
  // 首个块注释 /** … */
  const block = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (block) {
    const text = block[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text) return text.length > 80 ? text.slice(0, 77) + "…" : text;
  }
  // 行首 // 注释（取第一段连续注释）
  const lines = src.split("\n");
  const doc = [];
  for (const l of lines) {
    const m = l.match(/^\s*\/\/\s?(.*)$/);
    if (m) doc.push(m[1].trim());
    else if (doc.length) break;
    else if (l.trim() === "") continue;
    else break;
  }
  if (doc.length) {
    const text = doc.join(" ");
    return text.length > 80 ? text.slice(0, 77) + "…" : text;
  }
  return "—";
}

function extractMethods(src) {
  const re = /export\s+(?:async\s+)?function\s+onRequest([A-Za-z]*)/g;
  const methods = new Set();
  let m;
  while ((m = re.exec(src))) methods.add(METHOD_MAP[m[1]] ?? "ALL");
  if (!methods.size) return null; // 非端点（如仅导出常量/助手的文件）
  // 展示顺序：ALL 优先，其余按常见方法排序
  const order = ["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  return [...methods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// 跳过 `_` 前缀的内部助手，以及 `[[path]].js` 这类兜底通配路由（不是业务端点）
const files = walk(API_DIR).filter((f) => {
  const b = path.basename(f);
  return !b.startsWith("_") && !b.includes("[");
});
const rows = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const methods = extractMethods(src);
  if (!methods) continue;
  const rel = "/" + path.relative(path.join(root, "functions"), f).replace(/\\/g, "/").replace(/\.js$/, "");
  rows.push({ path: rel, methods: methods.join(" / "), doc: leadingDoc(src) });
}
rows.sort((a, b) => a.path.localeCompare(b.path));

const checkOnly = process.argv.includes("--check");

const md = [
  "# 智配One · API 契约（自动生成）",
  "",
  "> 本文件由 `scripts/gen-api-docs.mjs` 从 `functions/api/*.js` 的导出签名静态扫描生成，**请勿手改**。",
  "> 更新端点后运行 `npm run docs:api`（或 `node scripts/gen-api-docs.mjs --check` 校验防漂移）。",
  "",
  "**统一响应格式**：`{ success: boolean, error?: string, code?: string }`（失败时 `success:false`）。",
  "鉴权走 `credentials: \"same-origin\"` 的会话 Cookie；写操作（POST/PUT/DELETE）前端默认不做自动重试。",
  "",
  `**端点数：${rows.length}**`,
  "",
  "| 方法 | 路径 | 说明 |",
  "|---|---|---|",
  ...rows.map((r) => `| ${r.methods} | \`${r.path}\` | ${r.doc.replace(/\|/g, "\\|")} |`),
  "",
].join("\n");

if (checkOnly) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== md) {
    console.error(`docs/API.md 与生成结果不一致（可能漏跑 npm run docs:api）。端点 ${rows.length} 个。`);
    process.exit(1);
  }
  console.log(`docs:api --check：一致（${rows.length} 个端点）`);
} else {
  writeFileSync(OUT, md);
  const byMethod = rows.reduce((acc, r) => {
    for (const m of r.methods.split(" / ")) acc[m] = (acc[m] || 0) + 1;
    return acc;
  }, {});
  console.log(`已生成 docs/API.md：${rows.length} 个端点`);
  console.log("  方法分布：", byMethod);
}
