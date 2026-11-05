/**
 * 门店导航目标契约（node tests/mapnav.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：点门店名能唤起地图（终点=该门店），没装地图 App 时降级网页版。
 *
 * 实现要点（改了就会出事，必须锁死）：
 *   1) navigation 是地图域名下的 http(s) 链接 → 原样透传（链接自带精确 POI）；
 *   2) 其余（空 / 纯文本 / 非地图 URL / javascript: / data:）→ 门店名走高德关键词，
 *      且**绝不允许**回到旧实现 new URL(v, location.origin) —— 那会把 "A栋B1"
 *      解析成站内路径，点一下 404，返回键都救不回来；
 *   3) 白名单按「等于或以 .域名 结尾」匹配，防 amap.com.evil.com / amap.com@evil.com；
 *   4) 唤起用 https 智能链接（callnative=1 仅移动端），不用自建 scheme；
 *   5) 起点不传，交给地图 App 的 GPS。
 *
 * 纯函数用 node:vm 跑，不需要浏览器；静态断言守住两个渲染器与打包顺序。
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/ui/mapnav.js", import.meta.url)), "utf8");
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

console.log("地图链接直传（4 条）");
{
  const a = M.resolve({ navigation: "https://surl.amap.com/abc" });
  t("高德短链原样透传", a && a.kind === "link" && a.url === "https://surl.amap.com/abc", JSON.stringify(a));
  const b = M.resolve({ navigation: "https://j.map.baidu.com/xyz" });
  t("百度短链（j.map.baidu.com 子域）命中白名单", b && b.kind === "link" && b.url === "https://j.map.baidu.com/xyz");
  const c = M.resolve({ navigation: "https://map.qq.com/?what=poi" });
  t("腾讯地图链接命中白名单", c && c.kind === "link");
  const d = M.resolve({ nav: "  https://uri.amap.com/marker?position=106.5,29.5  " });
  t("navigation 为空时回退 nav 字段（先 trim）", d && d.kind === "link" && d.url === "https://uri.amap.com/marker?position=106.5,29.5");
}

console.log("\n非链接一律降级关键词（8 条）");
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

console.log("\n关键词链接构造（4 条）");
{
  const r = M.resolve({ name: "渝北中景隆(重庆)贸易有限公司" });
  t("中文门店名正确编码，keyword 可还原",
    q(r.url) === "渝北中景隆(重庆)贸易有限公司", r.url);
  t("移动端带 callnative=1（已装唤起 App / 未装留网页）",
    new URL(r.url).searchParams.get("callnative") === "1");
  t("带来源标识 src=zhipei", new URL(r.url).searchParams.get("src") === "zhipei");
  const desktop = load({ ua: DESKTOP_UA }).api.resolve({ name: "谊品生鲜" });
  t("桌面端不带 callnative", new URL(desktop.url).searchParams.get("callnative") === null, desktop.url);
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

console.log("\n坐标优先（6 条）");
{
  const g = M.resolve({ name: "谊品生鲜", lat: 29.5631, lng: 106.5512, navigation: "https://surl.amap.com/abc" });
  t("有坐标时走 navigation（真导航），不再停在 POI 页", !!g && g.kind === "geo" && /uri\.amap\.com\/navigation/.test(g.url), JSON.stringify(g));
  const u = new URL(g.url);
  t("to 参数是「经度,纬度,名称」——顺序写反会导到几百公里外",
    (u.searchParams.get("to") || "").startsWith("106.551200,29.563100"), u.searchParams.get("to"));
  t("带 mode=car（驾车路线）", u.searchParams.get("mode") === "car");
  t("移动端带 callnative=1", u.searchParams.get("callnative") === "1");
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
