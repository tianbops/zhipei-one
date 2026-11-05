/**
 * 门店坐标解析契约（node tests/store-geo-parse.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：在数据中心粘贴一条高德分享链接，就能自动得到精确坐标，
 * 让「点门店名」从「打开一个 POI 页」升级成「直接规划驾车路线」。
 *
 * 必须锁死的规则：
 *   1) wb.amap.com/?p=POIID,lat,lng,name,address → 纬度在前；
 *      uri.amap.com/marker?position=lng,lat      → 经度在前；
 *      两者顺序相反，必须靠范围（纬度 18~54 / 经度 73~136）反推，写反也要纠正；
 *   2) 域名白名单：amap.com 及子域放行，amap.com.evil.com / amap.com@evil.com 拒绝
 *      （这个接口会代用户发请求，白名单缺失就是 SSRF）；
 *   3) 非 URL 的文本只当坐标解析，"A栋B1" 不得被误读成经纬度；
 *   4) 境外坐标、0,0、非数字一律判失败，不能污染基准库。
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  fromPParam,
  fromMarker,
  fromText,
  pickPair,
  parseUrl,
  hostAllowed,
  expand,
} from "../functions/api/store/_geo-parse.js";

let pass = 0,
  fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (extra ? " → " + extra : ""));
  }
}

console.log("经纬度顺序纠错（6 条）");
{
  const a = pickPair(29.5631, 106.5512);
  t("纬度在前 → 正确识别", a && a.lat === 29.5631 && a.lng === 106.5512, JSON.stringify(a));
  const b = pickPair(106.5512, 29.5631);
  t("经度在前 → 自动纠正", b && b.lat === 29.5631 && b.lng === 106.5512, JSON.stringify(b));
  t("两个都在纬度范围 → 无法判定，返回 null", pickPair(30, 40) === null);
  t("南半球/境外坐标 → null", pickPair(-33.8, 151.2) === null);
  t("0,0 → null", pickPair(0, 0) === null);
  t("非数字 → null", pickPair("abc", "def") === null);
}

console.log("\n高德分享落点 p= 参数（4 条）");
{
  /* 真实样例：故宫，p=POIID,纬度,经度,名称,地址 */
  const u = new URL(
    "https://wb.amap.com/?p=B000A8UIN8%2C39.91783884443746%2C116.3970284163952%2C%E6%95%85%E5%AE%AB%E5%8D%9A%E7%89%A9%E9%99%A2%2C%E6%99%AF%E5%B1%B1%E5%89%8D%E8%A1%974%E5%8F%B7"
  );
  const r = fromPParam(u);
  t(
    "坐标解析正确（纬度 39.91 / 经度 116.39）",
    r && Math.abs(r.lat - 39.917839) < 1e-6 && Math.abs(r.lng - 116.397028) < 1e-6,
    JSON.stringify(r)
  );
  t("名称还原为中文", r && r.name === "故宫博物院", r && r.name);
  t("门牌地址一并带出", r && r.address === "景山前街4号", r && r.address);
  const only = fromPParam(new URL("https://wb.amap.com/?p=B123%2C29.5631%2C106.5512"));
  t(
    "只有 POIID+坐标（无名称地址）也不报错",
    only && only.lat === 29.5631 && only.name === "",
    JSON.stringify(only)
  );
}

console.log("\nmarker 链接（3 条）");
{
  const r = fromMarker(
    new URL("https://uri.amap.com/marker?position=106.5512,29.5631&name=%E8%B0%8A%E5%93%81")
  );
  t("position 是「经度,纬度」", r && r.lat === 29.5631 && r.lng === 106.5512, JSON.stringify(r));
  t("name 参数解码", r && r.name === "谊品");
  t(
    "position 写反也能纠正",
    (() => {
      const x = fromMarker(new URL("https://uri.amap.com/marker?position=29.5631,106.5512"));
      return x && x.lat === 29.5631;
    })()
  );
}

console.log("\n纯文本坐标（4 条）");
{
  t(
    "中文全角逗号",
    (() => {
      const r = fromText("29.5631，106.5512");
      return r && r.kind === "coord" && r.lat === 29.5631;
    })()
  );
  t(
    "顿号分隔",
    (() => {
      const r = fromText("29.5631、106.5512");
      return r && r.lat === 29.5631;
    })()
  );
  t(
    "空格分隔",
    (() => {
      const r = fromText("29.5631 106.5512");
      return r && r.lng === 106.5512;
    })()
  );
  t("楼层备注不会被当成坐标", fromText("A栋B1") === null);
}

