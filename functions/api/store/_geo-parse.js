/* 门店坐标解析 —— 纯函数部分（无 env 依赖，可直接单测）
   ------------------------------------------------------------
   三家地图的「分享」链接形态全部在这里收口，别在调用方重复判断：

   高德（GCJ-02）
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

   腾讯（GCJ-02，与高德同一坐标系，实测同地点两份坐标相差约 2 米）
   7) 分享短链       mmapgwh.map.qq.com/shortlink/short?l=xxx → 302 →
                     map.qq.com/m/map-app/share/poi?coord=lng,lat&n=名称
                     （centercoord / m / c 是同一对值；coord 是经度在前）
   8) URI 标注页     apis.map.qq.com/uri/v1/marker?marker=coord:lat,lng;title=名称

   百度（BD-09，必须转换；coord_type 可显式声明其它坐标系）
   9) 视野长链       map.baidu.com/@lng,lat,18z（或 /poi/名称/@lng,lat,17z）
  10) 参数长链       ?location=lat,lng / ?x=lng&y=lat / ?center=lng,lat
  11) URI 标注页     api.map.baidu.com/marker?location=lat,lng&coord_type=gcj02
  12) POI 分享短链   j.map.baidu.com/xxx → 302 →
                     map.baidu.com/mobile/webapp/.../qt=inf&uid=xxx
                     —— 必须用移动端 UA 才落到这个详情页；页面把完整 POI 数据
                     服务端渲染进 var data = {...}，坐标三种写法：
                       "loc":{"lng":..,"lat":..}      BD-09 经纬度
                       "point":{"x":..,"y":..}        BD-09 墨卡托（米）
                       "geo":"1|x,y;..."              BD-09 墨卡托（米）
                     墨卡托先转 BD-09、再统一转 GCJ-02（见 bd09mcToBd09）。
                     PC UA 会落到无坐标的 SPA，所以 expand() 按域名挑 UA。
  13) 腾讯 H5 详情页 map.wap.qq.com/online/h5-poi-detail-out/index.html
                     ?coord=lng,lat&centercoord=..&m=..&c=..&n=名称
                     —— 「复制链接」给的形态，坐标直接写在 URL 上。

   经纬度顺序各家相反：高德 p= 的坐标在 [1][2]、q= 在 [0][1]，腾讯 coord=
   是经度在前，百度 location= 是纬度在前。统一走 pickPair() 按
   「纬度 18~54 / 经度 73~136」反推，写反了也能纠正过来。

   坐标系统一：库里只存一组 GCJ-02（三家导航入口共用）。高德/腾讯原样入库；
   百度的 BD-09/WGS-84 由 toGcj02() 换算后再返回，数据层与 mapnav.js 都不用改。

   重要：短链的落地内容会随请求出口/UA 变化。云端 Worker 出口可能拿到
   「地图通用首页」或 callAPP 中转页，此时最终 URL 上没有坐标。所以
   expand() 改为 redirect:"manual" 逐跳检查，第一跳 Location 里的
   wb.amap.com/?q=... / map.qq.com/...?coord=... 就带坐标。
   百度是唯一的例外：PC UA 落地无坐标 SPA，必须按域名切到移动端 UA，
   再读落地页 HTML 里的 var data（坐标在 170KB 之后，不能按 60KB 截断）。 */

export const ALLOWED_HOSTS = [
  "amap.com", // surl / uri / wb / ditu / www
  "map.baidu.com", // 含 j. / api. 子域
  "j.map.baidu.com",
  "map.qq.com", // 含 mmapgwh. / apis. 子域
  "map.wap.qq.com", // 腾讯分享短链第二跳落点
  "ditu.qq.com",
];

const LAT_MIN = 18;
const LAT_MAX = 54;
const LNG_MIN = 73;
const LNG_MAX = 136;
const MAX_HTML = 60 * 1024;
/* 百度 POI 详情页的 var data 在 170KB 之后，60KB 截断会漏掉坐标 */
const MAX_HTML_BAIDU = 320 * 1024;

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

