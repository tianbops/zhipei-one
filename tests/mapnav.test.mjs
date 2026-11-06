/**
 * 门店导航目标契约（node tests/mapnav.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：点门店名能查看该门店位置；是否用 App 导航由司机在落地页里
 * 自己点「打开高德APP」决定，我们绝不自动弹出下载引导页（2026-11 真机回归）。
 *
 * 成熟 H5 范式（选择 → 打开 → 兜底，下载永远是用户主动动作）：
 *   1) 决定因素是**落地页类型**，不是 callnative。正式版 407 的 POI 详情 /
 *      搜索页在真机上不跳下载页；uri.amap.com/navigation 驾车路线页一进去
 *      就要开始导航，未装 App 时高德整页引到 ap.amap.com / wap-org.amap.com
 *      「立即下载」—— 416/417 都跳、正式版不跳，根因就在这里。
 *   2) 所以高德一律送「看位置」页：有坐标 → uri.amap.com/marker（位置标注页，
 *      落 m.amap.com/share/index）；无坐标 → uri.amap.com/search（门店名搜索页，
 *      落 m.amap.com/search/view）。**绝不用 /navigation，绝不带 callnative=1，
 *      绝不透传 surl.amap.com 短链**（callAPP 中转页未装 App 时超时兜底跳下载页）。
 *   3) 无坐标（含空 / 纯文本 / 非地图 URL / javascript: / data: / 地图短链）
 *      → 门店名走高德关键词，且**绝不允许**回到旧实现 new URL(v, location.origin)
 *      —— 那会把 "A栋B1" 解析成站内路径，点一下 404，返回键都救不回来；
 *   4) 白名单按「等于或以 .域名 结尾」匹配，防 amap.com.evil.com / amap.com@evil.com；
 *      navigation 链接仍进 payload.link，但只供百度分支判断，不生成高德 URL；
 *   5) 一律 https 官方链接，不用自建 scheme、不做安装探测；
 *   6) 起点不传，交给地图网页版 / App 的 GPS。
 *
 * 纯函数用 node:vm 跑，不需要浏览器；静态断言守住两个渲染器与打包顺序。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/mapnav.js", import.meta.url)), "utf8");
const CSS = readFileSync(resolve(fileURLToPath(new URL("../css/ui-overlay.css", import.meta.url))), "utf8");
const HOME_JS = readFileSync(fileURLToPath(new URL("../js/home/today.js", import.meta.url)), "utf8");
const RENDER_JS = readFileSync(fileURLToPath(new URL("../js/order_detail/render.js", import.meta.url)), "utf8");
const CORE_JS = readFileSync(fileURLToPath(new URL("../js/order_detail/core.js", import.meta.url)), "utf8");
const BUNDLE = readFileSync(fileURLToPath(new URL("../js/home.bundle.js", import.meta.url)), "utf8");

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* 在 vm 里加载两次：第二次验证幂等哨兵（重复加载不得覆盖已有实例） */
function load(opts = {}) {
  const ua = opts.ua || MOBILE_UA;
  const win = {
    navigator: { standalone: !!opts.standalone, userAgent: ua },
    matchMedia: (q) => ({ matches: /standalone/.test(q) ? !!opts.standalone : false }),
  };
  const ctx = createContext({ window: win, navigator: win.navigator, URL, encodeURIComponent });
  runInContext(SRC, ctx);
  const first = win.zpMapNav;
  runInContext(SRC, ctx);
  return { api: win.zpMapNav, first, win };
}

const { api: M, first: FIRST, win: WIN } = load();

const q = (url) => new URL(url).searchParams.get("keyword");
const isAmapSearch = (url) => {
  try { return new URL(url).hostname === "uri.amap.com" && new URL(url).pathname === "/search"; }
  catch { return false; }
};