console.log("\n域名白名单 / SSRF（6 条）");
{
  t(
    "amap.com 及子域放行",
    hostAllowed("amap.com") &&
      hostAllowed("surl.amap.com") &&
      hostAllowed("uri.amap.com") &&
      hostAllowed("wb.amap.com")
  );
  t(
    "百度/腾讯分享域名放行",
    hostAllowed("j.map.baidu.com") && hostAllowed("map.baidu.com") && hostAllowed("map.qq.com")
  );
  t(
    "伪装域名拒绝",
    !hostAllowed("amap.com.evil.com") && !hostAllowed("evilamap.com") && !hostAllowed("amap.com.cn")
  );
  t(
    "内网地址拒绝",
    !hostAllowed("127.0.0.1") && !hostAllowed("localhost") && !hostAllowed("169.254.169.254")
  );
  t("带 userinfo 的 URL 返回 null", parseUrl("https://amap.com@evil.com/x") === null);
  t(
    "非 http(s) 协议返回 null",
    parseUrl("ftp://amap.com/x") === null && parseUrl("javascript:alert(1)") === null
  );
}

console.log("\nparseUrl 分流（3 条）");
{
  const hit = parseUrl("https://wb.amap.com/?p=B1%2C29.5%2C106.5%2C%E5%BA%97%2C%E8%B7%AF");
  t("落点链接直接解析出坐标，无需展开", hit && hit.lat === 29.5 && !hit.pending);
  const pend = parseUrl("https://surl.amap.com/abc123");
  t(
    "短链标记为 pending（需要服务端展开）",
    pend && pend.pending && pend.pending.hostname === "surl.amap.com"
  );
  const bad = parseUrl("https://example.com/x");
  t("白名单外的域名返回 UNSUPPORTED_HOST", bad && bad.error === "UNSUPPORTED_HOST");
}

console.log("\n真实 302 展开（3 条）");
{
  /* 本地起一个假的短链服务，模拟 surl → wb 的两次跳转 */
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/short")) {
      res.writeHead(302, { location: "/mid" });
      return res.end();
    }
    if (req.url.startsWith("/mid")) {
      /* 落点用本地地址，避免单测真的去请求高德（离线可跑、不受网络影响） */
      res.writeHead(302, {
        location: "/final?p=B0FF%2C29.5631%2C106.5512%2C%E8%B0%8A%E5%93%81%E7%94%9F%E9%B2%9C",
      });
      return res.end();
    }
    if (req.url.startsWith("/final")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html>ok</html>");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;

  const got = await expand(new URL("http://127.0.0.1:" + port + "/short"));
  t(
    "跟随两次跳转后取到坐标",
    got && got.lat === 29.5631 && got.lng === 106.5512,
    JSON.stringify(got)
  );
  t("带出门店名", got && got.name === "谊品生鲜", got && got.name);

  const dead = await expand(new URL("http://127.0.0.1:" + port + "/404"));
  t(
    "打不开的链接返回 NO_COORD 而不是抛错",
    dead && dead.error === "NO_COORD",
    JSON.stringify(dead)
  );

  srv.close();
}

console.log("\n接线检查（8 条）");
{
  const read = (p) => readFileSync(fileURLToPath(new URL("../" + p, import.meta.url)), "utf8");
  const BASE = read("functions/api/base.js");
  const LATEST = read("functions/api/waybills/latest.js");
  const HISTORY = read("functions/api/_history-read.js");
  const DATA = read("pages/data.html");
  const BUNDLE = read("js/home.bundle.js");

  t(
    "normalizeStore 放行 lat/lng —— 白名单不加，坐标会被静默丢掉",
    /lat:numOrNull\(s\.lat,"lat"\),lng:numOrNull\(s\.lng,"lng"\)/.test(BASE)
  );
  t("latest.js 用基准库回补坐标（老运单也能导航）", /geoOf\(baseStore\)/.test(LATEST));
  t("历史读取同样回补坐标", /geoOf\(baseStore\)/.test(HISTORY));
  t(
    "编辑面板有「位置」输入与解析按钮",
    /id="editGeo"/.test(DATA) && /id="editGeoParse"/.test(DATA)
  );
  t("保存时把坐标写进门店对象", /item\.lat=editGeo\?editGeo\.lat:null/.test(DATA));
  t("批量定位按钮按维护权限显示", /batchGeoBtn"\)\.hidden=!canMaintain/.test(DATA));
  t("未定位角标只在缺坐标时渲染", /<em class="data-store-geo">未定位<\/em>/.test(DATA));
  t("首页 bundle 已打入坐标导航（mapnav 在打包清单里）", /uri\.amap\.com\/navigation/.test(BUNDLE));
}

console.log("\n" + (fail ? "❌ " : "✅ ") + `通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(failures.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}