/* ===== 坐标系归一：库里只存一组 GCJ-02 =====
   高德/腾讯原生 GCJ-02，直接入库；百度默认 BD-09（比 GCJ-02 偏移约 500~600m），
   必须换算，否则司机用高德/腾讯导航会停到隔壁街区。WGS-84 同样换算。
   算法为公开的国测局加偏与其逆变换（纯数学，无外部依赖，可离线单测）。 */
const PI = 3.1415926535897932384626;
const A = 6378245.0;
const EE = 0.00669342162296594323;
const X_PI = (PI * 3000.0) / 180.0;

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/* 境外坐标不加偏；中国境内才做 WGS-84 → GCJ-02 */
function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lng, lat)) return { lat: lat, lng: lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

export function bd09ToGcj02(lat, lng) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(theta), lng: z * Math.cos(theta) };
}

/* coordType: bd09（百度默认 bd09ll）/ gcj02 / wgs84 / bd09mc（墨卡托，不支持）
   返回 {lat,lng} 且已 round；不支持的坐标系返回 null，交给调用方判失败。 */
export function toGcj02(lat, lng, coordType) {
  const t = text(coordType).toLowerCase() || "bd09";
  if (t === "bd09mc") return null;
  let g;
  if (t === "gcj02") g = { lat, lng };
  else if (t === "wgs84") g = wgs84ToGcj02(lat, lng);
  else g = bd09ToGcj02(lat, lng);
  if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) return null;
  const pair = pickPair(g.lat, g.lng);
  if (!pair) return null;
  return { lat: round(pair.lat), lng: round(pair.lng) };
}

/* 按域名分流：避免把百度/腾讯 URL 上的同名参数（q= / lat= / lon=）误喂给高德解析器。
   本地单测桩（127.0.0.1）不属于任何一家，走「全套解析」兜底。 */
/* ===== 百度墨卡托（BD09MC，米）→ BD-09 经纬度 =====
   百度移动端 POI 详情页只给墨卡托坐标（point.x/y、geo），不给经纬度。
   常数表与多项式来自百度官方投影（经 gcoord 开源实现逐项核对）：
   实测 (13197996.92, 3556594.94) → (118.5583335, 30.5816223)，
   与同一页面自带的 loc 经纬度误差 < 0.1 米。 */
const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
];
export function bd09mcToBd09(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let f = MC2LL[MC2LL.length - 1];
  for (let i = 0; i < MCBAND.length; i++) {
    if (Math.abs(y) >= MCBAND[i]) {
      f = MC2LL[i];
      break;
    }
  }
  const c = Math.abs(y) / f[9];
  let lng = f[0] + f[1] * Math.abs(x);
  let lat = f[2] + f[3] * c + f[4] * c ** 2 + f[5] * c ** 3 +
            f[6] * c ** 4 + f[7] * c ** 5 + f[8] * c ** 6;
  return { lat: lat * (y < 0 ? -1 : 1), lng: lng * (x < 0 ? -1 : 1) };
}

/* 百度移动端 POI 详情页把完整数据服务端渲染进 var data = {...}，坐标三种写法：
     1) "loc":{"lng":..,"lat":..}     已是 BD-09 经纬度，最准
     2) "point":{"x":"..","y":".."}   BD09MC（米）
     3) "geo":"1|x,y;..."             BD09MC（米），取第一组
   后两种先 MC→BD-09，再统一 BD-09→GCJ-02。只回传坐标，不取 name/addr，
   避免分享文案里的名称覆盖运单收货地址。 */
