/**
 * geoFrom 链接指纹 / 「只存坐标」/ 三家导航菜单 / 安卓物理返回 契约
 * ------------------------------------------------------------------
 * 用户决策（同批做，2026-11-05）：
 *   1) 接受新增 geoFrom 一个字段：换地址链接提交后必须重新解析并关联门店；
 *   2) 保留腾讯占位，用网页版搜索兜底；
 *   3) 同批做数据层清理：只存坐标，不再记录/回补名称与地址文本；
 *   4) 修复安卓手势返回数据中心不回线路维护页。
 *
 * 前三条是「数据正确性」问题，光看静态字符串不够：needsGeo / geoOfStore /
 * geoFingerprint 是真会跑的纯函数，这里直接从 pages/data.html 内联脚本里
 * 抽出来放进 node:vm 执行，验证「换了链接但旧坐标还在」一定会重解析。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const html = read("pages/data.html");
const mapnav = read("js/ui/mapnav.js");
const today = read("js/home/today.js");
const render = read("js/order_detail/render.js");
const overlay = read("css/ui-overlay.css");
const back = read("js/ui/back.js");
const dispatch = read("pages/dispatch.html");
const geoApi = read("functions/api/store/geo.js");
const base = read("functions/api/base.js");
const latest = read("functions/api/waybills/latest.js");
const history = read("functions/api/_history-read.js");
const confirm = read("functions/api/waybills/confirm.js");

let pass = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) pass++;
  else failures.push(name + (extra ? " → " + extra : ""));
};

/* ===== 1. 纯函数：抽取 data.html 内联脚本里的坐标判定链，在 vm 里真跑 ===== */
const start = html.indexOf("function numOf(");
const stop = html.indexOf("function geoReasonText(");
t("坐标判定函数段可抽取", start > 0 && stop > start);
const fns = runInNewContext(
  html.slice(start, stop) + "\n({needsGeo,geoFingerprint,geoOfStore,navUrlOf,numOf})",
  {}
);
const LINK = "https://surl.amap.com/9Xhz3TMYbR2";
const LINK2 = "https://surl.amap.com/AAAAAAAAAAA";
const fp = fns.geoFingerprint(LINK);

t("geoFingerprint 输出 8 位十六进制（服务端 fingerprint 不会归零）",
  /^[a-f0-9]{8}$/.test(fp) && /^[a-f0-9]{8,32}$/i.test(fp), fp);
t("空链接指纹为空", fns.geoFingerprint("") === "");
t("不同链接指纹不同", fp !== fns.geoFingerprint(LINK2));
t("同一链接指纹稳定（可重复判定）", fp === fns.geoFingerprint(LINK));

/* 前后端同一 FNV-1a：服务端缓存键 hash() 与前端指纹只差 padStart(8,"0") */
const hStart = geoApi.indexOf("function hash(s)");
const hStop = geoApi.indexOf("async function resolveOne");
t("服务端 hash() 可抽取", hStart > 0 && hStop > hStart);
const hash = runInNewContext(geoApi.slice(hStart, hStop) + "\nhash", {});
t("前后端坐标链接指纹算法一致",
  fns.geoFingerprint(LINK) === hash(LINK).padStart(8, "0"),
  fns.geoFingerprint(LINK) + " / " + hash(LINK));

t("navUrlOf 从带文案分享文本里提取链接",
  fns.navUrlOf("【高德地图】我在这里 " + LINK + " 快来看") === LINK);
t("navUrlOf 对纯文字地址返回空", fns.navUrlOf("A栋B1") === "");

t("null 坐标不算已定位", fns.geoOfStore({ lat: null, lng: null }) === null);
t("0,0 不算已定位", fns.geoOfStore({ lat: 0, lng: 0 }) === null);
t("越界坐标不算已定位", fns.geoOfStore({ lat: 5, lng: 106.5 }) === null);
t("合法坐标带出 geoFrom",
  fns.geoOfStore({ lat: 29.5631, lng: 106.5512, geoFrom: fp }).geoFrom === fp);

/* needsGeo：换链接必须重解析（本轮核心缺陷） */
t("无坐标 → 需解析", fns.needsGeo({ navigation: LINK, lat: null, lng: null }) === true);
t("有坐标但无 geoFrom（历史数据）→ 需重解析",
  fns.needsGeo({ navigation: LINK, lat: 29.5631, lng: 106.5512, geoFrom: "" }) === true);
t("链接与 geoFrom 一致 → 不重解析",
  fns.needsGeo({ navigation: LINK, lat: 29.5631, lng: 106.5512, geoFrom: fp }) === false);
t("换了链接但旧坐标还在 → 必须重解析",
  fns.needsGeo({ navigation: LINK2, lat: 29.5631, lng: 106.5512, geoFrom: fp }) === true);
t("带文案的分享文本也能参与指纹比对",
  fns.needsGeo({ navigation: "【高德地图】" + LINK, lat: 29.5631, lng: 106.5512, geoFrom: fp }) === false);
t("没有链接 → 不解析（纯文字备注不发外网）",
  fns.needsGeo({ navigation: "A栋B1", lat: null, lng: null }) === false);

/* ===== 2. 数据页：换链接提交时的清旧坐标与重新关联 ===== */
t("autoLocate 先清待重解析门店的旧坐标（解析失败不留旧终点）",
  html.includes('targets.forEach(s=>{s.lat=null;s.lng=null;s.geoFrom=""})'));
