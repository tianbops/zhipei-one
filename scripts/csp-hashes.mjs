#!/usr/bin/env node
/**
 * CSP hash-based 灰度生成器（P1-7b，承接 docs/CSP-hardening.md 结论）
 * ------------------------------------------------------------------
 * 背景：CF Pages 静态托管无逐请求 HTML 生成 → nonce 化不可行；全站 42 段内联
 * <script>（16 个服务页 + 4 个 dev 工具页 + 1 个测试 fixture）+ 0 处 eval /
 * new Function + 0 处 javascript: URL + 0 处内联事件属性（tools 5 处已改
 * addEventListener）→ 去 'unsafe-inline' 走 hash-based CSP 的硬条件已齐备。
 *
 * 本脚本：
 *   1) 扫描仓库全部 *.html，抽取可执行内联 <script> 块（无 src、无非可执行 type）；
 *   2) 逐块算 sha256-base64（CSP 规范：对 script 文本原文，零裁剪）；
 *   3) 写入 functions/api/_csp-hashes.js（INLINE_SCRIPT_HASHES + 组装函数，
 *      供 _json.js 运行时 import——_headers 对 Pages Functions 无效，故 API 侧
 *      必须自己发同一套头）；
 *   4) 用同一组装函数重写 _headers 的 CSP 行（静态侧单一真源）；
 *   5) --check：漂移守卫（HTML 变了但没重新生成 → 非零退出）。
 *
 * 灰度语义：script-src 同时保留 'unsafe-inline' 与全部 hash。CSP3 浏览器见
 * hash 即忽略 'unsafe-inline'（只放行哈希命中块）；旧浏览器不识 hash、回退
 * 'unsafe-inline'。任一行内联脚本漏哈希 → 现代浏览器直接拦截，故 --check
 * 必须常驻 CI（tests/csp-hashes.test.mjs）。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const CSP_BASE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const HASHES_PATH = path.join(root, "functions/api/_csp-hashes.js");
const HEADERS_PATH = path.join(root, "_headers");

/** 递归收集全部 *.html（排除 node_modules 与 coverage/ 本地度量产物） */
function collectHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "coverage") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectHtml(p, out);
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** 不可执行 script type（数据岛/模板，浏览器不执行，CSP script-src 不覆盖） */
const NON_EXEC_TYPES = new Set([
  "application/json", "text/html", "text/template", "text/plain",
  "importmap", "speculationrules", "application/ld+json",
]);

/** 抽取可执行内联 script 块文本（与浏览器解析一致：遇第一个 </script> 即止） */
function extractInlineScripts(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // 外部脚本：script-src 'self' 已覆盖
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([\w/+.-]+)/i);
    if (typeMatch && NON_EXEC_TYPES.has(typeMatch[1].toLowerCase())) continue;
    blocks.push(m[2]);
  }
  return blocks;
}

/** sha256-base64 → CSP hash source */
const cspHash = (text) =>
  "'sha256-" + createHash("sha256").update(text, "utf8").digest("base64") + "'";

const files = collectHtml(root).sort();
const perFile = [];
const all = new Set();
for (const f of files) {
  const rel = path.relative(root, f).replace(/\\/g, "/");
  const blocks = extractInlineScripts(readFileSync(f, "utf8"));
  const hashes = blocks.map(cspHash);
  for (const h of hashes) all.add(h);
  if (hashes.length) perFile.push({ rel, count: hashes.length });
}
const HASHES = [...all].sort();

/** 组装 CSP：与 _json.js 运行时、_headers 静态行共用同一函数（单一真源） */
const composeCsp = (base, hashes) =>
  base.replace("script-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'" + (hashes.length ? " " + hashes.join(" ") : ""));

const MODULE_SRC = `/**
 * 智配One · CSP 内联脚本哈希表（P1-7b，由 scripts/csp-hashes.mjs 生成，勿手改）
 * ------------------------------------------------------------------
 * 生成方式：node scripts/csp-hashes.mjs（改任何 HTML 内联脚本后必须重跑；
 * 漂移由 tests/csp-hashes.test.mjs 常驻守卫）。
 * 覆盖：${perFile.length} 个文件 / ${HASHES.length} 段可执行内联脚本。
 * _headers 对 Pages Functions 响应无效 → API 侧（_json.js）import 本表组装 CSP。
 */
export const INLINE_SCRIPT_HASHES = [
${HASHES.map((h) => "  " + JSON.stringify(h) + ",").join("\n")}
];

/** 把哈希表注入基础 CSP 的 script-src（'unsafe-inline' 保留作旧浏览器回退） */
export const cspWithInlineHashes = (base) =>
  base.replace(
    "script-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'" +
      (INLINE_SCRIPT_HASHES.length ? " " + INLINE_SCRIPT_HASHES.join(" ") : "")
  );
`;

if (CHECK) {
  const current = readFileSync(HASHES_PATH, "utf8");
  if (current !== MODULE_SRC) {
    console.error("✗ _csp-hashes.js 与当前 HTML 不一致（HTML 内联脚本已变，请跑 node scripts/csp-hashes.mjs）");
    process.exit(1);
  }
  // _headers 的 CSP 行也必须与组装结果一致
  const headers = readFileSync(HEADERS_PATH, "utf8");
  const want = composeCsp(CSP_BASE, HASHES);
  const line = headers.split(/\r?\n/).find((l) => /content-security-policy/i.test(l));
  if (!line || !line.includes(want)) {
    console.error("✗ _headers 的 CSP 行与哈希组装结果不一致（请跑 node scripts/csp-hashes.mjs）");
    process.exit(1);
  }
  console.log(`csp-hashes --check：一致（${HASHES.length} 段哈希 / ${perFile.length} 个文件）`);
} else {
  writeFileSync(HASHES_PATH, MODULE_SRC);
  // 重写 _headers：仅替换 CSP 行，其余头逐字不动
  const headers = readFileSync(HEADERS_PATH, "utf8");
  const want = "  Content-Security-Policy: " + composeCsp(CSP_BASE, HASHES);
  const lines = headers.split(/\r?\n/);
  const idx = lines.findIndex((l) => /content-security-policy/i.test(l));
  if (idx < 0) throw new Error("_headers 中找不到 Content-Security-Policy 行");
  const old = lines[idx];
  lines[idx] = want;
  writeFileSync(HEADERS_PATH, lines.join("\n"));
  console.log(`已写入 ${path.relative(root, HASHES_PATH)}：${HASHES.length} 段哈希`);
  console.log(`已更新 _headers CSP 行：${old.trim().slice(0, 60)}… → ${HASHES.length} hash sources`);
  for (const p of perFile) console.log(`  ${p.rel}: ${p.count} 段`);
}
