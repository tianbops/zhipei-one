/**
 * SW 预缓存一致性回归测试
 * ------------------------------------------------------------------
 * 运行：node tests/sw-precache.test.mjs
 *
 * 背景（2026-10-18）：sw.js 的 CSS/JS 缓存是 stale-while-revalidate，
 * 缓存键 = 完整 URL（含 ?v=）。历史 PRECACHE 里 CSS/JS 不带 ?v=，
 * 与页面实际请求永远匹配不上——预缓存全是死条目；且 ?v= 值按 CRLF
 * 内容计算，全仓库 LF 规范化后 15 个引用漂移。
 *
 * 本测试强制三条不变量（配合 scripts/bump_asset_versions.py 使用）：
 *   一、HTML 中每个版本化静态引用都必须原样出现在 sw.js PRECACHE（含 ?v=）；
 *   二、每个 ?v= 值必须等于该文件内容的 md5[:8]（防止改了文件忘刷版本号，
 *       导致设备永远命中 SW 缓存里的旧资产——「间歇性旧样式」类事故）；
 *   三、PRECACHE 中每个带 ?v= 的条目必须被某个 HTML 真实引用（无死条目），
 *       且每个条目指向的文件必须存在。
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rel = p => ROOT + p;

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ---------- 收集 HTML 中的静态引用 ---------- */
const htmlFiles = [
  ...globSync(rel("*.html")),
  ...globSync(rel("pages/*.html")),
];
t("HTML 文件集合非空", htmlFiles.length >= 10, `found ${htmlFiles.length}`);

const versionedRefs = new Map();   // "/css/app.css?v=xxx" -> html 文件
const plainAssetRefs = new Set();  // "/assets/icons/apple-touch-icon.png"
const REF_RE = /(?:href|src)="(\/[^"]+)"/g;
for (const f of htmlFiles) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(REF_RE)) {
    const u = m[1];
    if (u.includes("?v=")) versionedRefs.set(u, f);
    else if (u.startsWith("/assets/")) plainAssetRefs.add(u);
  }
}

/* ---------- 提取 sw.js PRECACHE ---------- */
const sw = readFileSync(rel("sw.js"), "utf8");
const pm = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
t("sw.js 含 PRECACHE 声明", !!pm);
const precache = pm ? [...pm[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];
t("PRECACHE 无重复条目", new Set(precache).size === precache.length,
  precache.filter((u, i) => precache.indexOf(u) !== i).join(", "));
t("PRECACHE 非空", precache.length >= 20, `len=${precache.length}`);

/* ---------- 约束一：版本化引用必须进 PRECACHE ---------- */
for (const [url, from] of versionedRefs) {
  t(`PRECACHE 含 ${url}`, precache.includes(url), `被 ${from.split(/[\\/]/).pop()} 引用但缺失`);
}

/* ---------- 约束二：?v= 必须等于文件内容 md5[:8] ---------- */
const md5_8 = buf => createHash("md5").update(buf).digest("hex").slice(0, 8);
for (const [url] of versionedRefs) {
  const [path, hash] = url.split("?v=");
  const fp = rel(path.slice(1));
  if (!existsSync(fp)) { t(`文件存在 ${path}`, false); continue; }
  const actual = md5_8(readFileSync(fp));
  t(`哈希匹配 ${url}`, actual === hash, `实际 ${actual}`);
}

/* ---------- 约束三：PRECACHE 无死条目、文件均存在 ---------- */
for (const entry of precache) {
  const [path] = entry.split("?v=");
  // pretty URL：/home -> home.html；/pages/x -> pages/x.html；/ -> index.html
  const base = path === "/" ? rel("index.html") : rel(path.slice(1));
  const fp = existsSync(base) ? base
    : existsSync(base + ".html") ? base + ".html"
    : base;
  t(`PRECACHE 条目文件存在 ${entry}`, existsSync(fp), fp);
  if (entry.includes("?v=")) {
    t(`PRECACHE 版本化条目被真实引用 ${entry}`, versionedRefs.has(entry), "死条目");
  }
}

/* ---------- 图片/字体 SWR 缓存键 ---------- */
const swrMatch = sw.match(/async function swrStrategy\(req\) \{([\s\S]*?)\n\}/);
t("图片/字体缓存按完整 Request（含 ?v=）匹配", !!swrMatch && /cache\.match\(req\)/.test(swrMatch[1]));
t("图片/字体缓存按完整 Request（含 ?v=）写入", !!swrMatch && /cache\.put\(req,\s*res\.clone\(\)\)/.test(swrMatch[1]));
t("图片/字体缓存不再丢弃查询参数", !!swrMatch && !/cache\.(?:match|put)\(key/.test(swrMatch[1]));

/* ---------- SW 版本号形态 ---------- */
const vm = sw.match(/const VERSION = "(zp-pwa-\d+)";/);
t("SW VERSION 形态正确", !!vm);

/* ---------- 汇总 ---------- */
if (fail) {
  console.log(`✗ sw-precache: ${pass} passed, ${fail} FAILED`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
console.log(`✓ sw-precache: ${pass} passed（${versionedRefs.size} 个版本化引用 / ${precache.length} 条预缓存全部一致）`);
