/* 门店坐标解析 —— 纯函数部分（无 env 依赖，可直接单测）
   ------------------------------------------------------------
   三种输入的格式差异都在这里收口，别在调用方重复判断：

   1) 裸坐标         29.5631,106.5512                      顺序不敏感
   2) marker         uri.amap.com/marker?position=lng,lat —— 经度在前
   3) POI 分享短链   surl.amap.com/xxx → 302 →
                     wb.amap.com/?p=POIID,lat,lng,名称,地址 —— 纬度在前
   4) 位置分享短链   surl.amap.com/xxx → 302 →
                     wb.amap.com/?q=lat,lng,位置名称       —— 纬度在前，没有 POIID
                     ↑ 高德 App「分享位置」给的是这种，实测高于「分享 POI」出现频率
                     （surl.amap.com/9Xhz3TMYbR2 → q=29.600741,106.525818,佳园路2号）

   2) 和 3)/4) 的经纬度顺序相反；p= 的坐标在 [1][2]，q= 的在 [0][1] ——
   这是这块最容易写错的地方。统一走 pickPair() 按
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

/* wb.amap.com/?q=lat,lng,位置名称
   高德 App 里「分享位置 / 发送位置」得到的是这种，不带 POIID，也没有独立地址段。
   第三段是位置描述（如「佳园路2号」），当门牌地址展示。
   注意与 p= 的区别：p= 的第 0 段是 POIID，坐标在 [1][2]；q= 的坐标在 [0][1]。
   q 也可能是普通的搜索关键词（?q=火锅），pickPair 会返回 null，不会误判。 */
export function fromQParam(url) {
  let raw = url.searchParams.get("q");
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  const parts = raw.split(",").map((s) => s.trim());
  const pair = pickPair(parts[0], parts[1]);
  if (!pair) return null;
  const label = text(parts.slice(2).join(","));
  return {
    lat: round(pair.lat),
    lng: round(pair.lng),
    name: label,
    address: label,
    kind: "amap-share",
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

/* m.amap.com/callAPP?android=androidamap%3F...%26p%3D<POIID,lat,lng,name,address>
   移动 UA 请求短链时高德会落到这个「唤起 App」中转页，坐标藏在 android/ios/mo
   参数里而不是 URL 上。桌面 UA 虽然能直接拿到 ?p=，但高德随时可能统一策略，
   所以两条路都认。 */
export function fromCallApp(url) {
  for (const key of ["android", "ios", "mo", "wp"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const query = raw.split("?").slice(1).join("?");
    if (!query) continue;
    const p = new URLSearchParams(query).get("p");
    if (!p) continue;
    const parts = p.split(",").map((s) => s.trim());
    const pair = pickPair(parts[1], parts[2]);
    if (!pair) continue;
    return {
      lat: round(pair.lat),
      lng: round(pair.lng),
      name: text(parts[3]),
      address: text(parts[4]),
      kind: "amap-poi",
    };
  }
  return null;
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
  return fromPParam(u) || fromQParam(u) || fromMarker(u) || fromCallApp(u) || { pending: u };
}

function snippetToCoord(html) {
  /* 中转 HTML 里可能藏着 p= / q= / position= 三种写法。
     统一构造成 URL 再交给各自的解析器，避免在这里重复一遍「坐标在第几段」的判断
     —— 之前就是因为这个判断只按 p= 写，q= 三段会被取成「经度,名称」，存下错坐标。 */
  const candidates = [
    { re: /[?&]p=([^"'&\s]+)/i, key: "p", fn: fromPParam },
    { re: /[?&]q=([^"'&\s]+)/i, key: "q", fn: fromQParam },
    { re: /position=([0-9.]+%2C[0-9.]+|[0-9.]+,[0-9.]+)/i, key: "position", fn: fromMarker },
  ];
  for (const c of candidates) {
    const hit = html.match(c.re);
    if (!hit) continue;
    let probe;
    try {
      probe = new URL("https://wb.amap.com/?" + c.key + "=" + hit[1]);
    } catch {
      continue;
    }
    const got = c.fn(probe);
    if (got) return got;
  }
  return null;
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
        /* 必须用桌面 UA：移动 UA 会落到 m.amap.com/callAPP 的唤起中转页，
           URL 上没有 ?p=，坐标藏在参数里；桌面 UA 才直接落在 www.amap.com/?p= */
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });

    /* 落点 URL 通常已经带 ?p= 或 ?q=，读到就能直接收工 */
    let landed;
    try {
      landed = new URL(res.url);
    } catch {
      landed = u;
    }
    const direct =
      fromPParam(landed) || fromQParam(landed) || fromMarker(landed) || fromCallApp(landed);
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
