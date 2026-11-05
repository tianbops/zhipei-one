/* 门店坐标解析 —— 纯函数部分（无 env 依赖，可直接单测）
   ------------------------------------------------------------
   输入形态的差异都在这里收口，别在调用方重复判断：

   1) 裸坐标         29.5631,106.5512                      顺序不敏感
   2) marker         uri.amap.com/marker?position=lng,lat —— 经度在前
   3) POI 分享短链   surl.amap.com/xxx → 302 →
                     wb.amap.com/?p=POIID,lat,lng,名称,地址 —— 纬度在前
   4) 位置分享短链   surl.amap.com/xxx → 302 →
                     wb.amap.com/?q=lat,lng,位置名称       —— 纬度在前，没有 POIID
                     ↑ 高德 App「分享位置」给的是这种，实测高于「分享 POI」出现频率
                     （surl.amap.com/9Xhz3TMYbR2 → q=29.600741,106.525818,佳园路2号）
   5) 移动端中转页   m.amap.com/callAPP?android=androidamap?q=lat,lng,描述
                     或 ios=viewMap?lat=..&lon=..&poiname=..
   6) 带文案的分享   【高德地图】佳园路2号 https://surl.amap.com/xxx

   2) 和 3)/4) 的经纬度顺序相反；p= 的坐标在 [1][2]，q= 的在 [0][1] ——
   这是这块最容易写错的地方。统一走 pickPair() 按
   「纬度 18~54 / 经度 73~136」反推，写反了也能纠正过来。

   重要：短链的落地内容会随请求出口/UA 变化。云端 Worker 出口可能拿到
   「高德通用首页」或 callAPP 中转页，此时最终 URL 上没有坐标。所以
   expand() 改为 redirect:"manual" 逐跳检查，第一跳 Location 里的
   wb.amap.com/?q=... 就带坐标，不再依赖 UA 或最终落地页。 */

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

/* m.amap.com/callAPP 中转页：坐标藏在 android / ios / mo / wp 参数里。
   原来只认 p=（POI 分享），但「分享位置」用的是 q= 或 lat/lon，
   实测这几种形态都会出现：
     android=androidamap?...&p=POIID,lat,lng,名称,地址
     android=androidamap?...&q=lat,lng,位置名称
     ios=viewMap?...&lat=29.600741&lon=106.525818&poiname=佳园路2号
     mo=http://m.amap.com/?q=lat,lng,位置名称
   四种写法都在这里收口，避免「桌面 UA 能解析、云端出口全失败」。 */
function fromCallAppParam(raw) {
  const query = String(raw).split("?").slice(1).join("?");
  if (!query) return null;
  let q;
  try {
    q = new URLSearchParams(query);
  } catch {
    return null;
  }
  /* p=：POIID,lat,lng,名称,地址 —— 坐标在 [1][2] */
  const p = q.get("p");
  if (p) {
    const parts = p.split(",").map((s) => s.trim());
    const pair = pickPair(parts[1], parts[2]);
    if (pair) {
      return {
        lat: round(pair.lat),
        lng: round(pair.lng),
        name: text(parts[3]),
        address: text(parts[4]),
        kind: "amap-poi",
      };
    }
  }
  /* q=：lat,lng,位置名称 —— 坐标在 [0][1] */
  const qv = q.get("q");
  if (qv) {
    let decoded = qv;
    try {
      decoded = decodeURIComponent(qv);
    } catch {}
    const parts = decoded.split(",").map((s) => s.trim());
    const pair = pickPair(parts[0], parts[1]);
    if (pair) {
      return {
        lat: round(pair.lat),
        lng: round(pair.lng),
        name: text(parts.slice(2).join(",")),
        address: text(parts.slice(2).join(",")),
        kind: "amap-share",
      };
    }
  }
  /* viewMap?lat=..&lon=..（或 lng / latitude / longitude） */
  const lat = q.get("lat") || q.get("latitude");
  const lng = q.get("lon") || q.get("lng") || q.get("longitude");
  if (lat && lng) {
    const pair = pickPair(lat, lng);
    if (pair) {
      return {
        lat: round(pair.lat),
        lng: round(pair.lng),
        name: text(q.get("poiname") || q.get("name")),
        address: text(q.get("poiname") || q.get("name") || q.get("addr")),
        kind: "amap-share",
      };
    }
  }
  return null;
}

