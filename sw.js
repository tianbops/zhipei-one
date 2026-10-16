/* 智配One · Service Worker
 * ------------------------------------------------------------------
 * 设计原则：业务数据永不缓存，静态资源可离线。
 *   - /api/*         ：直接透传，绝不入缓存（登录态、运单、线路必须实时）
 *   - 非 GET 请求     ：不拦截（登录提交、运单上传）
 *   - 页面导航        ：network-first，离线回退缓存，最后回退 offline.html
 *   - CSS/JS         ：network-first（2.5s 超时回退缓存）——保证发布后
 *                      下一次刷新必见新版；有网时永不拿旧脚本
 *   - 图片/字体       ：stale-while-revalidate（内容基本不变，秒开优先）
 * 缓存 key 一律用 pathname 规整化：页面 URL 常带 ?v=时间戳（防缓存），
 * 若按完整 URL 存，每次跳转都会产生一份新副本。
 */
const VERSION = "zp-pwa-49";
const STATIC_CACHE = VERSION + "-static";
const PAGES_CACHE = VERSION + "-pages";
const OFFLINE_URL = "/offline.html";

/* 安装即预缓存：App 壳 + 司机高频页面 */
const PRECACHE = [
  "/index.html",
  OFFLINE_URL,
  "/home.html",
  "/pages/today.html",
  "/css/app.css",
  "/css/ui-unified.css",
  "/css/mobile-ui.css",
  "/css/business-pages.css",
  "/css/home.css",
  "/css/history.css",
  "/css/data.css",
  "/css/order_detail.css",
  "/js/ui-unified.js",
  "/js/login.js",
  "/js/home.js",
  "/js/history.js",
  "/js/order_detail.js",
  "/js/register.js",
  "/assets/logo.png",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png"
];

const cacheKeyOf = url => new URL(url).pathname;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // 逐个写入：任何单个资源 404 都不至于让整个安装失败
    await Promise.all(PRECACHE.map(async path => {
      try { await cache.add(new Request(path, { cache: "reload" })); } catch { /* 允许部分缺失 */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n.startsWith("zp-pwa-") && n !== STATIC_CACHE && n !== PAGES_CACHE) ? caches.delete(n) : null));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;                       // 登录 POST、运单上传：走网络
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;        // 第三方（OCR 等）不接管
  if (url.pathname.startsWith("/api/")) return;           // 业务数据：永不缓存

  const isDocument = req.mode === "navigate" ||
    (req.destination === "document") ||
    (req.headers.get("accept") || "").indexOf("text/html") > -1;

  if (isDocument) {
    /* 关键修复（2026-10-06）：在线时把导航交还给浏览器，不要调 respondWith。
     * 原写法对所有页面导航都 respondWith，会令 Chrome 禁用 bfcache——
     * 每次左滑返回都变成整页重载，旧 ui-unified.js 又压一条守卫历史项，
     * 历史栈无限膨胀、退出永远够不着；弱网/离线时 SW 还直接吐 PAGES_CACHE
     * 里的旧页面，表现为「在旧缓存里循环、退不出去」。
     * 现在：在线 -> 浏览器走 bfcache/HTTP 缓存（即时恢复、不重载、不膨胀），
     * 后台静默更新离线缓存；离线 -> 才用 SW 兜底（缓存页 / offline 页）。 */
    if (self.navigator.onLine) {
      event.waitUntil(updatePageCache(req));
      return; // 交还浏览器，启用 bfcache
    }
    event.respondWith(navigateStrategy(req));
    return;
  }
  if (req.destination === "style" || req.destination === "script") { event.respondWith(freshStrategy(req)); return; }
  if (["image", "font"].includes(req.destination)) { event.respondWith(swrStrategy(req)); return; }
});

/* 页面：网络优先，离线回退缓存，再回退离线页 */
async function navigateStrategy(req) {
  const key = cacheKeyOf(req.url);
  const cache = await caches.open(PAGES_CACHE);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req);          // 含 STATIC_CACHE 预缓存（home/today/offline 等）
    if (hit) return hit;
    const fallback = await caches.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response("离线且无缓存", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/* 在线时后台静默把当前页面存进离线缓存，供日后离线打开；不接管响应。
 * 同一路径 30 秒内最多刷新一次，并合并并发刷新：避免快速往返导航反复发起相同 HTML GET。
 * 在线导航仍交给浏览器处理，保留 BFCache；离线缓存仍会定期刷新。 */
const pageCacheRefreshAt = new Map();
const pageCacheRefreshInFlight = new Map();
const PAGE_CACHE_REFRESH_MS = 30_000;

async function updatePageCache(req) {
  const key = cacheKeyOf(req.url);
  const inFlight = pageCacheRefreshInFlight.get(key);
  if (inFlight) return inFlight;
  if (Date.now() - (pageCacheRefreshAt.get(key) || 0) < PAGE_CACHE_REFRESH_MS) return;

  // 记录尝试时间而不只是成功时间：弱网下失败也要短暂退避，避免每次导航都重试同一 HTML。
  pageCacheRefreshAt.set(key, Date.now());
  const task = (async () => {
    try {
      const cache = await caches.open(PAGES_CACHE);
      const res = await fetch(req, { cache: "no-cache" });
      if (res && res.ok) await cache.put(key, res.clone());
    } catch { /* 离线或失败：30 秒后再试，避免快速往返持续打网络 */ }
    finally { pageCacheRefreshInFlight.delete(key); }
  })();
  pageCacheRefreshInFlight.set(key, task);
  return task;
}

/* 静态资源（图片/字体）：先给缓存，后台更新 */
async function swrStrategy(req) {
  const key = cacheKeyOf(req.url);
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(key);
  const network = fetch(req)
    .then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => hit || Response.error());
  return hit || network;
}

/* 脚本/样式：网络优先，发布后下一次刷新即见新版。
 * - 无缓存时：安心等网络（失败才报错，不做超时——弱网下宁可慢也不能白屏）
 * - 有缓存时：网络 2.5s 未回就先给缓存秒开，后台继续更新供下次使用
 * - cache:'no-cache'：绕过 HTTP 层的 14400s 强缓存，强制回源校验 ETag
 */
async function freshStrategy(req) {
  const key = cacheKeyOf(req.url);
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(key);
  const network = fetch(req, { cache: "no-cache" })
    .then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; });
  if (!hit) {
    try { return await network; } catch { return Response.error(); }
  }
  try {
    return await Promise.race([
      network,
      new Promise((_, rej) => setTimeout(() => rej(new Error("slow-network")), 2500))
    ]);
  } catch { return hit; }
}