t("autoLocate 成功写回坐标与链接指纹",
  html.includes("s.lat=it.lat;s.lng=it.lng;s.geoFrom=geoFingerprint(navUrlOf(s.navigation))"));
t("编辑保存把 geoFrom 写回门店对象",
  html.includes('item.geoFrom=editGeo?(editGeo.geoFrom||""):""'));
t("粘贴解析成功时生成 geoFrom",
  html.includes("geoFrom:geoFingerprint(navUrlOf(v)||v)"));
t("提交更新的 pending 用 needsGeo 判定（换链接也算待解析）",
  html.includes("const pending=stores.filter(needsGeo).length"));
t("编辑保存解析失败时同步清坐标", html.includes("item.lat=editGeo?editGeo.lat:null"));
t("失败反馈按原因分布且可「重新识别」",
  html.includes("const detail=Object.keys(reasons)") && html.includes('"重新识别"'));

/* ===== 3. 数据层：只存坐标，不再记录/回补名称与地址文本 ===== */
t("geo 接口定义字段投影 project()（只含 lat/lng/kind）",
  geoApi.includes("const project = (g) => ({ lat: g.lat, lng: g.lng, kind: text(g.kind) });"));
t("project 定义里不含 name/address",
  !/const project[^\n]*\b(name|address)\b/.test(geoApi));
const projCalls = (geoApi.match(/\bproject\(/g) || []).length;
t("所有成功分支都过 project() 投影", projCalls >= 4, "调用 " + projCalls + " 处");
t("30 天缓存写入投影后的结果（历史缓存不带外部文本回流）",
  geoApi.includes("JSON.stringify(out)"));
t("base.js normalizeStore 不再写 address",
  !/normalizeStore[\s\S]{0,500}\baddress\b/.test(base));
t("base.js normalizeStore 保存 geoFrom",
  /normalizeStore[\s\S]{0,500}geoFrom:fingerprint\(s\.geoFrom\)/.test(base));
t("base.js fingerprint 只收 8-32 位十六进制",
  base.includes("/^[a-f0-9]{8,32}$/i"));
t("最新运单不再回补 baseStore.address",
  !/baseStore\.address/.test(latest) && latest.includes("...(geo||{})"));
t("历史运单不再回补 baseStore.address",
  !/baseStore\.address/.test(history) && history.includes("...(geo||{})"));
t("学习确认新增门店写 geoFrom 而非 address",
  confirm.includes('geoFrom:""') && !/target=\{[^}]*address:/.test(confirm));

/* ===== 4. 三家 provider + 每次点门店名弹菜单 ===== */
t("PROVIDERS 固定高德/百度/腾讯三家",
  ['{ id: "amap"', '{ id: "baidu"', '{ id: "qq"'].every((s) => mapnav.includes(s)));
t("providerUrls 覆盖三家出口",
  ["out.amap", "out.baidu", "out.qq"].every((s) => mapnav.includes(s)));
t("腾讯用免 key 网页版搜索占位，不用需 referer 的 URI API",
  mapnav.includes("https://map.qq.com/?what=") && !mapnav.includes("apis.map.qq.com/uri"));
t("零自建 scheme（不弹 iOS 未装错误框）",
  !/["'](?:qqmap|baidumap|amapuri):\/\//.test(mapnav));
t("零「已安装」探测（不做 visibilitychange + 超时双跳）",
  !/addEventListener\(["']visibilitychange/.test(mapnav));
t("点击委托挂在 data-zp-nav-payload 上",
  mapnav.includes('closest("[data-zp-nav-payload]")'));
t("菜单按 provider 生成行", mapnav.includes('setAttribute("data-provider", p.id)'));
t("菜单注册 rank 8 返回钩子（系统返回先关菜单）",
  /rank:\s*8/.test(mapnav) && mapnav.includes("zpBackHooks"));
t("首页/详情/数据页都输出 data-zp-nav-payload",
  [html, today, render].every((s) => s.includes("data-zp-nav-payload")));
t("菜单样式在共用浮层样式表里（不新增页面引入）",
  [".zp-mn-bg", ".zp-mn-sheet", ".zp-mn-row"].every((c) => overlay.includes(c)));
t("数据页引入 mapnav.js", /\/js\/ui\/mapnav\.js\?v=/.test(html));

/* ===== 5. 安卓系统手势返回 ===== */
t("back.js 放行「父级 → 子页」普通 push", back.includes("function zpPushChildParent("));
t("父页写入 sessionStorage 标记、子页消费 zpCameByPush",
  back.includes("zpNavPushParent") && back.includes("let zpCameByPush=false"));
t("zpHandleBack 接收 fromPopstate 参数",
  back.includes("window.zpHandleBack=async function(fromPopstate)"));
t("顶栏/原生壳返回走物理后退消费父级记录",
  back.includes('try{history.back();return "leave"}catch(e){}'));
t("popstate 路径传 true，不二次 history.back()",
  back.includes("const r=await zpHandleBack(true)"));
t("click 拦截放行子页 push（不再一律 replace）",
  back.includes("if(zpPushChildParent(url.pathname))return;"));
t("线路维护入口带 from=dispatch", dispatch.includes("/pages/data?from=dispatch"));

console.log(`geoFrom / 只存坐标 / 三家菜单 / 安卓返回：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  failures.forEach((f) => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ 换链接强制重解析、坐标不污染收货地址、三家菜单、物理返回链路均已锁死");
