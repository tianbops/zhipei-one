/**
 * 门店坐标解析契约（node tests/store-geo-parse.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：在数据中心粘贴一条高德分享链接，就能自动得到精确坐标，
 * 让「点门店名」从「打开一个 POI 页」升级成「直接规划驾车路线」。
 *
 * 必须锁死的规则：
 *   1) wb.amap.com/?p=POIID,lat,lng,name,address → 纬度在前；
 *      wb.amap.com/?q=lat,lng,位置名称          → 纬度在前（高德「分享位置」）；
 *      uri.amap.com/marker?position=lng,lat      → 经度在前；
 *      顺序相反，必须靠范围（纬度 18~54 / 经度 73~136）反推，写反也要纠正；
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
  fromQParam,
  fromMarker,
  fromCallApp,
  fromLatLon,
  extractUrl,
  fromText,
  pickPair,
  parseUrl,
  hostAllowed,
  hostKind,
  expand,
  toGcj02,
  bd09mcToBd09,
  baiduHtmlToCoord,
  bd09ToGcj02,
  wgs84ToGcj02,
  fromBaiduUrl,
  fromTencentCoord,
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

console.log("\n高德「分享位置」落点 q= 参数（6 条）");
{
  /* 用户实际给的链接展开后就是这种：surl.amap.com/9Xhz3TMYbR2
     → wb.amap.com/?q=29.600741086473104,106.5258179605007,佳园路2号
     与 p= 不同：没有 POIID，坐标在 [0][1]，第三段是位置描述而非门店名。 */
  const u = new URL(
    "https://wb.amap.com/?q=29.600741086473104%2C106.5258179605007%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7&commonBizInfo=%7B%22share_from%22%3A%22poi_poi%22%7D"
  );
  const r = fromQParam(u);
  t(
    "坐标解析正确（重庆 29.600741 / 106.525818）",
    r && Math.abs(r.lat - 29.600741) < 1e-6 && Math.abs(r.lng - 106.525818) < 1e-6,
    JSON.stringify(r)
  );
  t("位置描述还原为门牌地址", r && r.address === "佳园路2号", JSON.stringify(r));
  t("kind 标记为 amap-share，与 POI 分享区分", r && r.kind === "amap-share");
  const flipped = fromQParam(
    new URL("https://wb.amap.com/?q=106.525818%2C29.600741%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7")
  );
  t(
    "坐标顺序写反也能纠正（q=106.5258,29.6007）",
    flipped && flipped.lat === 29.600741 && flipped.lng === 106.525818,
    JSON.stringify(flipped)
  );
  t(
    "q= 是普通搜索关键词时不误判（火锅 / 中文 / 空）",
    fromQParam(new URL("https://www.amap.com/?q=%E7%81%AB%E9%94%85")) === null &&
      fromQParam(new URL("https://www.amap.com/?q=")) === null
  );
  t(
    "q= 里出现境外/0 坐标一律拒绝",
    fromQParam(new URL("https://wb.amap.com/?q=0%2C0%2Cx")) === null &&
      fromQParam(new URL("https://wb.amap.com/?q=48.8%2C2.3%2CParis")) === null
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

console.log("\n唤起中转页 callAPP（3 条）");
{
  /* 移动 UA 请求短链时高德落到 m.amap.com/callAPP，坐标藏在 android 参数里 */
  const u = new URL(
    "https://m.amap.com/callAPP?android=androidamap%3Faction%3Dshorturl%26p%3DB000A8UIN8%2C39.91783884443746%2C116.3970284163952%2C%E6%95%85%E5%AE%AB%E5%8D%9A%E7%89%A9%E9%99%A2%2C%E6%99%AF%E5%B1%B1%E5%89%8D%E8%A1%974%E5%8F%B7"
  );
  const r = fromCallApp(u);
  t(
    "android 参数里的 p= 能解出坐标",
    r && Math.abs(r.lat - 39.917839) < 1e-6 && Math.abs(r.lng - 116.397028) < 1e-6,
    JSON.stringify(r)
  );
  t(
    "名称与门牌地址一并还原",
    r && r.name === "故宫博物院" && r.address === "景山前街4号",
    JSON.stringify(r)
  );
  const p2 = parseUrl(u.href);
  t(
    "parseUrl 遇到 callAPP 直接返回坐标，不再 pending",
    p2 && p2.lat === 39.917839 && !p2.pending,
    JSON.stringify(p2)
  );
}

console.log("\n中转页 q= / lat-lon 与带文案分享（用户真实形态，8 条）");
{
  /* 云端 Worker 出口实测：短链可能落到 callAPP，坐标不再是 p= 而是 q= 或 lat/lon。
     旧版 fromCallApp 只认 p=，这几种全部返回 NO_COORD → 43 家门店整体定位失败。 */
  const ios = new URL(
    "https://m.amap.com/callAPP?ios=viewMap%3FsourceApplication%3Dfrom_wb%26dev%3D0%26poiname%3D%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7%26lat%3D29.600741086473104%26lon%3D106.5258179605007"
  );
  const iosHit = fromCallApp(ios);
  t("callAPP ios=viewMap 的 lat/lon 能解出坐标", !!iosHit && iosHit.lat === 29.600741 && iosHit.lng === 106.525818, JSON.stringify(iosHit));

  const android = new URL(
    "https://m.amap.com/callAPP?android=androidamap%3Faction%3Dshorturl%26q%3D29.600741086473104%2C106.5258179605007%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7"
  );
  const androidHit = fromCallApp(android);
  t("callAPP android 的 q= 能解出坐标", !!androidHit && androidHit.lat === 29.600741 && androidHit.lng === 106.525818, JSON.stringify(androidHit));

  const mo = new URL(
    "https://m.amap.com/callAPP?mo=http%3A%2F%2Fm.amap.com%2F%3Fq%3D29.600741%2C106.525818%2Cx%26callapp%3D0"
  );
  const moHit = fromCallApp(mo);
  t("callAPP mo= 里嵌套的 q= 能解出坐标", !!moHit && moHit.lat === 29.600741 && moHit.lng === 106.525818, JSON.stringify(moHit));

  t("parseUrl 遇到 q= 中转页直接返回坐标而非 pending", (() => {
    const p = parseUrl(android.href);
    return p && p.lat === 29.600741 && !p.pending;
  })(), "q= 中转页");
  t("URL 上直接带 lat/lon 也能解析", (() => {
    const r = fromLatLon(new URL("https://m.amap.com/viewMap?lat=29.600741&lon=106.525818"));
    return r && r.lat === 29.600741 && r.lng === 106.525818;
  })(), "fromLatLon");

  /* 高德 App 分享到微信/剪贴板带文案前缀，整段不是 URL */
  const share = "【高德地图】佳园路2号 https://surl.amap.com/9Xhz3TMYbR2 点击查看";
  t("带文案分享文本能提取出链接", extractUrl(share)?.href === "https://surl.amap.com/9Xhz3TMYbR2", JSON.stringify(extractUrl(share)?.href));
  t("提取出的链接能正常进入 parseUrl 分流", (() => {
    const ext = extractUrl(share);
    const p = ext && parseUrl(ext.href);
    return p && !!p.pending;
  })(), "extractUrl → parseUrl");
  t("纯文字备注不会被误提取成链接", extractUrl("A栋B1 由经销商代送") === null, "extractUrl 备注");
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

console.log("\nparseUrl 分流（4 条）");
{
  const hit = parseUrl("https://wb.amap.com/?p=B1%2C29.5%2C106.5%2C%E5%BA%97%2C%E8%B7%AF");
  t("p= 落点链接直接解析出坐标，无需展开", hit && hit.lat === 29.5 && !hit.pending);
  const q = parseUrl(
    "https://wb.amap.com/?q=29.600741%2C106.525818%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7"
  );
  t(
    "q= 落点链接同样直接出坐标（且不会按 p= 取 [1][2] 存成错坐标）",
    q && q.lat === 29.600741 && q.lng === 106.525818 && !q.pending,
    JSON.stringify(q)
  );
  const pend = parseUrl("https://surl.amap.com/abc123");
  t(
    "短链标记为 pending（需要服务端展开）",
    pend && pend.pending && pend.pending.hostname === "surl.amap.com"
  );
  const bad = parseUrl("https://example.com/x");
  t("白名单外的域名返回 UNSUPPORTED_HOST", bad && bad.error === "UNSUPPORTED_HOST");
}

console.log("\n真实 302 展开（6 条）");
{
  /* 本地起一个假的短链服务，模拟 surl → wb 的两次跳转。
     同时覆盖三种落点：URL 上带 p=、URL 上带 q=、坐标写在中转 HTML 里。 */
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/short-q")) {
      res.writeHead(302, {
        location: "/final-q?q=29.600741%2C106.525818%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7",
      });
      return res.end();
    }
    /* 逐跳关键回归：第一跳 Location 带 q=，但后续又 302 到「无坐标的通用首页」。
       旧实现 redirect:"follow" 只看最终 res.url，会拿到 /home 而返回 NO_COORD；
       云端 Worker 出口拿到的正是这种落地形态。 */
    if (req.url.startsWith("/short-q-migrate")) {
      res.writeHead(302, {
        location: "/hop-migrate?q=29.600741%2C106.525818%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7&amap_migrate_retry=1",
      });
      return res.end();
    }
    if (req.url.startsWith("/hop-migrate")) {
      res.writeHead(302, { location: "/home" });
      return res.end();
    }
    if (req.url.startsWith("/home")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html>高德地图 - 在线地图查询｜路线规划｜地点搜索</html>");
    }
    /* 302 落到 callAPP 中转页（移动 UA / 云端出口形态） */
    if (req.url.startsWith("/short-callapp")) {
      res.writeHead(302, {
        location: "/callapp?ios=viewMap%3FsourceApplication%3Dfrom_wb%26dev%3D0%26poiname%3Dx%26lat%3D29.600741%26lon%3D106.525818",
      });
      return res.end();
    }
    if (req.url.startsWith("/callapp")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html>唤起地图 App</html>");
    }
    if (req.url.startsWith("/short-q-html")) {
      res.writeHead(302, { location: "/html-q" });
      return res.end();
    }
    if (req.url.startsWith("/short-p-html")) {
      res.writeHead(302, { location: "/html-p" });
      return res.end();
    }
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
    if (req.url.startsWith("/html-q")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        '<a href="https://wb.amap.com/?q=29.600741%2C106.525818%2C%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7">打开地图</a>'
      );
    }
    if (req.url.startsWith("/html-p")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(
        '<a href="https://wb.amap.com/?p=B0FF%2C29.5631%2C106.5512%2C%E8%B0%8A%E5%93%81%2C%E8%B7%AF1%E5%8F%B7">打开地图</a>'
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const base = "http://127.0.0.1:" + port;

  const got = await expand(new URL(base + "/short"));
  t(
    "p= 落点：跟随两次跳转后取到坐标",
    got && got.lat === 29.5631 && got.lng === 106.5512,
    JSON.stringify(got)
  );
  t("p= 落点带出门店名", got && got.name === "谊品生鲜", got && got.name);

  const q = await expand(new URL(base + "/short-q"));
  t(
    "q= 落点：位置分享短链也能取到坐标（用户给的真实形态）",
    q && q.lat === 29.600741 && q.lng === 106.525818 && q.address === "佳园路2号",
    JSON.stringify(q)
  );

  const htmlQ = await expand(new URL(base + "/short-q-html"));
  t(
    "q= 写在中转 HTML 里也能解析，且不会取成「经度,名称」",
    htmlQ && htmlQ.lat === 29.600741 && htmlQ.lng === 106.525818,
    JSON.stringify(htmlQ)
  );
  const htmlP = await expand(new URL(base + "/short-p-html"));
  t(
    "p= 写在中转 HTML 里仍按 POI 格式解析（回归）",
    htmlP && htmlP.lat === 29.5631 && htmlP.lng === 106.5512,
    JSON.stringify(htmlP)
  );

  const dead = await expand(new URL(base + "/404"));
  t(
    "打不开的链接返回 NO_COORD 而不是抛错",
    dead && dead.error === "NO_COORD",
    JSON.stringify(dead)
  );

  /* 逐跳解析：第一跳 Location 带坐标，后续跳到无坐标首页也必须成功 */
  const migrated = await expand(new URL(base + "/short-q-migrate"));
  t(
    "第一跳带 q=、后续落到无坐标首页仍能取到坐标（逐跳解析，不看最终 URL）",
    migrated && migrated.lat === 29.600741 && migrated.lng === 106.525818,
    JSON.stringify(migrated)
  );
  const callapp = await expand(new URL(base + "/short-callapp"));
  t(
    "302 落到 callAPP 中转页（ios lat/lon）也能取到坐标",
    callapp && callapp.lat === 29.600741 && callapp.lng === 106.525818,
    JSON.stringify(callapp)
  );

  srv.close();
}

console.log("\n三家短链 302 逐跳展开（4 条）");
{
  /* 腾讯短链实测第一跳：302 → http://map.qq.com/m/map-app/share/poi?coord=lng,lat
     坐标就写在 Location 上，逐跳解析必须在这一跳命中（后续可能跳到无坐标的
     map.wap.qq.com 落地页）。本地桩用相对 Location 模拟，走「未知 host 兜底」。 */
  const srv2 = createServer((req, res) => {
    if (req.url.startsWith("/qq-short")) {
      res.writeHead(302, { location: "/qq-poi?coord=120.13792,30.216492&n=x&fromSource=share" });
      return res.end();
    }
    if (req.url.startsWith("/qq-poi")) {
      res.writeHead(302, { location: "/qq-home" }); /* 后续跳到无坐标首页 */
      return res.end();
    }
    if (req.url.startsWith("/qq-home")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html>腾讯地图</html>");
    }
    /* 百度短链偶发反爬 / 改版时，落地页可能没有内嵌坐标：expand 末尾
       仍要给明确错误，不能崩、不能静默。用相对 Location 保留 host。 */
    if (req.url.startsWith("/bd-short")) {
      res.writeHead(302, { location: "/bd-spa?poiShareId=p3f6074794bcf598975e8e582b9" });
      return res.end();
    }
    if (req.url.startsWith("/bd-spa")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html>百度地图 SPA（无坐标，坐标靠 JS 异步取）</html>");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv2.listen(0, r));
  const base2 = "http://127.0.0.1:" + srv2.address().port;

  const qq = await expand(new URL(base2 + "/qq-short"));
  t("腾讯短链第一跳 coord= 命中，不看最终落地页", qq && qq.lat === 30.216492 && qq.lng === 120.13792, JSON.stringify(qq));
  t("腾讯短链解析结果标记为 qq-share", qq && qq.kind === "qq-share", JSON.stringify(qq));

  /* 百度短链兜底：离线桩模拟「短链 → 无坐标 SPA」，验证 expand 不抛错、
     且不会因 body 已消费而触发未处理 rejection。正常情况坐标在落地页
     var data 里（见后面「百度 POI 短链」与「完整展开」用例）。 */
  const bd = await expand(new URL(base2 + "/bd-short"));
  t("百度 POI 短链展开不会抛错", bd && !!bd.error, JSON.stringify(bd));
  t("百度 POI 短链展开错误码可映射成中文提示", bd && ["BAIDU_POI_SHORTLINK", "NO_COORD"].includes(bd.error), JSON.stringify(bd));

  srv2.close();
}

console.log("\n坐标系统一：BD-09 / WGS-84 → GCJ-02（10 条）");
{
  /* 标准 GCJ-02 → BD-09 正向公式，用来造样本反解，锁死偏移方向不搞反。 */
  const X_PI = (Math.PI * 3000) / 180;
  const gcj02ToBd09 = (lat, lng) => {
    const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
    const th = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
    return { lat: z * Math.sin(th) + 0.006, lng: z * Math.cos(th) + 0.0065 };
  };
  const pts = [
    [30.216498, 120.137939, "杭州满觉陇"],
    [29.600741, 106.525818, "重庆佳园路"],
    [39.910103, 116.403743, "北京天安门"],
    [31.230416, 121.473701, "上海人民广场"],
    [22.543096, 114.057865, "深圳"],
  ];
  let worst = 0;
  for (const [lat, lng, name] of pts) {
    const bd = gcj02ToBd09(lat, lng);
    const back = bd09ToGcj02(bd.lat, bd.lng);
    const errM = Math.hypot(
      (back.lat - lat) * 111000,
      (back.lng - lng) * 111000 * Math.cos((lat * Math.PI) / 180)
    );
    worst = Math.max(worst, errM);
    t("BD-09 往返 " + name + " 误差 < 0.5 米", errM < 0.5, errM.toFixed(4) + "m");
  }
  t("五城最大往返误差 < 0.5 米", worst < 0.5, worst.toFixed(4) + "m");

  const w = wgs84ToGcj02(39.9087, 116.3975);
  t(
    "WGS-84 → GCJ-02 天安门落在预期偏移位（39.910,116.4036 附近）",
    Math.abs(w.lat - 39.9101) < 0.002 && Math.abs(w.lng - 116.4037) < 0.002,
    JSON.stringify(w)
  );
  t("境外坐标 WGS-84 → GCJ-02 不加偏", (() => {
    const o = wgs84ToGcj02(48.8566, 2.3522);
    return o.lat === 48.8566 && o.lng === 2.3522;
  })());
  t("toGcj02(gcj02) 原样直通", (() => {
    const g = toGcj02(30.216498, 120.137939, "gcj02");
    return g && g.lat === 30.216498 && g.lng === 120.137939;
  })());
  t("toGcj02(bd09) 确实发生换算（不是直通）", (() => {
    const g = toGcj02(30.222, 120.144, "bd09");
    return g && Math.abs(g.lat - 30.222) > 0.003;
  })());
  t("toGcj02(bd09mc 墨卡托) 明确拒绝", toGcj02(30, 120, "bd09mc") === null);
  t("toGcj02 缺省按 BD-09（与显式 bd09 一致）", (() => {
    const a = toGcj02(30.222, 120.144, "");
    const b = toGcj02(30.222, 120.144, "bd09");
    return a && b && a.lat === b.lat && a.lng === b.lng;
  })());
  t("hostKind 三家分流正确", (() => {
    return (
      hostKind("surl.amap.com") === "amap" &&
      hostKind("wb.amap.com") === "amap" &&
      hostKind("j.map.baidu.com") === "baidu" &&
      hostKind("api.map.baidu.com") === "baidu" &&
      hostKind("mmapgwh.map.qq.com") === "qq" &&
      hostKind("map.wap.qq.com") === "qq" &&
      hostKind("127.0.0.1") === null
    );
  })());
}

console.log("\n腾讯分享链接（GCJ-02，无需换算，8 条）");
{
  /* 实测短链第一跳：mmapgwh.map.qq.com/shortlink/short?l=xxx
     → http://map.qq.com/m/map-app/share/poi?s=1&coord=120.13792,30.216492&... */
  const first = parseUrl(
    "http://map.qq.com/m/map-app/share/poi?s=1&coord=120.13792,30.216492&centercoord=120.13792,30.216492&n=%E9%A9%AC%E7%81%AF%E9%83%A8%E8%90%BD&pt=0&fromSource=share"
  );
  t("第一跳 coord= 经度在前解析正确", first && first.lat === 30.216492 && first.lng === 120.13792, JSON.stringify(first));
  t("腾讯 link 标记为 qq-share", first && first.kind === "qq-share");
  t("腾讯坐标不做换算（与高德同点一致）", first && Math.abs(first.lat - 30.216498) < 0.0001, JSON.stringify(first));

  const short = parseUrl("https://mmapgwh.map.qq.com/shortlink/short?l=_9af4fe8c1d84611994475b57cc198a43");
  t("腾讯短链标记为 pending（需服务端展开）", short && short.pending && short.pending.hostname === "mmapgwh.map.qq.com");
  t("腾讯短链域名在白名单内", hostAllowed("mmapgwh.map.qq.com") && hostAllowed("map.wap.qq.com"));

  const mk = parseUrl("https://apis.map.qq.com/uri/v1/marker?marker=coord:30.216492,120.13792;title=%E9%A9%AC%E7%81%AF%E9%83%A8%E8%90%BD&referer=key");
  t("URI marker=coord:lat,lng 能解析（纬度在前）", mk && mk.lat === 30.216492 && mk.lng === 120.13792, JSON.stringify(mk));
  t("URI marker 的 title 还原（title= 写法）", mk && mk.name === "马灯部落", JSON.stringify(mk));
  t("URI marker 官方 title: 写法也能解析", (() => {
    const r = parseUrl("https://apis.map.qq.com/uri/v1/marker?marker=coord:30.216492,120.13792;title:马灯部落;addr:满觉陇&referer=key");
    return r && r.name === "马灯部落";
  })());
  t("coord= 顺序写反也能纠正", (() => {
    const r = parseUrl("https://map.qq.com/?coord=30.216492,120.13792");
    return r && r.lat === 30.216492 && r.lng === 120.13792;
  })());
}

console.log("\n百度带坐标长链（BD-09 → GCJ-02，9 条）");
{
  /* 实测同地点：高德 GCJ-02 = 30.216498,120.137939。
     用正向公式造出对应 BD-09，百度长链解析后应回到同一个点（误差 < 1 米）。 */
  const X_PI = (Math.PI * 3000) / 180;
  const gcjLat = 30.216498, gcjLng = 120.137939;
  const z = Math.sqrt(gcjLng * gcjLng + gcjLat * gcjLat) + 0.00002 * Math.sin(gcjLat * X_PI);
  const th = Math.atan2(gcjLat, gcjLng) + 0.000003 * Math.cos(gcjLng * X_PI);
  const bdLat = z * Math.sin(th) + 0.006, bdLng = z * Math.cos(th) + 0.0065;
  const near = (r) => r && Math.abs(r.lat - gcjLat) < 0.00002 && Math.abs(r.lng - gcjLng) < 0.00002;

  const at = parseUrl("https://map.baidu.com/@" + bdLng.toFixed(6) + "," + bdLat.toFixed(6) + ",18z");
  t("/@lng,lat,z 视野长链换算回 GCJ-02", near(at), JSON.stringify(at));
  t("/poi/名称/@lng,lat,z 也能解析", near(parseUrl("https://map.baidu.com/poi/%E9%A9%AC%E7%81%AF%E9%83%A8%E8%90%BD/@" + bdLng.toFixed(6) + "," + bdLat.toFixed(6) + ",17z")));

  const loc = parseUrl("https://api.map.baidu.com/marker?location=" + bdLat.toFixed(6) + "," + bdLng.toFixed(6) + "&output=html");
  t("location=lat,lng 默认按 BD-09 换算", near(loc), JSON.stringify(loc));

  const gdirect = parseUrl("https://api.map.baidu.com/marker?location=" + gcjLat.toFixed(6) + "," + gcjLng.toFixed(6) + "&output=html&coord_type=gcj02");
  t("coord_type=gcj02 直通不重复换算", gdirect && gdirect.lat === gcjLat && gdirect.lng === gcjLng, JSON.stringify(gdirect));
  t("coord_type=wgs84 走 WGS-84 换算", (() => {
    const r = parseUrl("https://api.map.baidu.com/marker?location=39.9087,116.3975&output=html&coord_type=wgs84");
    return r && Math.abs(r.lat - 39.910103) < 0.001;
  })());
  t("coord_type=bd09mc 墨卡托拒绝入库", parseUrl("https://api.map.baidu.com/marker?location=30,120&coord_type=bd09mc") === null || !!(parseUrl("https://api.map.baidu.com/marker?location=30,120&coord_type=bd09mc") || {}).pending);

  const xy = parseUrl("https://map.baidu.com/?x=" + bdLng.toFixed(6) + "&y=" + bdLat.toFixed(6));
  t("?x=lng&y=lat 老式参数换算", near(xy), JSON.stringify(xy));
  const dest = parseUrl("https://api.map.baidu.com/direction?destination=latlng:" + gcjLat.toFixed(6) + "," + gcjLng.toFixed(6) + "|name:x&coord_type=gcj02&output=html");
  t("destination=latlng: 路线页解析", dest && dest.lat === gcjLat && dest.lng === gcjLng, JSON.stringify(dest));
}

console.log("\n百度 POI 短链：交给 expand 展开 + 移动端详情页解析（8 条）");
{
  const s = parseUrl("https://j.map.baidu.com/6f/7C-k");
  t("j.map.baidu.com 短链返回 pending 去展开", s && !!s.pending, JSON.stringify(s));
  const s2 = parseUrl("https://map.baidu.com/?poiShareId=p3f6074794bcf598975e8e582b9");
  t("poiShareId 落地长链同样去展开", s2 && !!s2.pending, JSON.stringify(s2));
  t("百度短链不再在输入侧被直接判失败", !(s && s.error), JSON.stringify(s));
  t("百度 POI 域名仍在白名单（展开路径可达）", hostAllowed("j.map.baidu.com"));

  /* 百度移动端落地页 var data 的三种坐标写法（真实抓包样本，离线夹具） */
  const locHit = baiduHtmlToCoord('<script>var data = {"loc":{"lng":118.558334,"lat":30.581622}};</script>');
  t("落地页 loc（BD-09 经纬度）→ GCJ-02", locHit && Math.abs(locHit.lat - 30.575303) < 0.002 && Math.abs(locHit.lng - 118.551936) < 0.002, JSON.stringify(locHit));
  const ptHit = baiduHtmlToCoord('<script>var data = {"point":{"x":"13197996.92","y":"3556594.94"}};</script>');
  t("落地页 point（BD09MC 米）→ GCJ-02", ptHit && Math.abs(ptHit.lat - 30.575303) < 0.002 && Math.abs(ptHit.lng - 118.551936) < 0.002, JSON.stringify(ptHit));
  const geoHit = baiduHtmlToCoord('<script>var data = {"geo":"1|13374554,3510506;13374554,3510506|"};</script>');
  t("落地页 geo（BD09MC）→ 杭州满觉陇坐标", geoHit && Math.abs(geoHit.lat - 30.216514) < 0.002 && Math.abs(geoHit.lng - 120.137928) < 0.002, JSON.stringify(geoHit));
  t("PC 版无坐标落地页返回 null（不能误入库）", baiduHtmlToCoord("<html>百度地图 SPA</html>") === null);

  /* 三家 App 分享都可能带文案前缀：先从文本取链接，再走同一套判定 */
  t("带文案前缀的百度短链同样交给展开", (() => {
    const u = extractUrl("【百度地图】我在这里 https://j.map.baidu.com/6f/7C-k 快来看");
    const r = u && parseUrl(u.href);
    return r && !!r.pending;
  })());
  t("带文案前缀的腾讯链接能提取出短链", (() => {
    const u = extractUrl("【腾讯地图】马灯部落 https://mmapgwh.map.qq.com/shortlink/short?l=_9af4fe 点击查看");
    return u && u.hostname === "mmapgwh.map.qq.com";
  })());
}

console.log("\n百度墨卡托换算精度（3 条）");
{
  const bd = bd09mcToBd09(13197996.92, 3556594.94);
  t("MC→BD-09 与页面自带 loc 误差 < 1e-6 度", bd && Math.abs(bd.lng - 118.558334) < 1e-6 && Math.abs(bd.lat - 30.581622) < 1e-6, JSON.stringify(bd));
  t("非法输入返回 null 而不是 NaN", bd09mcToBd09(NaN, 1) === null && bd09mcToBd09(1, Infinity) === null);
  const g = toGcj02(bd.lat, bd.lng, "bd09");
  t("BD-09→GCJ-02 与直接解析 loc 一致", g && Math.abs(g.lat - 30.575303) < 0.002 && Math.abs(g.lng - 118.551936) < 0.002, JSON.stringify(g));
}

console.log("\n腾讯 H5 详情页长链「复制链接」（3 条）");
{
  const qq = parseUrl("https://map.wap.qq.com/online/h5-poi-detail-out/index.html?uid=6636858348472735699&s=1&coord=106.50543%2C29.593797&centercoord=106.50543%2C29.593797&m=106.50543%2C29.593797&c=106.50543%2C29.593797&n=%E9%87%8D%E5%BA%86%E5%B8%82%E5%8D%AB%E7%94%9F%E5%81%A5%E5%BA%B7%E5%A7%94%E5%91%98%E4%BC%9A&a=x&fromSource=share");
  t("map.wap.qq.com 在白名单", hostAllowed("map.wap.qq.com"));
  t("腾讯 H5 coord= 解出重庆两江新区坐标", qq && qq.lat === 29.593797 && qq.lng === 106.50543, JSON.stringify(qq));
  t("腾讯 H5 详情标记为 qq-share（GCJ-02 直通）", qq && qq.kind === "qq-share", JSON.stringify(qq));
}

console.log("\n百度短链完整展开：移动 UA + 落地页坐标（6 条）");
{
  /* 坐标放在 180KB 之后，验证 60KB 截断已被 320KB 上限取代 */
  const html = "<html>" + "x".repeat(180000) +
    '<script>var data={"content":{"ext":{"detail_info":{"point":{"x":"13197996.92","y":"3556594.94"}}}}};</script></html>';
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), ua: opts.headers["user-agent"] });
    if (String(url).includes("j.map.baidu.com")) {
      return new Response(null, { status: 302, headers: { location: "https://map.baidu.com/mobile/webapp/search/search/qt=inf&uid=1b4f40434dbe8ec616a19053/newmap=1" } });
    }
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  let r;
  try {
    r = await expand(new URL("https://j.map.baidu.com/91/HelM"), 4000);
  } finally {
    globalThis.fetch = realFetch;
  }
  t("展开拿到 GCJ-02 坐标", r && Math.abs(r.lat - 30.575303) < 0.002 && Math.abs(r.lng - 118.551936) < 0.002, JSON.stringify(r));
  t("结果标记为百度 HTML 解析", r && /^baidu-html/.test(r.kind || ""), JSON.stringify(r));
  t("共 2 跳（短链 → 移动端详情页）", seen.length === 2, String(seen.length));
  t("第 1 跳用移动端 UA", /Android/.test(seen[0]?.ua || ""), seen[0]?.ua);
  t("第 2 跳仍用移动端 UA", /Android/.test(seen[1]?.ua || ""), seen[1]?.ua);
  t("坐标在 180KB 之后仍能读到（320KB 上限生效）", !!(r && r.lat), JSON.stringify(r));
}

console.log("\n三家分流不串味（3 条）");
{
  /* 百度 URL 上的 q= 是搜索关键词，不能被高德 fromQParam 误读成坐标 */
  t("百度 ?q= 不被高德 q= 误判为坐标", (() => {
    const r = parseUrl("https://map.baidu.com/?q=30.216492,120.13792");
    return r && !r.lat && (r.pending || r.error);
  })());
  /* 腾讯 URL 上的 lat/lon 不该被高德 fromLatLon 抢先（腾讯只用 coord） */
  t("腾讯 coord= 优先于同名参数", (() => {
    const r = parseUrl("https://map.qq.com/?coord=120.13792,30.216492&lat=39.9&lon=116.4");
    return r && r.lat === 30.216492;
  })());
  t("高德原解析链路不受三家分流影响", (() => {
    const r = parseUrl("https://wb.amap.com/?q=29.600741,106.525818,%E4%BD%B3%E5%9B%AD%E8%B7%AF2%E5%8F%B7");
    return r && r.lat === 29.600741 && r.lng === 106.525818 && r.kind === "amap-share";
  })());
}

console.log("\n接线检查（10 条）");
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
    "编辑面板只留一个「导航地址」输入，没有单独的解析按钮",
    /id="editNavigation"/.test(DATA) && !/id="editGeo"/.test(DATA) && !/editGeoParse/.test(DATA)
  );
  t("保存时把坐标写进门店对象", /item\.lat=editGeo\?editGeo\.lat:null/.test(DATA));
  t(
    "提交更新时自动定位（不再依赖手动「批量定位」按钮）",
    /autoLocate\(stores/.test(DATA) && !/batchGeoBtn/.test(DATA)
  );
  t(
    "粘贴链接后自动解析（input 事件内触发 resolveGeo）",
    /\$\("editNavigation"\)\.addEventListener\("input"[\s\S]{0,400}?resolveGeo\(v\)/.test(DATA)
  );
  t(
    "保存按钮兜底解析（防抖未跑完也能拿到坐标）",
    /editSave"\)\.onclick=async\(\)=>\{[\s\S]{0,700}?await resolveGeo\(navText\)/.test(DATA)
  );
  t(
    "null 坐标不会被 Number() 当成 0 —— 否则 (0,0) 会显示已定位并跳过解析",
    /if\(v==null\|\|v===""\)return null/.test(DATA) && /const located=!!geoOfStore\(s\)/.test(DATA)
  );
  t("未定位角标只在缺坐标时渲染", /<em class="data-store-geo">未定位<\/em>/.test(DATA));
  t("首页 bundle 已打入坐标导航（mapnav 在打包清单里）", /uri\.amap\.com\/navigation/.test(BUNDLE));
}

console.log("\n" + (fail ? "❌ " : "✅ ") + `通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(failures.map((f) => "  · " + f).join("\n"));
  process.exit(1);
}
