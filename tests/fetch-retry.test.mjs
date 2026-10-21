/**
 * 前端请求重试守门测试（P0-8）
 * ------------------------------------------------------------------
 * 被测问题：此前前端**没有任何自动重试**（js/*.js 里 `backoff` 命中数 0），
 * 失败一律抛给用户点按钮。而这条链路的实测特征是分钟级 10 倍抖动——
 * 大量失败是瞬时的，下一秒再打一次就成。
 *
 * 这里钉死三条纪律，改任何一条都会在这里失败：
 *   1. POST 默认不重试（运单提交重放一次就是一次重复业务）；
 *   2. 只重试 网络错误/超时/429/5xx，其它 4xx 不重试（重试一万次也是同一个错）；
 *   3. 弱网（saveData / 2g）减免重试，不替用户吃掉流量。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const FILE = path.join(root, "js/fetch-retry.js");

globalThis.window = globalThis;

let calls = [];
let responder = null;
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts });
  // 桩必须尊重 AbortSignal，否则"超时/取消"根本测不出来（真实 fetch 被 abort 时会 reject）
  return responder ? responder(calls.length, opts) : new Response("{}", { status: 200 });
};
function setNetwork(conn) {
  Object.defineProperty(globalThis, "navigator", { value: { connection: conn }, configurable: true });
}

await import(pathToFileURL(FILE).href);
const zpFetch = globalThis.window.zpFetch;
const reset = (fn) => { calls = []; responder = fn; setNetwork(null); };

test("GET + 5xx：按指数退避重试，重试耗尽后返回最后一次响应", async () => {
  reset(() => new Response("{}", { status: 503 }));
  const t0 = Date.now();
  const res = await zpFetch("/api/x", { credentials: "same-origin" }, { retries: 2 });
  assert.equal(res.status, 503, "耗尽后返回最后的 5xx 响应，由调用方按业务处理");
  assert.equal(calls.length, 3, "1 次首发 + 2 次重试");
  assert.ok(Date.now() - t0 >= 1000, `退避确实发生了（约 400+800ms，实测 ${Date.now() - t0}ms）`);
});

test("GET + 首次失败第二次成功：不会继续浪费第三次", async () => {
  reset(n => new Response("{}", { status: n === 1 ? 500 : 200 }));
  const res = await zpFetch("/api/x", {}, { retries: 2 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2, "第二次成功即停，不多打");
});

test("纪律2：4xx（401/403/409）一律不重试", async () => {
  for (const status of [401, 403, 404, 409]) {
    reset(() => new Response("{}", { status }));
    await zpFetch("/api/x", {}, { retries: 2 });
    assert.equal(calls.length, 1, `${status} 重试一万次也是同一个错，不该重试`);
  }
});

test("纪律2：网络中断（fetch 抛错）才重试", async () => {
  reset(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(() => zpFetch("/api/x", {}, { retries: 1 }));
  assert.equal(calls.length, 2, "网络错误：1 次首发 + 1 次重试");
});

test("429：尊重服务端 Retry-After（服务端刚上了登录/注册限流，会带这个头）", async () => {
  reset(() => new Response("{}", { status: 429, headers: { "retry-after": "1" } }));
  const t0 = Date.now();
  await zpFetch("/api/x", {}, { retries: 1 });
  const elapsed = Date.now() - t0;
  assert.equal(calls.length, 2, "限流应当重试");
  assert.ok(elapsed >= 950, `必须真的等到 Retry-After 说的 1s（实测 ${elapsed}ms）`);
});

test("纪律1：POST 默认绝不重试（防重复提交）", async () => {
  reset(() => new Response("{}", { status: 500 }));
  await zpFetch("/api/waybills/process", { method: "POST", body: "x" }, { retries: 2 });
  assert.equal(calls.length, 1, "POST 重放一次就是一次重复业务，默认必须不重试");

  reset(() => new Response("{}", { status: 500 }));
  await zpFetch("/api/x", { method: "POST", body: "x", zpIdempotent: true }, { retries: 2 });
  assert.equal(calls.length, 3, "显式声明幂等的写操作才允许重试");
});

test("纪律3：弱网减免重试", async () => {
  reset(() => new Response("{}", { status: 503 }));
  setNetwork({ saveData: true });
  await zpFetch("/api/x", {}, { retries: 2 });
  assert.equal(calls.length, 1, "省流量模式：用户明确要省流量，一次都不重试");

  reset(() => new Response("{}", { status: 503 }));
  setNetwork({ effectiveType: "2g" });
  await zpFetch("/api/x", {}, { retries: 2 });
  assert.equal(calls.length, 2, "2g/slow-2g：只重试一次，别把本来就窄的管道灌两遍");
  setNetwork(null);
});

test("调用方主动取消（页面跳转）时不重试，且立即抛 AbortError", async () => {
  reset(async () => { await new Promise(r => setTimeout(r, 50)); return new Response("{}", { status: 500 }); });
  const controller = new AbortController();
  const p = zpFetch("/api/x", { signal: controller.signal }, { retries: 2, timeoutMs: 0 });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p, e => e.name === "AbortError", "调用方取消必须原样抛 AbortError");
  assert.equal(calls.length, 1, "取消后不得再打");
});

test("超时即中止（默认 12s 兜底在 cfg 里可调）", async () => {
  reset(async (n, opts) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      });
    });
    return new Response("{}", { status: 200 });
  });
  await assert.rejects(() => zpFetch("/api/x", {}, { retries: 0, timeoutMs: 60 }), e => e.name === "AbortError");
  assert.equal(calls.length, 1, "未配置重试时超时即抛，不再打第二次");
});
