/* 智配One · Service Worker
 * ------------------------------------------------------------------
 * 设计原则：业务数据永不缓存，静态资源可离线。
 *   - /api/*         ：直接透传，绝不入缓存（登录态、运单、线路必须实时）
 *   - 非 GET 请求     ：不拦截（登录提交、运单上传）
 *   - 页面导航        ：在线交给浏览器（bfcache/HTTP 缓存，即时恢复），离线回退缓存，最后回退 /offline
 *   - CSS/JS         ：stale-while-revalidate（资产带内容哈希 ?v=，未变更命中缓存瞬时返回，
 *                      后台静默刷新；变更 = 新 URL 走网络取新版本）
 *   - 图片/字体       ：stale-while-revalidate（内容基本不变，秒开优先）
 * 资产缓存键用完整 URL（含 ?v=）精确匹配；页面缓存键用 pathname 规整（忽略 ?from 等查询）。
 */
const VERSION = "zp-pwa-247";
const STATIC_CACHE = VERSION + "-static";
const PAGES_CACHE = VERSION + "-pages";
const OFFLINE_URL = "/offline";

/* PRECACHE-BEGIN */
/* 安装即预缓存：App 壳 + 司机高频页面 + 全部版本化静态资源。
 * 本块由 scripts/bump_asset_versions.py 依据 HTML 真实引用生成，勿手改。
 * 版本化资源必须带 ?v= 完整 URL——SWR 以完整 URL 为缓存键，
 * 预缓存不带 ?v= 的条目永远命中不了页面请求（2026-10-18 修复的历史坑）。 */