console.log("高德链接一律不透传（5 条）");
{
  const cases = [
    ["高德短链", "https://surl.amap.com/abc"],
    ["百度短链（j.map.baidu.com 子域）", "https://j.map.baidu.com/xyz"],
    ["腾讯地图链接", "https://map.qq.com/?what=poi"],
    ["uri.amap.com/marker", "https://uri.amap.com/marker?position=106.5,29.5"],
  ];
  for (const [label, nav] of cases) {
    const r = M.resolve({ name: "谊品生鲜", navigation: nav });
    t(label + " 不透传、改走网页版关键词搜索",
      !!r && r.kind === "keyword" && isAmapSearch(r.url) &&
      !r.url.includes(nav) && !/surl\.amap|wb\.amap|callAPP/.test(r.url), JSON.stringify(r));
  }
  const d = M.resolve({ nav: "  https://uri.amap.com/marker?position=106.5,29.5  " });
  t("只有链接、没有门店名 → 不生成链接（不再靠链接硬凑可点行）", d === null, JSON.stringify(d));
}

console.log("\n非法 navigation 一律降级关键词（8 条）");
{
  const cases = [
    ["纯文本楼层", { name: "谊品生鲜", navigation: "A栋B1" }],
    ["空 navigation", { name: "谊品生鲜", navigation: "" }],
    ["javascript 伪协议", { name: "谊品生鲜", navigation: "javascript:alert(1)" }],
    ["data 伪协议", { name: "谊品生鲜", navigation: "data:text/html,<b>x</b>" }],
    ["ftp 协议", { name: "谊品生鲜", navigation: "ftp://amap.com/x" }],
    ["相对路径", { name: "谊品生鲜", navigation: "/abc" }],
    ["协议相对", { name: "谊品生鲜", navigation: "//surl.amap.com/x" }],
  ];
  for (const [label, store] of cases) {
    const r = M.resolve(store);
    t(label + " → 关键词搜索", !!r && r.kind === "keyword" && isAmapSearch(r.url), JSON.stringify(r));
  }
  const r = M.resolve({ name: "谊品生鲜", navigation: "A栋B1" });
  t("纯文本不会变成站内路径（不含站点 origin / 编码后的路径）",
    !!r && !/\/A%E6%A0%8BB1/.test(r.url) && q(r.url) === "谊品生鲜", r && r.url);
}

console.log("\n白名单防伪装（4 条）");
{
  const bad = [
    "https://amap.com.evil.com/x",
    "https://surl.amap.com.evil.com/x",
    "https://amap.com@evil.com/x",
    "https://evil.com/?u=amap.com",
  ];
  for (const nav of bad) {
    const r = M.resolve({ name: "谊品生鲜", navigation: nav });
    t("伪装域名拒绝：" + nav, !!r && r.kind === "keyword" && isAmapSearch(r.url), JSON.stringify(r));
  }
  t("isMapHost 直接判定：amap.com / 子域 / 伪装",
    M.isMapHost("amap.com") && M.isMapHost("surl.amap.com") && M.isMapHost("AMAP.COM.") &&
    !M.isMapHost("amap.com.evil.com") && !M.isMapHost("evilamap.com") && !M.isMapHost(""));
}

console.log("\n关键词链接构造 = 门店名搜索「看位置」页（5 条）");
{
  const r = M.resolve({ name: "渝北中景隆(重庆)贸易有限公司" });
  t("中文门店名正确编码，keyword 可还原",
    q(r.url) === "渝北中景隆(重庆)贸易有限公司", r.url);
  t("落地是 /search 门店名搜索页（不是 /navigation 路线页）",
    new URL(r.url).pathname === "/search" && !/\/navigation/.test(r.url), r.url);
  t("一律不带 callnative（不主动拉起 App，选择权留给司机）",
    new URL(r.url).searchParams.get("callnative") === null, r.url);
  t("带来源标识 src=zhipei", new URL(r.url).searchParams.get("src") === "zhipei");
  const desktop = load({ ua: DESKTOP_UA }).api.resolve({ name: "渝北中景隆(重庆)贸易有限公司" });
  t("桌面端与移动端 URL 完全一致（不再按 UA 分支）", desktop.url === r.url, desktop.url);
}

