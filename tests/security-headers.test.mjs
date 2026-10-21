/**
 * 安全响应头守门测试（P0-5）
 * ------------------------------------------------------------------
 * 被测问题：全站此前**一个安全响应头都没有**（CSP / X-Frame-Options /
 * X-Content-Type-Options / HSTS 在 _headers 里命中数为 0）。
 *
 * 这里钉死四条，任何一条被改回去都会在这里失败：
 *   1. 静态侧 _headers 的 /* 块必须发出全套安全头；
 *   2. **该块绝不能出现 Cache-Control**——CF 对同名头是"逗号拼接"，
 *      一旦写了缓存值，下面逐条校准过的 no-store / immutable / max-age=120 会被污染；
 *   3. API 侧必须自己发同一套头（Pages 的 _headers 对 Functions 响应无效，
 *      而口令与会话恰恰都在 API 侧）——这是最容易漏掉的一半；
 *   4. 两边的取值必须一致，避免一处更新一处忘。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const raw = fs.readFileSync(path.join(root, "_headers"), "utf8");

/** 极简 _headers 解析：非缩进且非注释的行是路径，随后的缩进行是它的头 */
function parseHeaders(text) {
  const blocks = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      current = line.trim();
      if (!blocks.has(current)) blocks.set(current, new Map());
    } else if (current) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      blocks.get(current).set(name, line.slice(idx + 1).trim());
    }
  }
  return blocks;
}
const blocks = parseHeaders(raw);
const imp = p => import(pathToFileURL(path.join(root, p)).href);

test("静态侧：/* 通配块发出全套安全头", () => {
  const b = blocks.get("/*");
  assert.ok(b, "_headers 里必须存在 /* 通配块（安全头要覆盖全站）");
  for (const name of ["x-content-type-options", "referrer-policy", "x-frame-options",
    "permissions-policy", "content-security-policy", "strict-transport-security"]) {
    assert.ok(b.has(name), `/* 块缺少 ${name}`);
  }
  assert.equal(b.get("x-content-type-options"), "nosniff");
  assert.equal(b.get("x-frame-options"), "DENY");
  assert.match(b.get("strict-transport-security"), /max-age=\d+/);
});

test("静态侧：/* 块绝不能出现 Cache-Control（会污染逐条校准的缓存策略）", () => {
  const b = blocks.get("/*");
  assert.ok(b);
  assert.equal(b.has("cache-control"), false,
    "/* 块一旦写 Cache-Control，CF 会用逗号把它拼到各具体路由的缓存值上，全站缓存策略失效");
});

test("静态侧：CSP 的关键约束没被改松", () => {
  const csp = blocks.get("/*").get("content-security-policy");
  assert.match(csp, /connect-src\s+'self'/, "connect-src 'self' 是本期 CSP 的核心：XSS 也偷不走数据到第三方");
  assert.match(csp, /frame-ancestors\s+'none'/, "frame-ancestors 'none'：反点击劫持");
  assert.match(csp, /object-src\s+'none'/, "object-src 'none'：关掉插件类入口");
  assert.match(csp, /base-uri\s+'self'/, "base-uri 'self'：防 <base> 劫持相对路径");
  assert.match(csp, /form-action\s+'self'/, "form-action 'self'：防表单外发");
  // 'unsafe-inline' 是现状妥协（全站每页 2~3 段内联 script + 大量内联事件属性），
  // 去掉会白屏；这里记录它**存在**，是为了让"将来 nonce 化后忘了删"这件事能被发现。
  assert.match(csp, /script-src[^;]*'unsafe-inline'/, "内联脚本现状（P1 再 nonce 化）");
});

test("API 侧：json() 与 guard() 都带上同一套安全头", async () => {
  const { SECURITY_HEADERS, json } = await imp("functions/api/_json.js");
  assert.ok(SECURITY_HEADERS && Object.keys(SECURITY_HEADERS).length >= 6);

  const res = json({ success: true }, 200);
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.equal(res.headers.get(name), SECURITY_HEADERS[name], `json() 响应缺少 ${name}`);
  }

  // 裸 new Response（登录成功那种）由 _safe.js 的 guard 兜住 —— 这是唯一能覆盖它们的公共出口
  const { guard } = await imp("functions/api/_safe.js");
  const wrapped = await guard(async () => new Response("ok", { status: 200 }))({});
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.equal(wrapped.headers.get(name), SECURITY_HEADERS[name], `guard() 响应缺少 ${name}`);
  }
});

test("API 侧：安全头不覆盖业务头（set-cookie / content-type 必须原样保留）", async () => {
  const { json } = await imp("functions/api/_json.js");
  const res = json({ success: true, m: "x" }, 200, { "set-cookie": "zp_session=abc; Path=/; HttpOnly" });
  assert.equal(res.headers.get("set-cookie"), "zp_session=abc; Path=/; HttpOnly", "会话 Cookie 不能被安全头冲掉");
  assert.match(res.headers.get("content-type"), /application\/json/, "content-type 必须保留");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", "安全头仍然生效");
});

test("两侧一致：_headers 的 /* 块与 _json.js 的 SECURITY_HEADERS 取值相同", async () => {
  const { SECURITY_HEADERS } = await imp("functions/api/_json.js");
  const b = blocks.get("/*");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(b.get(name), value,
      `_headers 与 _json.js 的 ${name} 不一致（Pages 的 _headers 对 Functions 无效，两边必须手同步）`);
  }
});

test("限流的 Retry-After 能随响应带出（json 的第三参数通道可用）", async () => {
  const { json } = await imp("functions/api/_json.js");
  const res = json({ success: false, error: "频繁" }, 429, { "retry-after": "120" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "120", "客户端靠它决定等多久再试");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});
