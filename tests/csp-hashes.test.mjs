/**
 * CSP hash-based 灰度守卫（P1-7b）
 * ------------------------------------------------------------------
 * 背景：docs/CSP-hardening.md 结论——nonce 化在 CF Pages 静态托管不可行，
 * 去 'unsafe-inline' 走 hash-based CSP。scripts/csp-hashes.mjs 从全部 HTML
 * 实算内联脚本 sha256，写入 functions/api/_csp-hashes.js 与 _headers CSP 行；
 * _json.js（API 侧，_headers 对 Functions 无效）运行时 import 同一张表组装。
 *
 * 本守卫钉死：
 *   1. 漂移：HTML 内联脚本已变但未重跑生成器 → --check 必须失败；
 *   2. 三处一致：_headers CSP 行 ≡ _csp-hashes.js 表 ≡ _json.js 运行时值；
 *   3. 灰度形态：script-src 同时含 'unsafe-inline'（旧浏览器回退）与全部 hash；
 *   4. 防回归：任何 HTML 不得再出现内联事件属性（hash 生效后它会被拦停）；
 *      js/ 与内联脚本中不得出现 eval(/new Function(（hash-based 的硬阻断）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);

test("漂移守卫：HTML 内联脚本与 _csp-hashes.js / _headers 一致（--check）", () => {
  const out = execFileSync(process.execPath, [path.join(root, "scripts/csp-hashes.mjs"), "--check"], {
    cwd: root, encoding: "utf8",
  });
  assert.match(out, /一致（\d+ 段哈希/);
});

test("灰度形态：script-src 含 'unsafe-inline'（旧浏览器回退）+ 全部 sha256 hash", async () => {
  const { INLINE_SCRIPT_HASHES } = await imp("functions/api/_csp-hashes.js");
  assert.ok(INLINE_SCRIPT_HASHES.length >= 15, `哈希段数异常少：${INLINE_SCRIPT_HASHES.length}`);
  for (const h of INLINE_SCRIPT_HASHES) {
    assert.match(h, /^'sha256-[A-Za-z0-9+/]+={0,2}'$/, `非法 CSP hash：${h}`);
  }
  // _headers 静态侧
  const headers = fs.readFileSync(path.join(root, "_headers"), "utf8");
  const cspLine = headers.split(/\r?\n/).find((l) => /content-security-policy/i.test(l));
  assert.ok(cspLine, "_headers 必须有 CSP 行");
  assert.ok(cspLine.includes("'unsafe-inline'"), "script-src 必须保留 'unsafe-inline' 回退");
  for (const h of INLINE_SCRIPT_HASHES) assert.ok(cspLine.includes(h), `_headers 缺少 hash：${h}`);
  // API 侧（_headers 对 Pages Functions 无效，必须自己发）
  const { SECURITY_HEADERS } = await imp("functions/api/_json.js");
  const apiCsp = SECURITY_HEADERS["content-security-policy"];
  for (const h of INLINE_SCRIPT_HASHES) assert.ok(apiCsp.includes(h), `API 侧 CSP 缺少 hash：${h}`);
  // 两边逐字节一致（security-headers.test.mjs 亦断言此条，双保险）
  const m = cspLine.match(/Content-Security-Policy:\s*(.+)$/i);
  assert.strictEqual(apiCsp, m[1].trim(), "_headers 与 _json.js 的 CSP 值不一致");
});

test("防回归：全仓库 HTML 无内联事件属性（hash 生效后会被拦停）", () => {
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith(".html")) out.push(p);
    }
    return out;
  };
  const bad = [];
  for (const f of walk(root)) {
    const html = fs.readFileSync(f, "utf8");
    // 只查 HTML 属性位：<tag ... onX=...>（脚本内的 el.onclick= 赋值不受影响）
    const re = /<[a-zA-Z][^>]*?\son(click|input|change|submit|load|keydown|keyup|blur|focus|error)\s*=/gi;
    if (re.test(html)) bad.push(path.relative(root, f).replace(/\\/g, "/"));
  }
  assert.deepStrictEqual(bad, [], "这些文件仍含内联事件属性，hash 生效后会被拦停");
});

test("防回归：js/ 与内联脚本无 eval(/new Function(（hash-based 硬阻断）", () => {
  const hits = [];
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|html)$/.test(name) && !p.includes(path.sep + "tests" + path.sep)) out.push(p);
    }
    return out;
  };
  for (const f of [...walk(path.join(root, "js")), ...walk(path.join(root, "functions"))]) {
    const src = fs.readFileSync(f, "utf8");
    if (/\beval\s*\(|\bnew Function\s*\(/.test(src)) hits.push(path.relative(root, f).replace(/\\/g, "/"));
  }
  // tests/ 下的 new Function 是测试基建（镜像源码求值），不属生产路径
  assert.deepStrictEqual(hits, [], "生产代码出现 eval/new Function，hash-based CSP 不成立");
});

console.log("✅ CSP hash-based 灰度守卫通过");