console.log("\n名称回退与空值（3 条）");
{
  const a = M.resolve({ name: "  ", rawName: "备用名", navigation: null });
  t("name 为空白时回退 rawName", a && a.kind === "keyword" && q(a.url) === "备用名");
  const b = M.resolve({ rawName: "", originalName: "OCR 原名" });
  t("rawName 为空时回退 originalName", b && q(b.url) === "OCR 原名");
  t("全空门店返回 null（渲染层据此退化为不可点行）",
    M.resolve({}) === null && M.resolve(null) === null && M.resolve({ name: " ", navigation: "" }) === null);
}

console.log("\n坐标优先 = 位置标注「看位置」页（7 条）");
{
  const g = M.resolve({ name: "谊品生鲜", lat: 29.5631, lng: 106.5512, navigation: "https://surl.amap.com/abc" });
  t("有坐标时走 /marker 位置标注页（不是 /navigation 驾车路线页）",
    !!g && g.kind === "geo" && new URL(g.url).pathname === "/marker" && !/\/navigation/.test(g.url), JSON.stringify(g));
  const u = new URL(g.url);
  t("position 是「经度,纬度」——顺序写反会导到几百公里外",
    (u.searchParams.get("position") || "").startsWith("106.551200,29.563100"), u.searchParams.get("position"));
  t("带 name=门店名（位置页显示门店标注）", u.searchParams.get("name") === "谊品生鲜", u.searchParams.get("name"));
  t("不带 mode=car（绝不主动进入导航流程，那是下载引导页入口）",
    u.searchParams.get("mode") === null, g.url);
  t("位置页 URL 一律不带 callnative（不主动拉起 App）",
    u.searchParams.get("callnative") === null, g.url);
  const zero = M.resolve({ name: "谊品生鲜", lat: 0, lng: 0 });
  t("0,0 视为无效坐标，退回关键词搜索", !!zero && zero.kind === "keyword", JSON.stringify(zero));
  const str = M.resolve({ name: "谊品生鲜", lat: "29.5631", lng: "106.5512" });
  t("字符串坐标也认（运单快照里的数值可能被序列化成字符串）", !!str && str.kind === "geo");
}

console.log("\n链接属性与幂等（4 条）");
{
  const normal = M.linkAttrs({ name: "谊品生鲜", navigation: "https://surl.amap.com/abc" });
  t("普通浏览器/壳：target=_self（返回键可回列表）", normal.target === "_self" && normal.rel === "");
  const standalone = load({ standalone: true }).api.linkAttrs({ name: "谊品生鲜" });
  t("iOS 主屏 standalone：target=_blank + noopener（否则困在高德页）",
    standalone.target === "_blank" && standalone.rel === "noopener");
  t("linkAttrs 对空门店返回 null", M.linkAttrs({}) === null);
  t("重复加载不覆盖已有实例（幂等哨兵）", WIN.zpMapNav === FIRST && !!FIRST.resolve);
}

