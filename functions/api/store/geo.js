/* /api/store/geo —— 把「高德分享链接 / 坐标文本」解析成经纬度
   ------------------------------------------------------------
   为什么必须放服务端：
   surl.amap.com 是一次 302，浏览器 fetch 读不到 location（amap 不返回 CORS 头），
   页面上也没有任何 JS 能拿到跳转目标。只有 Worker 代取才能读到。
   所以「在数据中心粘贴一个链接就自动填好坐标」这件事，纯前端做不到。

   解析规则见 ./_geo-parse.js（纯函数，可单测）。这里只负责：
   鉴权 → 限条数 → 并发取 → 缓存 → 逐条返回成败原因。

   安全：只放行地图域名白名单（在 _geo-parse.js 里）。
   不加白名单这个接口就是 SSRF 跳板 —— 任何人都能让 Worker 去请求内网地址。 */
import { json, body } from "../_json.js";
import { currentUser } from "../_auth.js";
import { canMaintainRoute } from "../_permissions.js";
import { get, setEx } from "../_redis.js";
import { parseUrl, fromText, expand } from "./_geo-parse.js";

const MAX_ITEMS = 20; // 单次上限：避开 Cloudflare 单请求 subrequest 配额
const CONCURRENCY = 5;
const CACHE_TTL = 60 * 60 * 24 * 30;

const text = (v) => (v == null ? "" : String(v).trim());

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function resolveOne(env, raw) {
  const input = text(raw);
  if (!input) return { ok: false, reason: "EMPTY" };

  /* 不是 URL 就只当坐标文本解析 —— 不能让 "A栋B1" 这类备注被误读成经纬度 */
  if (!/^(https?:)?\/\//i.test(input)) {
    const direct = fromText(input);
    return direct ? { ok: true, ...direct } : { ok: false, reason: "INVALID_URL" };
  }

  const parsed = parseUrl(input);
  if (!parsed) return { ok: false, reason: "INVALID_URL" };
  if (parsed.error) return { ok: false, reason: parsed.error };
  if (!parsed.pending) return { ok: true, ...parsed };

  /* 短链结果缓存 30 天：同一家门店的分享链接不该每次编辑都打一次外网 */
  const key = "geo:" + hash(parsed.pending.href);
  try {
    const cached = await get(env, key);
    if (cached) {
      const v = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lng))) {
        return { ok: true, ...v, cached: true };
      }
    }
  } catch {}

  const got = await expand(parsed.pending);
  if (got.error) return { ok: false, reason: got.error };
  try {
    await setEx(env, key, JSON.stringify(got), CACHE_TTL);
  } catch {}
  return { ok: true, ...got };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ success: false, error: "未登录" }, 401);

  const input = await body(request);
  if (!canMaintainRoute(user, text(input.routeId))) {
    return json({ success: false, error: "无权维护该线路数据资料" }, 403);
  }

  const items = Array.isArray(input.items) ? input.items.slice(0, MAX_ITEMS) : [];
  if (!items.length) return json({ success: false, error: "items 不能为空" }, 400);

  const results = await pool(items, CONCURRENCY, (it) => resolveOne(env, it?.text ?? it));
  return json({ success: true, items: results });
}
