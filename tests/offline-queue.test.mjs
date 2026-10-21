/**
 * 离线重取队列守卫（P1-4 首个增量，node tests/offline-queue.test.mjs）
 * -----------------------------------------------------------
 * js/offline-queue.js：当前离线时登记「幂等 GET 刷新」，网络恢复（online /
 * 回前台）时按 key 去重自动重放；写操作不纳入（与 zpFetch「POST 不重试」一致）。
 * 守卫：
 *   1) 模块存在，且 history.html / home.html 均加载它；
 *   2) history/data.js 已在离线失败时接线 scheduleRefresh("history", load)；
 *   3) 行为等价（node:vm 伪造 window/navigator/document）：
 *      离线下登记不立即执行 → 重连后重放一次 → 队列清空；同 key 去重只放一次。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));

// 1) 模块 + 页面加载
assert.ok(existsSync(`${root}js/offline-queue.js`), "缺少 js/offline-queue.js");
for (const p of ["pages/history.html", "home.html"]) {
  const html = readFileSync(`${root}${p}`, "utf8");
  assert.ok(html.includes("/js/offline-queue.js?v="), `${p} 未加载 offline-queue.js`);
}

// 2) history 接线
const data = readFileSync(`${root}js/history/data.js`, "utf8");
assert.ok(
  data.includes('window.zpOfflineQueue.scheduleRefresh("history"'),
  "history/data.js 未在离线失败时接线 scheduleRefresh"
);

// 3) 行为等价：伪造 DOM 跑真实脚本
const src = readFileSync(`${root}js/offline-queue.js`, "utf8");
function makeCtx() {
  const listeners = {};
  const win = { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  const doc = {
    visibilityState: "visible",
    addEventListener: (t, fn) => { (listeners["doc:" + t] = listeners["doc:" + t] || []).push(fn); },
  };
  let online = true;
  const nav = { get onLine() { return online; } };
  const sandbox = { window: win, document: doc, navigator: nav, Map, Array, Promise, String, Number };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    win,
    setOnline: (v) => { online = v; },
    fire: (t) => { (listeners[t] || []).forEach((fn) => fn()); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// 3a) 离线登记 → 不立即执行 → 重连重放一次 → 清空
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  let ran = 0;
  ctx.win.zpOfflineQueue.scheduleRefresh("history", () => { ran++; });
  assert.equal(ctx.win.zpOfflineQueue.size(), 1, "离线下应登记 1 项");
  assert.equal(ran, 0, "离线下不得立即执行");
  ctx.setOnline(true);
  ctx.fire("online");
  await tick();
  assert.equal(ran, 1, "重连后应重放 1 次");
  assert.equal(ctx.win.zpOfflineQueue.size(), 0, "重放后队列应清空");
}

// 3b) 同 key 去重：登记两次只重放一次
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  let ran = 0;
  ctx.win.zpOfflineQueue.scheduleRefresh("history", () => { ran++; });
  ctx.win.zpOfflineQueue.scheduleRefresh("history", () => { ran++; });
  assert.equal(ctx.win.zpOfflineQueue.size(), 1, "同 key 应去重为 1 项");
  ctx.setOnline(true);
  ctx.fire("online");
  await tick();
  assert.equal(ran, 1, "同 key 去重后只重放 1 次");
}

// 3c) 已在线时登记：立即重放（竞态兜底）
{
  const ctx = makeCtx();
  let ran = 0;
  ctx.win.zpOfflineQueue.scheduleRefresh("history", () => { ran++; });
  await tick();
  assert.equal(ran, 1, "在线时登记应立即重放");
}

console.log("离线重取队列守卫：通过（模块/双页加载/history 接线 · 离线登记→重连重放→去重·行为正确）");