console.log("\n三家 provider 目标（14 条）");
{
  const GEO = { name: "谊品生鲜长安锦绣城店", lat: 29.5631, lng: 106.5512 };
  const u = M.providerUrls(GEO);
  t("PROVIDERS 顺序为高德 / 百度 / 腾讯",
    M.PROVIDERS.map((p) => p.id).join(",") === "amap,baidu,qq", JSON.stringify(M.PROVIDERS.map((p) => p.id)));
  t("高德 note 说明「查看门店位置」且把是否用 App 交给用户选",
    M.PROVIDERS[0].note.includes("查看门店位置") && /由您选|自己选/.test(M.PROVIDERS[0].note),
    M.PROVIDERS[0].note);
  t("百度 / 腾讯 note 与高德同口径（看位置，App 由用户选）",
    M.PROVIDERS[1].note.includes("查看门店位置") && M.PROVIDERS[2].note.includes("查看门店位置"),
    JSON.stringify([M.PROVIDERS[1].note, M.PROVIDERS[2].note]));
  /* 2026-11-06 视觉收敛：名称居中、去掉每个选项下的重复说明与箭头，
     note 只作为 aria-label 保留语义，不再渲染成第三行小字。 */
  t("选项不再渲染说明小字与箭头",
    !/zp-mn-row-hint/.test(SRC) && !/zp-mn-arrow/.test(SRC),
    "mapnav.js 仍包含 hint/arrow 渲染");
  t("note 转为 aria-label，读屏仍能听到「看位置、App 由您选」",
    /setAttribute\("aria-label", p\.label \+ "：" \+ p\.note\)/.test(SRC), "缺少 aria-label 兜底");
  t("菜单标题与选项均居中",
    /\.zp-mn-head\{[^}]*text-align:center/.test(CSS) && /\.zp-mn-row\{[^}]*justify-content:center/.test(CSS),
    "标题或选项未居中");
  t("正常态不再有副标题（仅缺坐标时才补一行）",
    /if \(!urls\._geo\) head\.appendChild/.test(SRC), "副标题须由 _geo 条件控制");
  t("三家都有 https 目标", ["amap", "baidu", "qq"].every((k) => typeof u[k] === "string" && u[k].startsWith("https://")));
  t("有坐标时 _geo=true（菜单不出「按门店名搜索」兜底提示）", u._geo === true);

  const amap = new URL(u.amap);
  t("高德走 uri.amap.com/marker 位置标注页（不是 /navigation 路线页）",
    amap.hostname === "uri.amap.com" && amap.pathname === "/marker", u.amap);
  t("高德 position = 经度,纬度（写反会导到几百公里外）",
    (amap.searchParams.get("position") || "").startsWith("106.551200,29.563100"), amap.searchParams.get("position"));
  t("高德带 name=门店名 + 不带 mode/callnative（只标位置、不进导航流程）",
    amap.searchParams.get("name") === GEO.name &&
    amap.searchParams.get("mode") === null && amap.searchParams.get("callnative") === null, u.amap);

  /* 百度：位置页（marker）。曾经的 /direction 驾车路线页在移动端会先落
     「终点为空」的路线搜索、再退回地图首页 —— 真机录屏复现，必须锁死不许回退。 */
  const baidu = new URL(u.baidu);
  t("百度走 api.map.baidu.com/marker 位置页（不是 /direction 路线页）",
    baidu.hostname === "api.map.baidu.com" && baidu.pathname === "/marker", u.baidu);
  t("百度 location = 纬度,经度（与高德相反）",
    (baidu.searchParams.get("location") || "").startsWith("29.563100,106.551200"),
    baidu.searchParams.get("location"));
  t("百度带 title=门店名（位置页标题与底部卡片显示店名）",
    baidu.searchParams.get("title") === GEO.name, baidu.searchParams.get("title"));
  t("百度 content 传空格占位（不传会渲染字面的「内容」）",
    baidu.searchParams.get("content") === " ", JSON.stringify(baidu.searchParams.get("content")));
  t("百度 coord_type=gcj02 + output=html（百度自己转 BD-09，网页版兜底）",
    baidu.searchParams.get("coord_type") === "gcj02" && baidu.searchParams.get("output") === "html");
  t("百度不再带 /direction 的 mode=driving", baidu.searchParams.get("mode") === null, u.baidu);

  /* 腾讯：位置页（locationMarker 组件）。曾经 map.qq.com/?what= 在移动端只给
     地图首页，what/center 被忽略 —— 同样锁死不许回退。 */
  const qq = new URL(u.qq);
  t("腾讯走 mapapi.qq.com 的 locationMarker 位置页",
    qq.hostname === "mapapi.qq.com" && qq.pathname === "/web/mapComponents/locationMarker/v/index.html", u.qq);
  const mk = qq.searchParams.get("marker") || "";
  t("腾讯 marker = coord:纬度,经度;title:门店名", mk.startsWith("coord:29.563100,106.551200;title:" + GEO.name), mk);
  t("腾讯不再走 map.qq.com/?what= 的首页兜底",
    !u.qq.includes("map.qq.com/?") && qq.searchParams.get("what") === null, u.qq);
}