const PRECACHE = [
  "/",
  "/home",
  "/pages/today",
  "/pages/dispatch",
  "/pages/history",
  "/pages/route_apply",
  "/pages/account",
  "/register",
  "/offline",
  "/assets/delivery-route-light.webp?v=984a9455",
  "/assets/delivery-route.webp?v=b872c885",
  "/assets/icons/apple-touch-icon.png?v=25f1ad28",
  "/assets/icons/icon-192.png?v=4d3f7fd9",
  "/css/account.css?v=f707bce7",
  "/css/admin-base.css?v=65ba43e0",
  "/css/admin-forms.css?v=4afab52f",
  "/css/admin-overlay.css?v=5361c69e",
  "/css/admin-perf.css?v=5b3c0761",
  "/css/app.css?v=b5364547",
  "/css/business-pages.css?v=2f512c53",
  "/css/data.css?v=f4136569",
  "/css/doc-page.css?v=df84b894",
  "/css/history-list.css?v=17b6ce84",
  "/css/history-nav.css?v=4d992f79",
  "/css/history-overlays.css?v=361a3fbc",
  "/css/history-shell.css?v=3c752973",
  "/css/home.bundle.css?v=5dd872a5",
  "/css/mobile-ui.css?v=3f9fab5a",
  "/css/offline.css?v=f44fa920",
  "/css/order_detail.css?v=8f4a4793",
  "/css/ui-base.css?v=b090c428",
  "/css/ui-overlay.css?v=fe14de91",
  "/css/ui-shell.css?v=2ab76df5",
  "/css/ui-theme.css?v=c306fcf7",
  "/css/zp-picker.css?v=1fddfde6",
  "/js/admin/account.js?v=9c4b58ce",
  "/js/admin/boot.js?v=fd3194d5",
  "/js/admin/core.js?v=c8f9a0ee",
  "/js/admin/diagnostics.js?v=88eb94e0",
  "/js/admin/invites.js?v=0926014b",
  "/js/admin/learning.js?v=033dde41",
  "/js/admin/perf.js?v=2c6ff40c",
  "/js/admin/requests.js?v=8a5cb11e",
  "/js/admin/routes.js?v=8c57a71d",
  "/js/admin/shell.js?v=c9d5f0e8",
  "/js/admin/users.js?v=d71263de",
  "/js/error-guard.js?v=da1b8353",
  "/js/fetch-retry.js?v=c6db261e",
  "/js/history/core.js?v=56a52a9a",
  "/js/history/data.js?v=9cf1ad84",
  "/js/history/overlay.js?v=65a2aeb7",
  "/js/history/render.js?v=edd7945b",
  "/js/home.bundle.js?v=19414adc",
  "/js/login.js?v=55c0f0f1",
  "/js/offline-queue.js?v=c255ca1f",
  "/js/order_detail/boot.js?v=f2243bdd",
  "/js/order_detail/confirm.js?v=0bf08223",
  "/js/order_detail/core.js?v=8e1b0286",
  "/js/order_detail/load.js?v=80574450",
  "/js/order_detail/nav-menu.js?v=a2974abe",
  "/js/order_detail/render.js?v=97ce22c4",
  "/js/perf-diagnostics.js?v=072dcda3",
  "/js/pwa.js?v=68dbac73",
  "/js/register.js?v=eafb4977",
  "/js/theme-sync.js?v=2c1a5bbc",
  "/js/ui/appearance.js?v=2661f74b",
  "/js/ui/back.js?v=463c7b00",
  "/js/ui/core.js?v=7c4e2f82",
  "/js/ui/feedback.js?v=f8da0256",
  "/js/ui/nav-prefetch.js?v=7c589b89",
  "/js/ui/nav.js?v=1a5738b3",
  "/js/ui/zp-picker.js?v=1cdf0a93",
];
/* PRECACHE-END */

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
    /* 根治「部署成功却看不到修复」：新版本 SW 接管后，主动把已打开的页面全部导航到
     * 当前 URL（强制刷新）。浏览器每次导航都会重新校验 /sw.js（见 _headers 的
     * no-store），所以即便页面当前跑着旧版 pwa.js（没有 controllerchange 监听），
     * 新 sw.js 一旦安装并激活，这里就能把旧页面强制拉到最新 HTML/JS/CSS——
     * 无需用户手动刷新。SW 每个版本仅激活一次，不会循环重载。 */
    try {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        try { await client.navigate(client.url); } catch { /* 个别客户端导航失败忽略，不影响其他 */ }
      }
    } catch { /* 不支持则降级：依赖 pwa.js 的 controllerchange / 版本守卫兜底 */ }
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
  /* 脚本/样式：stale-while-revalidate（资产均带内容哈希 ?v=，未变更即同 URL，
   * 命中缓存瞬时返回、后台静默刷新）。改为 SWR 后，重复访问的页面资源 0 RTT 秒开，
   * 不再每跳都回源校验（原 network-first 即便已缓存也要等网络）。发布时 html 引用新
   * ?v=，新 URL 不在缓存 -> 自然走网络取新版本；旧 STATIC_CACHE 随 SW 版本号更迭被清。 */
  if (req.destination === "style" || req.destination === "script") { event.respondWith(assetStrategy(req)); return; }
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
    const hit = await caches.match(cacheKeyOf(req.url));  // 按 pathname 匹配（忽略 ?from 等查询），含预缓存页/offline
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

/* 脚本/样式：stale-while-revalidate。
 * - 资产 URL 均带内容哈希 ?v=：未变更 = 同一 URL，命中缓存瞬时返回（0 RTT 秒开），
 *   后台静默回源刷新供下次使用；变更 = 新 URL 不在缓存，自然走网络取最新版。
 * - 用完整 URL（含 ?v=）作缓存键，保证「改版即新键、旧版不串」。
 * - 仅在无缓存（首次/新哈希）时才等网络；失败才报错，弱网下不白屏。
 * - 版本号更迭时旧 STATIC_CACHE 会被 activate 清掉，不会残留脏资产。 */
async function assetStrategy(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);                       // 精确匹配完整 URL（含 ?v=）
  const network = fetch(req, { cache: "no-cache" })
    .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => hit || Response.error());
  return hit || network;                                    // 命中即瞬时返回，否则等网络
}
