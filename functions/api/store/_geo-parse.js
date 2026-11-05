/* 门店坐标解析 —— 纯函数部分（无 env 依赖，可直接单测）
   ------------------------------------------------------------
   三种输入的格式差异都在这里收口，别在调用方重复判断：

   1) 裸坐标     29.5631,106.5512                    顺序不敏感
   2) marker     uri.amap.com/marker?position=lng,lat —— 经度在前
   3) 分享短链   surl.amap.com/xxx → 302 →
                 wb.amap.com/?p=POIID,lat,lng,名称,地址 —— 纬度在前
                                                        ↑ 与 2) 相反

   2) 和 3) 顺序相反，是这块最容易写错的地方。统一走 pickPair() 按
   「纬度 18~54 / 经度 73~136」反推，写反了也能纠正过来。 */

export const ALLOWED_HOSTS = [
  "amap.com", // surl / uri / wb / ditu / www
  "map.baidu.com",
  "j.map.baidu.com",
  "map.qq.com",
  "ditu.qq.com",
];

const LAT_MIN = 18;
const LAT_MAX = 54;
const LNG_MIN = 73;
const LNG_MAX = 136;
const MAX_HTML = 60 * 1024;

const text = (v) => (v == null ? "" : String(v).trim());

export function hostAllowed(host) {
  const h = text(host).toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return ALLOWED_HOSTS.some((d) => h === d || h.slice(-(d.length + 1)) === "." + d);
}

/* 两个数都合法时按范围判定谁是纬度，顺序写反也能纠正 */
export function pickPair(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const inLat = (v) => v >= LAT_MIN && v <= LAT_MAX;
  const inLng = (v) => v >= LNG_MIN && v <= LNG_MAX;
  if (inLat(x) && inLng(y)) return { lat: x, lng: y };
  if (inLng(x) && inLat(y)) return { lat: y, lng: x };
  return null;
}

const round = (v) => Math.round(Number(v) * 1e6) / 1e6;

/* wb.amap.com/?p=POIID,lat,lng,name,address */
export function fromPParam(url) {
  const raw = url.searchParams.get("p") || url.searchParams.get("position");
  if (!raw) return null;
  let parts;
  try {
    parts = decodeURIComponent(raw)
      .split(",")
      .map((s) => s.trim());
  } catch {
    return null;
  }
  const pair = pickPair(parts[1], parts[2]);
  if (!pair) return null;
  return {
    lat: round(pair.lat),
    lng: round(pair.lng),
    name: text(parts[3]),
    address: text(parts[4]),
    kind: "amap-poi",
  };
}

/* uri.amap.com/marker?position=lng,lat&name=xxx */
export function fromMarker(url) {
  const pos = url.searchParams.get("position");
  if (!pos) return null;
  const [a, b] = pos.split(",");
  const pair = pickPair(a, b);
  if (!pair) return null;
  return {
    lat: round(pair.lat),
    lng: round(pair.lng),
    name: text(url.searchParams.get("name")),
    address: text(url.searchParams.get("address")),
    kind: "amap-marker",
  };
}

/* 纯文本坐标，允许全角逗号、顿号、空格分隔 */
export function fromText(raw) {
  const m = raw
    .replace(/[，、]/g, ",")
    .match(/(-?\d{2,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{2,3}(?:\.\d+)?)/);
  if (!m) return null;
  const pair = pickPair(m[1], m[2]);
  if (!pair) return null;
  return { lat: round(pair.lat), lng: round(pair.lng), name: "", address: "", kind: "coord" };
}

/* 返回 {hit} / {pending:URL} / {error} / null(不是 URL) */
export function parseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (!hostAllowed(u.hostname)) return { error: "UNSUPPORTED_HOST" };
  return fromPParam(u) || fromMarker(u) || { pending: u };
}

function snippetToCoord(html) {
  const hit =
    html.match(/wb\.amap\.com\/?\?p=([^"'&\s]+)/i) ||
    html.match(/["']position["']\s*:\s*["']([0-9.]+\s*,\s*[0-9.]+)["']/i) ||
    html.match(/position=([0-9.]+%2C[0-9.]+|[0-9.]+,[0-9.]+)/i);
  if (!hit) return null;
  const raw = decodeURIComponent(hit[1]);
  /* 中转页里出现的既可能是完整 p=POIID,lat,lng,...，也可能只是 position=lng,lat */
  const parts = raw.split(",").map((s) => s.trim());
  const pair = parts.length >= 3 ? pickPair(parts[1], parts[2]) : pickPair(parts[0], parts[1]);
  if (!pair) return null;
  return {
    lat: round(pair.lat),
    lng: round(pair.lng),
    name: text(parts[3]),
    address: text(parts[4]),
    kind: "amap-poi",
  };
}

/* 跟随 302 拿落点。fetch 是全局的，Node 18+ 与 workerd 都有。 */
export async function expand(u, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(u.href, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        accept: "text/html,application/xhtml+xml",
      },
    });

    /* 落点 URL 通常已经带 ?p=，读到就能直接收工 */
    let landed;
    try {
      landed = new URL(res.url);
    } catch {
      landed = u;
    }
    const direct = fromPParam(landed) || fromMarker(landed);
    if (direct) {
      try {
        res.body?.cancel();
      } catch {}
      return direct;
    }

    /* 少数短链用中转 HTML 做跳转，坐标写在页面里（只读前 60KB） */
    const ct = text(res.headers.get("content-type"));
    if (/html/i.test(ct)) {
      const html = (await res.text()).slice(0, MAX_HTML);
      const got = snippetToCoord(html);
      if (got) return got;
    }
    return { error: "NO_COORD" };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "TIMEOUT" : "FETCH_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}
