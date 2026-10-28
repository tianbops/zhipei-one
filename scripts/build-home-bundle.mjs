#!/usr/bin/env node
/**
 * build-home-bundle.mjs —— 首页资源 bundle 构建器（JS + CSS）
 *
 * 背景：js/home.bundle.js 与 css/home.bundle.css 原为“手工拼接”的部署产物，
 * 没有构建来源。结果：改 js/home-monthly.js 等源文件**不生效**（页面只加载 bundle），
 * 源与产物极易漂移（历史上 esc() 就出现了源/产物两份、其中一份带 bug 的情况）。
 *
 * 本脚本把“拼接顺序”固化为代码，`--check` 可校验产物是否与源同步（CI 守卫）。
 *
 * 用法：
 *   node scripts/build-home-bundle.mjs           # 重建两个 bundle 并同步 ?v= 引用
 *   node scripts/build-home-bundle.mjs --check   # 只校验，不一致则退出码 1（不改文件）
 *
 * 顺序约定（与历史产物逐字节一致，勿随意调序——CSS 层叠 / JS 执行顺序会变）：
 *   - JS：\n;\n 连接；home-monthly 之后插入 scripts/home-bundle-glue.frag
 *         （todayDate 格式化 + 退出登录，仅在 bundle 内的内联胶水）
 *   - CSS：\n 连接
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const rd = (p) => readFileSync(resolve(ROOT, p), "utf8");

const JS_SOURCES = [
  "js/fetch-retry.js",
  "js/offline-queue.js",
  "js/home/core.js",
  "js/home/fit.js",
  "js/home/upload-progress.js",
  "js/home/upload-error.js",
  "js/home/upload-sheet.js",
  "js/home/upload-process.js",
  "js/home/today.js",
  "js/home/back.js",
  "js/home-monthly.js",
  "scripts/home-bundle-glue.frag",
  "js/ui/core.js",
  "js/ui/appearance.js",
  "js/ui/feedback.js",
  "js/ui/nav.js",
  "js/ui/back.js",
  "js/ui/nav-prefetch.js",
  "js/pwa.js",
];

const CSS_SOURCES = [
  "css/app.css",
  "css/ui-base.css",
  "css/ui-overlay.css",
  "css/ui-theme.css",
  "css/ui-shell.css",
  "css/home-base.css",
  "css/home-trend.css",
  "css/home-dashboard.css",
  "css/home-light.css",
];

/** 仅返回构建结果，不触碰磁盘（供测试复用）。 */
export function buildOutputs() {
  return {
    js: JS_SOURCES.map(rd).join("\n;\n"),
    css: CSS_SOURCES.map(rd).join("\n"),
  };
}

const md5_8 = (s) => createHash("md5").update(s).digest("hex").slice(0, 8);
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
};
const bumpRef = (file, asset, hash) => {
  let s = rd(file);
  const re = new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\?v=[a-f0-9]+", "g");
  const next = s.replace(re, asset + "?v=" + hash);
  if (next !== s) writeFileSync(resolve(ROOT, file), next);
  return next !== s;
};

// 仅在被直接执行时跑 CLI；被测试 import 时不产生副作用
const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) {
  const check = process.argv.includes("--check");
  const { js, css } = buildOutputs();
  const curJs = rd("js/home.bundle.js");
  const curCss = rd("css/home.bundle.css");

  if (check) {
    let ok = true;
    if (js !== curJs) {
      ok = false;
      console.error(`❌ js/home.bundle.js 与源文件不一致（首个差异 @${firstDiff(js, curJs)}）。请运行 node scripts/build-home-bundle.mjs`);
    }
    if (css !== curCss) {
      ok = false;
      console.error(`❌ css/home.bundle.css 与源文件不一致（首个差异 @${firstDiff(css, curCss)}）。请运行 node scripts/build-home-bundle.mjs`);
    }
    if (ok) console.log("✅ home.bundle.(js|css) 与源文件一致");
    process.exit(ok ? 0 : 1);
  }

  writeFileSync(resolve(ROOT, "js/home.bundle.js"), js);
  writeFileSync(resolve(ROOT, "css/home.bundle.css"), css);
  const jh = md5_8(js), ch = md5_8(css);
  console.log(`已重建 js/home.bundle.js (${jh}) | css/home.bundle.css (${ch})`);
  for (const f of ["home.html", "sw.js"]) {
    bumpRef(f, "/js/home.bundle.js", jh);
    bumpRef(f, "/css/home.bundle.css", ch);
  }
  console.log("已同步 home.html / sw.js 的 ?v= 引用");
}
