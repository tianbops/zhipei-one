/**
 * 离线重取/重写队列守卫（P1-4 首个增量 + P1-4b 写操作，node tests/offline-queue.test.mjs）
 * -----------------------------------------------------------
 * js/offline-queue.js：
 *   · 读：当前离线时登记「幂等 GET 刷新」，网络恢复（online / 回前台）按 key
 *     去重自动重放（原语义不变）；
 *   · 写（P1-4b）：无网时登记「幂等写操作」（history 按日期/月份 DELETE），
 *     重连后**先串行重放写、再重放读**。重放器约定：true=完成出队 /
 *     false=暂时性失败保留下次 / throw=业务性失败出队并 warn。
 * 守卫：
 *   1) 模块存在，且 history.html / home.html 均加载它；
 *   2) history/data.js 接线：GET 失败 scheduleRefresh；DELETE 网络层失败
 *      scheduleWrite（幂等重放器 + offlineQueued 错误标记）；
 *   3) 行为等价（node:vm 伪造 window/navigator/document）：
 *      读：离线登记→重连重放→去重；写：串行重放 / 失败保留 / throw 出队 /
 *      先写后读顺序。
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

// 2) history 接线（读 + 写）
const data = readFileSync(`${root}js/history/data.js`, "utf8");
assert.ok(
  data.includes('window.zpOfflineQueue.scheduleRefresh("history"'),
  "history/data.js 未在离线失败时接线 scheduleRefresh"
);
assert.ok(
  data.includes('window.zpOfflineQueue.scheduleWrite("history:delete:date:"'),
  "history/data.js 未接线写操作登记（scheduleWrite date）"
);
assert.ok(
  data.includes('window.zpOfflineQueue.scheduleWrite("history:delete:month:"'),
  "history/data.js 未接线写操作登记（scheduleWrite month）"
);
assert.ok(
  data.includes("offlineQueued:true"),
  "history/data.js 未给离线登记的错误打 offlineQueued 标记"
);
const overlay = readFileSync(`${root}js/history/overlay.js`, "utf8");
assert.ok(
  overlay.includes("e?.offlineQueued"),
  "history/overlay.js 未处理 offlineQueued（应关弹窗 + toast 告知已登记）"
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
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    win,
    setOnline: (v) => { online = v; },
    fire: (t) => { (listeners[t] || []).forEach((fn) => fn()); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// 注意：flush 先清空队列再执行任务，故不能用 size() 判空闲，只能轮询业务谓词
const waitFor = async (pred, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error("等待超时");
};

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

// 3d) 写：离线登记 → 重连串行重放（顺序执行、一条完成才下一条）→ 成功出队
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  const order = [];
  let active = 0, maxActive = 0;
  const mk = (name) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    order.push(name + ":start");
    await tick(); await tick();
    order.push(name + ":end");
    active--;
    return true;
  };
  ctx.win.zpOfflineQueue.scheduleWrite("w:1", mk("w1"));
  ctx.win.zpOfflineQueue.scheduleWrite("w:2", mk("w2"));
  assert.equal(ctx.win.zpOfflineQueue.writeSize(), 2, "离线下应登记 2 项写");
  ctx.setOnline(true);
  ctx.fire("online");
  await waitFor(() => order.length === 4);
  assert.deepStrictEqual(order, ["w1:start", "w1:end", "w2:start", "w2:end"], "写操作必须串行重放");
  assert.equal(maxActive, 1, "任一时刻只允许一条写操作在执行");
  assert.equal(ctx.win.zpOfflineQueue.writeSize(), 0, "成功的写操作应出队");
}

// 3e) 写：暂时性失败（返回 false）→ 保留，下次重连再试
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  let attempts = 0;
  ctx.win.zpOfflineQueue.scheduleWrite("w:retry", async () => { attempts++; return false; });
  ctx.setOnline(true);
  ctx.fire("online");
  await tick();
  assert.equal(attempts, 1, "首次重连应尝试 1 次");
  assert.equal(ctx.win.zpOfflineQueue.writeSize(), 1, "暂时性失败应保留在队");
  ctx.fire("online");
  await tick();
  assert.equal(attempts, 2, "再次重连应重试");
}

// 3f) 写：业务性失败（throw）→ 出队，不无限重试
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  let attempts = 0;
  ctx.win.zpOfflineQueue.scheduleWrite("w:drop", async () => { attempts++; throw new Error("403 无权限"); });
  ctx.setOnline(true);
  ctx.fire("online");
  await tick();
  assert.equal(attempts, 1, "业务性失败应只尝试 1 次");
  assert.equal(ctx.win.zpOfflineQueue.writeSize(), 0, "业务性失败应出队（重试无意义）");
}

// 3g) 先写后读：重连时写操作先于读刷新执行
{
  const ctx = makeCtx();
  ctx.setOnline(false);
  const order = [];
  ctx.win.zpOfflineQueue.scheduleWrite("w", async () => { order.push("write"); return true; });
  ctx.win.zpOfflineQueue.scheduleRefresh("r", () => { order.push("read"); });
  ctx.setOnline(true);
  ctx.fire("online");
  await tick();
  assert.deepStrictEqual(order, ["write", "read"], "必须先落定业务数据再刷新展示");
}

console.log("离线重取/重写队列守卫：通过（模块/双页加载/读+写接线 · 读去重 · 写串行/失败保留/throw 出队/先写后读）");
