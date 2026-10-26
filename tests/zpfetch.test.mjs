/**
 * zpFetch 全站接入守卫（P1-8，node tests/zpfetch.test.mjs）
 * -----------------------------------------------------------
 * 守护 P1-8 的接入结果：把历史/订单/首页等页面的只读 GET 请求迁到
 * 带重试退避的 window.zpFetch（P0-8 实现），写操作（POST/DELETE，含
 * 登录/注册/退出/删除/确认/上传流）保持原生 fetch，严守「POST 默认不重试」
 * 的纪律，避免弱网重放造成重复提交。
 *
 * 守卫验证：
 *   1) 所有相关页面都已加载 /js/fetch-retry.js（window.zpFetch 的来源）；
 *   2) 各模块的只读 GET 端点确实走 zpFetch（含 pwa.js 版本守卫的防御式回退）；
 *   3) 写操作仍为原生 fetch（纪律未被破坏）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${root}${rel}`, "utf8");

// ---------- 1) 相关页面均加载 fetch-retry.js ----------
const PAGES = [
  "home.html",
  "pages/history.html",
  "pages/order_detail.html",
  "pages/today.html",
  "pages/account.html",
  "pages/data.html",
  "pages/dispatch.html",
  "pages/route_apply.html",
];
for (const p of PAGES) {
  const html = read(p);
  if (p === "home.html") {
    // a4a26d96 将 fetch-retry 合并入 home.bundle.js（其余页面仍独立加载）
    assert.ok(
      read("js/home.bundle.js").includes("window.zpFetch"),
      "home.bundle.js 未包含 fetch-retry（home 页 zpFetch 来源缺失，GET 重试会失效）"
    );
  } else {
    assert.ok(
      html.includes("/js/fetch-retry.js?v="),
      `${p} 未加载 /js/fetch-retry.js（zpFetch 来源缺失，GET 重试会失效）`
    );
  }
}

// ---------- 2) 只读 GET 端点已迁到 zpFetch ----------
const getExpect = [
  ["js/history/data.js", 'zpFetch("/api/history",'],
  ["js/history/overlay.js", 'zpFetch("/api/history-trash",'],
  ["js/history/overlay.js", 'zpFetch("/api/history-export?"'],
  ["js/history/overlay.js", 'zpFetch("/api/history-lookup?'],
  ["js/home/today.js", "zpFetch(url,"],
  ["js/home/upload-process.js", 'zpFetch("/api/dispatch",'],
  ["js/home-monthly.js", 'zpFetch("/api/history?months=13",'],
  ["js/order_detail/load.js", "zpFetch(url,"],
  ["js/order_detail/load.js", "zpFetch('/api/base?routeId='"],
  // pwa.js 版本守卫：防御式 window.zpFetch || fetch，避免 fetch-retry 未就绪时拖垮守卫
  ["js/pwa.js", "window.zpFetch || fetch"],
  ["js/pwa.js", '_f("/version.json'],
];
for (const [file, needle] of getExpect) {
  const src = read(file);
  assert.ok(
    src.includes(needle),
    `${file} 的只读 GET 未走 zpFetch（缺少：${needle}）`
  );
}

// 内联 api() 包装器（account/data/route_apply/dispatch）统一迁到 zpFetch，
// 其内部 POST 因 zpFetch 纪律「POST 不重试」而安全。
const apiWrappers = [
  ["pages/account.html", "zpFetch(u,"],
  ["pages/account.html", 'zpFetch("/version.json?ts="+Date.now()'],
  ["pages/data.html", "zpFetch(u,"],
  ["pages/route_apply.html", "zpFetch(u,"],
  ["pages/dispatch.html", "zpFetch(url,"],
];
for (const [file, needle] of apiWrappers) {
  const html = read(file);
  assert.ok(
    html.includes(needle),
    `${file} 的内联请求未迁到 zpFetch（缺少：${needle}）`
  );
}

// ---------- 3) 写操作保持原生 fetch（POST 不重试纪律） ----------
const writeMustStayRaw = [
  ["js/order_detail/confirm.js", "fetch('/api/waybills/confirm',{method:'POST'"],
  ["js/home/upload-process.js", 'fetch("/api/waybills/process?stream=1",{method:"POST"'],
  ["js/login.js", 'fetch("/api/login",{method:"POST"'],
  ["js/register.js", 'fetch("/api/register",'],
  ["js/history/data.js", 'fetch("/api/history?date="'],
  ["js/order_detail/render.js", "fetch(q,{method:'DELETE'"],
];
for (const [file, raw] of writeMustStayRaw) {
  const src = read(file);
  assert.ok(src.includes(raw), `${file} 的写操作不应被改写（应是原生 fetch：${raw}）`);
  const zpVariant = raw.replace(/^fetch\(/, "zpFetch(");
  assert.ok(
    !src.includes(zpVariant),
    `${file} 的写操作被错误地迁到了 zpFetch（应保留原生 fetch：${raw}）`
  );
}

// zpFetch 来源仍在：fetch-retry.js 定义 window.zpFetch
const fr = read("js/fetch-retry.js");
assert.ok(
  fr.includes("window.zpFetch = api") || fr.includes("window.zpFetch="),
  "js/fetch-retry.js 未定义 window.zpFetch"
);

console.log(
  "zpFetch 全站接入守卫：通过（8 页面已加载 fetch-retry.js · 只读 GET 全部迁 zpFetch · 写操作仍为原生 fetch）"
);