export function fromCallApp(url) {
  for (const key of ["android", "ios", "mo", "wp"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const got = fromCallAppParam(raw);
    if (got) return got;
  }
  return null;
}

/* URL 上直接带 lat / lon（如 viewMap 页、部分 marker 页） */
export function fromLatLon(url) {
  const lat = url.searchParams.get("lat") || url.searchParams.get("latitude");
  const lng = url.searchParams.get("lon") || url.searchParams.get("lng") || url.searchParams.get("longitude");
  if (!lat || !lng) return null;
  const pair = pickPair(lat, lng);
  if (!pair) return null;
  return {
    lat: round(pair.lat),
    lng: round(pair.lng),
    name: text(url.searchParams.get("poiname") || url.searchParams.get("name")),
    address: text(url.searchParams.get("addr") || url.searchParams.get("address")),
    kind: "amap-share",
  };
}

/* 高德 App「分享」到微信/剪贴板常带文案前缀（【高德地图】…），
   整段不是 URL，但链接就在里面。从任意文本里取出第一个 http(s) 链接，
   仍是纯函数：不做任何请求，交给 parseUrl 走白名单。 */
export function extractUrl(raw) {
  const s = text(raw);
  const m = s.match(/https?:\/\/[^\s<>"'`）)】\]，,；;]+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
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
  return coordFromUrl(u) || { pending: u };
}

/* 一个 URL 上可能写着坐标的所有形态，统一收口给 parseUrl 与 expand 复用。
   顺序有意义：p= / q= / position= 都是「一段里带坐标」，先看；再看
   callAPP 参数与 lat/lon。 */
function coordFromUrl(u) {
  return (
    fromPParam(u) ||
    fromQParam(u) ||
    fromMarker(u) ||
    fromCallApp(u) ||
    fromLatLon(u) ||
    null
  );
}

function snippetToCoord(html) {
  /* 中转 HTML 里可能藏着 p= / q= / position= / lat&lon 四种写法。
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
  /* viewMap?lat=..&lon=..：中转 HTML 里也可能只写这一对 */
  const ll = html.match(/[?&](?:lat|latitude)=([0-9.]+)[^0-9]{1,12}?(?:lon|lng|longitude)=([0-9.]+)/i);
  if (ll) {
    const pair = pickPair(ll[1], ll[2]);
    if (pair) {
      return { lat: round(pair.lat), lng: round(pair.lng), name: "", address: "", kind: "amap-share" };
    }
  }
  return null;
}

/* 桌面 UA 只是为了尽量让高德给「正常」落地页，但**不再依赖它**：
   短链服务的第一跳 Location 恒定带 ?q= / ?p=，与请求出口、UA、后续
   是否落到通用首页无关。旧实现 redirect:"follow" 只看最终 res.url，
   一旦云端出口拿到通用首页或 JS 跳转页，坐标就丢了。 */
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_HOPS = 5;

/* 跨 host 的绝对跳转必须过白名单（防 302 把请求引到内网 / 元数据地址）；
   同源相对跳转放行 —— 单测本地桩与高德自己的 /mid → /final 都属这种。 */
function hopAllowed(next, from) {
  if (next.protocol !== "http:" && next.protocol !== "https:") return false;
  if (next.hostname === from.hostname) return true;
  return hostAllowed(next.hostname);
}

/* 跟随 302 拿坐标。fetch 是全局的，Node 18+ 与 workerd 都有。
   主路径：redirect:"manual" 逐跳检查每个 Location（第一跳通常就命中）。
   兜底：某些运行时 manual 返回 opaque redirect（拿不到 Location），
   或坐标写在最终中转 HTML 里 → 退回一次 follow 读 res.url + HTML。 */
export async function expand(u, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { "user-agent": DESKTOP_UA, accept: "text/html,application/xhtml+xml" };

  const readHtml = async (res) => {
    const ct = text(res.headers.get("content-type"));
    if (!/html|text|json|javascript/i.test(ct)) return null;
    try {
      return snippetToCoord((await res.text()).slice(0, MAX_HTML));
    } catch {
      return null;
    }
  };

  try {
    /* 输入 URL 自身就可能带坐标（parseUrl 已处理，这里是防御性兜底） */
    const own = coordFromUrl(u);
    if (own) return own;

    /* ---- 主路径：逐跳检查 Location ---- */
    let current = u;
    let needFollow = false;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await fetch(current.href, {
        redirect: "manual",
        signal: ctrl.signal,
        headers,
      });
      /* workerd 的 manual 重定向可能给 opaque response：status 0、无头 */
      if (res.status === 0 || res.type === "opaqueredirect") {
        needFollow = true;
        break;
      }
      const loc = res.headers.get("location");
      if (loc) {
        let next;
        try {
          next = new URL(loc, current);
        } catch {
          break;
        }
        if (!hopAllowed(next, current)) {
          try { res.body?.cancel(); } catch {}
          return { error: "UNSUPPORTED_HOST" };
        }
        /* 关键：第一跳 wb.amap.com/?q=... 就在这里命中 */
        const hit = coordFromUrl(next);
        if (hit) {
          try { res.body?.cancel(); } catch {}
          return hit;
        }
        /* 中转页可能把坐标写在 body 里 */
        const inBody = await readHtml(res);
        if (inBody) return inBody;
        try { res.body?.cancel(); } catch {}
        current = next;
        /* 跳数用尽仍未命中 → 交给 follow 兜底 */
        if (hop === MAX_HOPS - 1) needFollow = true;
        continue;
      }
      /* 没有 Location：这是最终响应，读 URL 与 HTML 后收工（再 follow 也是同一页） */
      let landed = current;
      try {
        if (res.url) landed = new URL(res.url);
      } catch {}
      const direct = coordFromUrl(landed);
      if (direct) {
        try { res.body?.cancel(); } catch {}
        return direct;
      }
      const inBody = await readHtml(res);
      if (inBody) return inBody;
      try { res.body?.cancel(); } catch {}
      break;
    }

    /* ---- 兜底：仅当 manual 拿不到 Location（opaque）或跳数用尽 ---- */
    if (needFollow) {
      const res = await fetch(u.href, {
        redirect: "follow",
        signal: ctrl.signal,
        headers,
      });
      let landed;
      try {
        landed = new URL(res.url);
      } catch {
        landed = u;
      }
      const direct = coordFromUrl(landed);
      if (direct) {
        try { res.body?.cancel(); } catch {}
        return direct;
      }
      const inBody = await readHtml(res);
      if (inBody) return inBody;
      try { res.body?.cancel(); } catch {}
    }
    return { error: "NO_COORD" };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "TIMEOUT" : "FETCH_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}
