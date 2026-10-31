import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = globalThis;
globalThis.location = { href: "https://example.test/index.html", origin: "https://example.test" };
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true, connection: null },
  configurable: true
});

let calls = [];
let responder = null;
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  return responder ? responder(calls.length, url, options) : new Response("{}", { status: 200 });
};
await import(pathToFileURL(path.join(root, "js/login-session-retry.js")).href + "?login-probe-test");

const reset = (fn) => { calls = []; responder = fn; };

test("登录自动会话探测：瞬时 503 后重试一次并成功", async () => {
  reset((n) => new Response("{}", { status: n === 1 ? 503 : 200 }));
  const response = await window.fetch("/api/me?autoMe=123", { credentials: "same-origin", cache: "no-store" });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === undefined || call.options.method === "GET"));
});

test("明确认证失败 401 不重试", async () => {
  reset(() => new Response("{}", { status: 401 }));
  const response = await window.fetch("/api/me?autoMe=123", { credentials: "same-origin" });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});

test("只拦截同源自动会话 GET；手动登录 POST 不重试", async () => {
  reset(() => new Response("{}", { status: 503 }));
  await window.fetch("/api/login", { method: "POST", body: "{}" });
  assert.equal(calls.length, 1, "手动登录 POST 只发送一次");
  assert.equal(calls[0].options.method, "POST");

  reset(() => new Response("{}", { status: 503 }));
  await window.fetch("/api/me", { credentials: "same-origin" });
  assert.equal(calls.length, 1, "不带 autoMe 的其他资料请求不被拦截");

  reset(() => new Response("{}", { status: 503 }));
  await window.fetch("https://other.example/api/me?autoMe=123");
  assert.equal(calls.length, 1, "跨域请求不被拦截");
});

test("自动会话探测网络错误后只重试一次", async () => {
  reset((n) => {
    if (n === 1) throw new TypeError("Failed to fetch");
    return new Response("{}", { status: 200 });
  });
  const response = await window.fetch("/api/me?autoMe=123");
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
});

test("省流量模式不额外重试", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true, connection: { saveData: true } },
    configurable: true
  });
  reset(() => new Response("{}", { status: 503 }));
  const response = await window.fetch("/api/me?autoMe=123");
  assert.equal(response.status, 503);
  assert.equal(calls.length, 1);
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true, connection: null },
    configurable: true
  });
});