export function baiduHtmlToCoord(html) {
  const s = text(html);
  if (!s) return null;
  const loc = s.match(/"loc"\s*:\s*\{\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*\}/);
  if (loc) {
    const g = toGcj02(Number(loc[2]), Number(loc[1]), "bd09");
    if (g) return { lat: g.lat, lng: g.lng, name: "", address: "", kind: "baidu-html-loc" };
  }
  let mc = s.match(/"point"\s*:\s*\{\s*"x"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*,\s*"y"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*\}/);
  if (!mc) {
    const geo = s.match(/"geo"\s*:\s*"\s*\d+\s*\|\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (geo) mc = [null, geo[1], geo[2]];
  }
  if (mc) {
    const bd = bd09mcToBd09(Number(mc[1]), Number(mc[2]));
    if (!bd) return null;
    const g = toGcj02(bd.lat, bd.lng, "bd09");
    if (g) return { lat: g.lat, lng: g.lng, name: "", address: "", kind: "baidu-html-mc" };
  }
  return null;
}

export function hostKind(host) {
  const h = text(host).toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  if (h === "amap.com" || h.endsWith(".amap.com")) return "amap";
  if (h === "map.baidu.com" || h.endsWith(".map.baidu.com")) return "baidu";
  if (h === "j.map.baidu.com") return "baidu";
  if (h === "map.qq.com" || h.endsWith(".map.qq.com")) return "qq";
  if (h === "map.wap.qq.com" || h.endsWith(".map.wap.qq.com")) return "qq";
  if (h === "ditu.qq.com" || h.endsWith(".ditu.qq.com")) return "qq";
  return null;
}

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

/* ===== 腾讯分享链接（GCJ-02，与高德同坐标系，不需要换算）=====
   短链第一跳：map.qq.com/m/map-app/share/poi?coord=lng,lat&centercoord=...&m=...&c=...
   coord / centercoord / m / c 都是同一对「经度,纬度」；哪个先出现就用哪个。
   URI 标注页：apis.map.qq.com/uri/v1/marker?marker=coord:lat,lng;title=名称
   —— 后者纬度在前，且字段用分号包裹，单独处理。 */
export function fromTencentCoord(url) {
  for (const key of ["coord", "centercoord", "m", "c", "center"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const parts = String(raw).split(",");
    const pair = pickPair(parts[0], parts[1]);
    if (!pair) continue;
    return {
      lat: round(pair.lat),
      lng: round(pair.lng),
      name: text(url.searchParams.get("n") || url.searchParams.get("a") || url.searchParams.get("poiname")),
      address: "",
      kind: "qq-share",
    };
  }
  const marker = url.searchParams.get("marker");
  if (marker) {
    const m = String(marker).match(/coord\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
    if (m) {
      const pair = pickPair(m[1], m[2]);
      if (pair) {
        /* 官方是 title:名称，实际分享里也见过 title=名称，两种都认 */
        const title = String(marker).match(/title\s*[:=]\s*([^;]+)/i);
        return {
          lat: round(pair.lat),
          lng: round(pair.lng),
          name: text(title ? title[1] : ""),
          address: "",
          kind: "qq-marker",
        };
      }
    }
  }
  return null;
}

/* ===== 百度带坐标长链（默认 BD-09，换算成 GCJ-02）=====
   形态：
     /@lng,lat,18z          视野中心（经度在前），也可能藏在 /poi/名称/@lng,lat,17z
     ?location=lat,lng      URI 标注页（纬度在前）
     ?x=lng&y=lat           百度老式参数
     ?center=lng,lat
     ?destination=latlng:lat,lng|name:xxx   URI 路线页
   coord_type 显式声明：bd09ll(默认) / bd09mc(墨卡托，不支持) / gcj02 / wgs84。
   bd09mc 是米制坐标（数值百万级），pickPair 会直接判失败，不会污染基准库。 */
function baiduCoordType(url) {
  const t = text(url.searchParams.get("coord_type") || url.searchParams.get("coordType")).toLowerCase();
  if (t === "gcj02" || t === "gcj02ll") return "gcj02";
  if (t === "wgs84" || t === "wgs84ll") return "wgs84";
  if (t === "bd09mc") return "bd09mc";
  return "bd09";
}

function baiduFromPair(pair, url, kind) {
  const g = toGcj02(pair.lat, pair.lng, baiduCoordType(url));
  if (!g) return null;
  return {
    lat: g.lat,
    lng: g.lng,
    name: text(url.searchParams.get("title") || url.searchParams.get("name") || url.searchParams.get("content")),
    address: "",
    kind: kind,
  };
}

export function fromBaiduUrl(url) {
  /* /@lng,lat,z：pathname 里可能有多段，取最后一段 @ */
  const at = String(url.pathname || "").match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const pair = pickPair(at[1], at[2]);
    if (pair) return baiduFromPair(pair, url, "baidu-at");
  }
  /* location=lat,lng（纬度在前）；也接受 center= / point= */
  for (const key of ["location", "center", "point"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const parts = String(raw).split(",");
    const pair = pickPair(parts[0], parts[1]);
    if (pair) return baiduFromPair(pair, url, "baidu-" + key);
  }
  /* x=lng&y=lat（百度老式：x 是经度、y 是纬度） */
  const x = url.searchParams.get("x");
  const y = url.searchParams.get("y");
  if (x && y) {
    const pair = pickPair(x, y);
    if (pair) return baiduFromPair(pair, url, "baidu-xy");
  }
  /* latlng:lat,lng|name:xxx（URI 路线页 destination / origin） */
  for (const key of ["destination", "origin"]) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const m = String(raw).match(/latlng\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
    if (!m) continue;
    const pair = pickPair(m[1], m[2]);
    if (pair) return baiduFromPair(pair, url, "baidu-" + key);
  }
  return null;
}

/* 百度 POI 短链：j.map.baidu.com/xxx 或 ?poiShareId=xxx。
   只用于「展开后仍拿不到坐标」时选择兜底错误码，不在输入侧拦截 ——
   移动端 UA 下它的详情页是带坐标的。 */
export function isBaiduPoiShortlink(url) {
  const h = text(url.hostname).toLowerCase().replace(/\.$/, "");
  const shortHost = h === "j.map.baidu.com" || h.endsWith(".j.map.baidu.com");
  return shortHost || !!url.searchParams.get("poiShareId");
}

/* 高德 App「分享」到微信/剪贴板常带文案前缀（【高德地图】…），
   整段不是 URL，但链接就在里面。从任意文本里取出第一个 http(s) 链接，
   仍是纯函数：不做任何请求，交给 parseUrl 走白名单。 */
export function extractUrl(raw) {
  const s = text(raw);
  /* 英文逗号必须放行：百度 /@lng,lat,z 与 ?location=lat,lng、腾讯 coord=lng,lat
     都用逗号带坐标；若把逗号当分隔符，长链会被砍成半截而解析不出坐标。
     只排除中文逗号「，」与分号（文案分隔用），末尾清掉误吞的半角标点。 */
  const m = s.match(/https?:\/\/[^\s<>"'`）)】\]，；;]+/i);
  if (!m) return null;
  try {
    const u = new URL(m[0].replace(/[,;]+$/, ""));
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
  /* 百度 POI 短链 URL 上没有坐标，但移动端详情页里有：交给 expand() 展开，
     不能在输入侧直接判失败。 */
  return coordFromUrl(u) || { pending: u };
}

/* 一个 URL 上可能写着坐标的所有形态，统一收口给 parseUrl 与 expand 复用。
   按域名分流：百度/腾讯的同名参数（q= / lat= / lon=）语义与高德不同，
   混跑会把「搜索关键词」或「BD-09 坐标」错当成高德坐标。
   本地单测桩（127.0.0.1）没有域名归属，走全套兜底，保持旧用例不回归。 */
function coordFromUrl(u) {
  const kind = hostKind(u.hostname);
  if (kind === "baidu") return fromBaiduUrl(u);
  if (kind === "qq") return fromTencentCoord(u);
  /* amap 与未知 host：p= / q= / position= 都是「一段里带坐标」，先看；
     再看 callAPP 参数与 lat/lon。最后兜底腾讯 coord=（本地单测桩、以及未来
     新增的短链中转域可能不带地图域名）：coord= 是腾讯特有且 GCJ-02 无需换算，
     安全；百度的 location= 有 BD-09 歧义，故意不放进兜底。 */
  return (
    fromPParam(u) ||
    fromQParam(u) ||
    fromMarker(u) ||
    fromCallApp(u) ||
    fromLatLon(u) ||
    fromTencentCoord(u) ||
    null
  );
}

function snippetToCoord(html) {
  /* 中转 HTML 里可能藏着 p= / q= / position= / lat&lon 四种写法（高德中转页）。
     统一构造成 URL 再交给各自的解析器，避免在这里重复一遍「坐标在第几段」的判断
     —— 之前就是因为这个判断只按 p= 写，q= 三段会被取成「经度,名称」，存下错坐标。
     百度 / 腾讯的坐标都在 URL 上（第一跳 Location 或链接自身），无需在这里兜底：
     贸然加入 coord= / location= 候选会让「高德中转页里的同名参数」被当成百度
     BD-09 换算，凭空引入几百米偏移，得不偿失。 */
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
/* 百度短链要额外取一次 180KB 级的移动端详情页，默认超时放宽到 6 秒；
   高德/腾讯第一跳就命中，不受影响（只是上限，不增加实际耗时）。 */
export async function expand(u, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  /* 百度短链只有移动端 UA 才落到带完整 POI 数据的详情页；PC UA 会落到
     无坐标的 SPA。高德反过来必须保持桌面 UA 才能拿到 wb.amap.com/?q=。
     所以按每一跳的域名挑 UA，不能全局固定一个。 */
  const MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  const headersFor = (host) => ({
    "user-agent": hostKind(host) === "baidu" ? MOBILE_UA : DESKTOP_UA,
    accept: "text/html,application/xhtml+xml",
  });

  const readHtml = async (res, host) => {
    const ct = text(res.headers.get("content-type"));
    if (!/html|text|json|javascript/i.test(ct)) return null;
    try {
      const isBaidu = hostKind(host) === "baidu";
      const html = (await res.text()).slice(0, isBaidu ? MAX_HTML_BAIDU : MAX_HTML);
      return (isBaidu ? baiduHtmlToCoord(html) : null) || snippetToCoord(html);
    } catch {
      return null;
    }
  };

  /* cancel() 返回 Promise：body 已被 res.text() 消费（locked）时会 reject，
     try/catch 拦不住 Promise，会变成未处理的 rejection 直接把整个请求打挂。
     统一加 .catch，且 locked 时干脆不调 —— 百度 POI 短链落地 SPA 会走到这条。 */
  const drain = (res) => {
    try {
      const b = res.body;
      if (!b || b.locked) return;
      const p = b.cancel();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
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
        headers: headersFor(current.hostname),
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
          drain(res)
          return { error: "UNSUPPORTED_HOST" };
        }
        /* 关键：第一跳 wb.amap.com/?q=... 就在这里命中 */
        const hit = coordFromUrl(next);
        if (hit) {
          drain(res)
          return hit;
        }
        /* 中转页可能把坐标写在 body 里 */
        const inBody = await readHtml(res, current.hostname);
        if (inBody) return inBody;
        drain(res)
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
        drain(res)
        return direct;
      }
      const inBody = await readHtml(res, landed.hostname);
      if (inBody) return inBody;
      drain(res)
      break;
    }

    /* ---- 兜底：仅当 manual 拿不到 Location（opaque）或跳数用尽 ---- */
    if (needFollow) {
      const res = await fetch(u.href, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: headersFor(u.hostname),
      });
      let landed;
      try {
        landed = new URL(res.url);
      } catch {
        landed = u;
      }
      const direct = coordFromUrl(landed);
      if (direct) {
        drain(res)
        return direct;
      }
      const inBody = await readHtml(res, landed.hostname);
      if (inBody) return inBody;
      drain(res)
    }
    /* 兜底：百度短链偶发反爬 / 改版时才会走到这里，给一句能照着做的话，
       不要笼统的 NO_COORD。正常情况下移动端详情页已能解析出坐标。 */
    return { error: isBaiduPoiShortlink(u) ? "BAIDU_POI_SHORTLINK" : "NO_COORD" };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "TIMEOUT" : "FETCH_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}