console.log("\n无坐标时三家各自降级（6 条）");
{
  const n = encodeURIComponent("谊品生鲜");
  const amapLink = "https://surl.amap.com/abc";
  const u = M.providerUrls({ name: "谊品生鲜", navigation: amapLink });
  t("有高德链接但无坐标 → 高德按门店名网页版搜索（绝不透传短链）",
    isAmapSearch(u.amap) && !u.amap.includes(amapLink) &&
    !/surl\.amap|callAPP|ap\.amap|callnative/.test(u.amap), u.amap);
  t("有高德链接但无坐标 → 百度按门店名走移动端搜索页",
    u.baidu === "https://map.baidu.com/mobile/webapp/search/search/qt=s&wd=" + n, u.baidu);
  t("有高德链接但无坐标 → 腾讯走 URI 搜索结果页（落 locationCluster）",
    u.qq.startsWith("https://apis.map.qq.com/uri/v1/search?keyword=" + n) &&
    u.qq.includes("referer="), u.qq);
  t("无坐标时 _geo=false", u._geo === false);
  const b = M.providerUrls({ name: "谊品生鲜", navigation: "https://j.map.baidu.com/xyz" });
  t("百度短链原样透传给百度", b.baidu === "https://j.map.baidu.com/xyz", b.baidu);
  t("百度短链不误当高德导航（走关键词搜索）", new URL(b.amap).pathname === "/search", b.amap);
}

