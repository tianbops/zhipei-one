/* 智配One · Service Worker
 * ------------------------------------------------------------------
 * 设计原则：业务数据永不缓存，静态资源可离线。
 *   - /api/*         ：直接透传，绝不入缓存（登录态、运单、线路必须实时）
 *   - 非 GET 请求     ：不拦截（登录提交、运单上传）
 *   - 页面导航        ：network-first，离线回退缓存，最后回退 offline.html
 *   - CSS/JS/图片     ：stale-while-revalidate（先秒开，后台静默更新）
 * 缓存 key 一律用 pathname 规整化：页面 URL 常带 ?v=时间戳（防缓存），
 * 若按完整 URL 存，每次跳转都会产生一份新副本。
 */
const VERSION = "zp-pwa-1";
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

  if (isDocument) { event.respondWith(navigateStrategy(req)); return; }
  if (["style", "script", "image", "font"].includes(req.destination)) { event.respondWith(swrStrategy(req)); return; }
});

/* 页面：网络优先，离线回退缓存，再回退离线页 */
async function navigateStrategy(req) {
  const key = cacheKeyOf(req.url);
  const cache = await caches.open(PAGES_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    const hit = await cache.match(key);
    if (hit) return hit;
    const fallback = await caches.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response("离线且无缓存", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

/* 静态资源：先给缓存，后台更新 */
async function swrStrategy(req) {
  const key = cacheKeyOf(req.url);
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(key);
  const network = fetch(req)
    .then(res => { if (res && res.ok) cache.put(key, res.clone()); return res; })
    .catch(() => hit || Response.error());
  return hit || network;
}