console.log("\n真机回归：只送「看位置」页、不触发下载引导页（10 条）");
{
  const forbidden = /callnative|surl\.amap\.com|wb\.amap\.com|callAPP|ap\.amap\.com|wap\.amap\.com/;
  t("源码不再拼接 callnative 参数（注释里的说明文字不算）",
    !/\+\s*["']&callnative=/.test(SRC) && !/url\s*\+\s*["']&callnative/.test(SRC));
  t("源码不再透传短链给高德（无 out.amap = link）", !/out\.amap\s*=\s*link/.test(SRC));
  t("源码不再有 kind:\"link\"（渐进增强 href 也不透传）", !/kind:\s*"link"/.test(SRC));
  /* 决定性契约：绝不构造 uri.amap.com/navigation 驾车路线页。
     注释里会提到这个路径做说明，因此只匹配「字符串字面量里的 /navigation」。 */
  t("源码不再拼接 uri.amap.com/navigation（真机下载引导页的根因）",
    !/["']https:\/\/uri\.amap\.com\/navigation/.test(SRC) &&
    !/["']\/navigation\?to=/.test(SRC));
  t("源码改用 uri.amap.com/marker 位置标注页",
    /["']https:\/\/uri\.amap\.com\/marker\?position=/.test(SRC));
  const stores = [
    { label: "有坐标 + 高德短链", s: { name: "谊品生鲜", lat: 29.5631, lng: 106.5512, navigation: "https://surl.amap.com/abc" } },
    { label: "无坐标 + 高德短链", s: { name: "谊品生鲜", navigation: "https://surl.amap.com/abc" } },
    { label: "无任何链接", s: { name: "谊品生鲜" } },
  ];
  for (const { label, s } of stores) {
    const urls = [M.resolve(s).url, M.providerUrls(s).amap, M.keywordUrl(s.name),
      M.markerUrl({ lat: 29.5631, lng: 106.5512 }, s.name)];
    t(label + " → 四条高德 URL 都是 /marker 或 /search「看位置」页，且无下载域名/参数",
      urls.every((u) => {
        if (typeof u !== "string" || forbidden.test(u)) return false;
        const p = new URL(u).pathname;
        return (p === "/marker" || p === "/search") && !/\/navigation/.test(u);
      }), JSON.stringify(urls));
  }
  t("源码不再写「未装用网页版」（已被真机证伪）", !/未装用网页版/.test(SRC));
}

console.log("\n菜单载荷 navPayload / linkAttrs（6 条）");
{
  const GEO = { name: "谊品生鲜", lat: 29.5631, lng: 106.5512 };
  const p = JSON.parse(M.navPayload(GEO));
  t("payload 含 name/lat/lng", p.name === GEO.name && p.lat === GEO.lat && p.lng === GEO.lng);
  t("payload 不含 POI 名称 / 地址文本", !("address" in p) && !("kind" in p) && Object.keys(p).length === 4);
  const empty = JSON.parse(M.navPayload({ name: "谊品生鲜", lat: null, lng: null, navigation: "A栋B1" }));
  t("无效坐标写成 null（绝不写 0,0）", empty.lat === null && empty.lng === null);
  t("纯文字 navigation 不进 payload.link", empty.link === "");
  const withLink = JSON.parse(M.navPayload({ name: "谊品生鲜", navigation: "https://surl.amap.com/abc" }));
  t("白名单地图链接仍进 payload.link（仅百度分支使用，高德忽略）",
    withLink.link === "https://surl.amap.com/abc", withLink.link);
  const attrs = M.linkAttrs(GEO);
  t("linkAttrs 输出可反解的 payload",
    typeof attrs.payload === "string" && JSON.parse(attrs.payload).lat === GEO.lat);
}

console.log("\n菜单接线与零探测（3 条）");
{
  t("两个渲染器都输出 data-zp-nav-payload",
    /data-zp-nav-payload="/.test(HOME_JS) && /data-zp-nav-payload="/.test(RENDER_JS));
  t("mapnav.js 用冒泡委托且检查 defaultPrevented（不抢手势 / e2e 捕获阶段的点击）",
    /closest\("\[data-zp-nav-payload\]"\)/.test(SRC) && /e\.defaultPrevented/.test(SRC));
  t("零自建 scheme / 零安装探测",
    !/["'](?:qqmap|baidumap):\/\//.test(SRC) && !/addEventListener\(["']visibilitychange/.test(SRC));
}

console.log("\n渲染层与打包顺序（7 条）");
{
  t("首页渲染器不再用 new URL(..., location.origin)",
    !/new URL\([^)]*location\.origin/.test(HOME_JS) && !/safeUrl/.test(HOME_JS));
  t("详情渲染器不再用 new URL(..., location.origin)",
    !/new URL\([^)]*location\.origin/.test(RENDER_JS) && !/safeUrl/.test(RENDER_JS) && !/navOf\(/.test(RENDER_JS));
  t("core.js 不再定义 safeUrl / navOf", !/function safeUrl/.test(CORE_JS) && !/const navOf/.test(CORE_JS));
  t("两个渲染器都输出 data-zp-nav 标记",
    /data-zp-nav="/.test(HOME_JS) && /data-zp-nav="/.test(RENDER_JS));
  t("两个渲染器都引用 window.zpMapNav", /zpMapNav/.test(HOME_JS) && /zpMapNav/.test(RENDER_JS));

  const bundleNav = BUNDLE.indexOf("window.zpMapNav =");
  const bundleToday = BUNDLE.indexOf("const TODAY_SNAP_KEY");
  t("bundle 里 mapnav 早于 today.js（快照首帧要能点）",
    bundleNav > -1 && bundleToday > -1 && bundleNav < bundleToday, `${bundleNav} / ${bundleToday}`);

  const pages = ["../pages/order_detail.html", "../pages/today.html"].map((p) => ({
    p,
    html: readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"),
  }));
  const orderOk = pages.every(({ html }) => {
    const a = html.indexOf("/js/ui/mapnav.js?v=");
    const b = html.indexOf("/js/order_detail/render.js?v=");
    return a > -1 && b > -1 && a < b;
  });
  t("详情页与今日运单页都在 render.js 之前引入 mapnav", orderOk);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
