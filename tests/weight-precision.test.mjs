/**
 * 统计口径：重量 3 位小数 + 「X单 X家 Xt」三项（tests/weight-precision.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30，用户反馈）：
 *   1. 重量原来保留 2 位小数（1.50t），对账时与运单原件差几百克，看不出差在哪；
 *      改为 3 位（1.500t）并**全局统一**——今日卡、月度统计、历史月份、订单详情、导出 CSV
 *      必须是同一个口径，否则同一批货在首页与详情页显示不同数字，比精度不够更糟。
 *   2. 首页「今日配送」「月度统计」与历史页「月份统计」统一成「X单 X家 Xt」三项：
 *      原来今日卡只有「23家 1.50t」、月度卡只有「24单 25.59t」、历史月份只有「24天 25.59t」，
 *      三个地方三种口径，司机对不上账。
 *
 * 为什么需要这层护栏：
 *   - 小数位是「复制粘贴式」的散点改动（5 个文件 10 处），最容易漏一处；
 *   - 漏掉的那一处不会报错，只会在某一块界面上安静地显示 2 位；
 *   - 所以既做**全仓扫描**（不允许存在 2 位重量的写法），也做**行为求值**
 *     （fmtWeight 真的输出 3 位），两者互补。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* 构建产物与报告目录不参与扫描：它们由源文件生成，改了源就会重建。
 * js/home.bundle.js 由 scripts/build-home-bundle.mjs 从 js/home/*.js 生成。 */
const SKIP_DIR = new Set(["node_modules", "coverage", ".git", "downloads", "tests"]);
const SKIP_FILE = new Set(["js/home.bundle.js", "css/home.bundle.css", "sw.js"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    const rel = full.slice(ROOT.length).replace(/^\/+/, "");
    if (SKIP_FILE.has(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if ([".js", ".mjs", ".cjs", ".html"].includes(extname(name))) out.push({ rel, text: readFileSync(full, "utf8") });
  }
  return out;
}
const FILES = [...walk(join(ROOT, "js")), ...walk(join(ROOT, "functions")), ...walk(join(ROOT, "pages")),
  { rel: "home.html", text: read("home.html") }, { rel: "admin.html", text: read("admin.html") }];

/* ===== 一、全仓扫描：不允许重量停留在 2 位 ===== */
const twoDigit = FILES.filter((f) => /toFixed\(2\)/.test(f.text)).map((f) => f.rel);
t("全仓不存在 toFixed(2)（重量已统一 3 位）", twoDigit.length === 0, twoDigit.join(", "));

const roundTwo = FILES.filter((f) => /\*\s*100\s*\)\s*\/\s*100/.test(f.text)).map((f) => f.rel);
t("全仓不存在 *100/100 的两位取整（与 toFixed 同源）", roundTwo.length === 0, roundTwo.join(", "));

const twoPlaceholder = FILES.filter((f) => /['"]0\.00['"]/.test(f.text)).map((f) => f.rel);
t("占位符也是 0.000，不是 0.00", twoPlaceholder.length === 0, twoPlaceholder.join(", "));

/* ===== 二、关键位置必须 3 位 ===== */
const HISTORY_CORE = read("js/history/core.js");
t("历史页 fmtWeight 3 位（*1000/1000 + toFixed(3)）",
  /Math\.round\(\(Number\(v\)\|\|0\)\*1000\)\/1000\)\.toFixed\(3\)/.test(HISTORY_CORE));

const OD_CORE = read("js/order_detail/core.js");
t("订单详情 fmtWeight 3 位",
  /function fmtWeight\(v\)\{[^}]*\*1000\)\/1000\)\.toFixed\(3\)[^}]*'0\.000'\}/.test(OD_CORE));

const MONTHLY = read("js/home-monthly.js");
t("月度统计汇总 3 位", /animateNumber\(weightEl,weight,v=>v\.toFixed\(3\)\)/.test(MONTHLY));
t("月度统计图表提示 3 位", /x\.weight\.toFixed\(3\)\+"t"/.test(MONTHLY) && /peak\.weight\.toFixed\(3\)\+"t"/.test(MONTHLY));
t("年度视图 3 位（两处 fmtV）", (MONTHLY.match(/isW\?v\.toFixed\(3\)\+"t"/g) || []).length === 2);

const TODAY = read("js/home/today.js");
t("今日卡重量 3 位", /Math\.round\(\(Number\(w\.totalWeight\)\|\|0\)\*1000\)\/1000\)\.toFixed\(3\)\+"t"/.test(TODAY));

const EXPORT = read("functions/api/history-export.js");
t("导出 CSV 重量 3 位", /\* 1000\) \/ 1000\)\.toFixed\(3\)/.test(EXPORT));

/* ===== 三、「X单 X家 Xt」三项 ===== */
const HOME_HTML = read("home.html");
t("今日卡有单量元素且在家数之前",
  HOME_HTML.indexOf('id="todayOrders"') > 0 &&
  HOME_HTML.indexOf('id="todayOrders"') < HOME_HTML.indexOf('id="todayCount"'));
t("月度统计有家数元素", /<b id="trendStores">0<\/b><i>家<\/i>/.test(HOME_HTML));
t("月度统计初始重量是 0.000", /<b id="trendWeight">0\.000<\/b>/.test(HOME_HTML));

t("今日卡渲染「N单」", /todayOrders\.textContent=\(dayOrders>0\?dayOrders:1\)\+"单"/.test(TODAY));
t("今日卡单量有三层来源（latest/当日历史/月度索引）",
  (TODAY.match(/dayOrders=/g) || []).length >= 3,
  String((TODAY.match(/dayOrders=/g) || []).length));
t("latest 接口回传当日单数 dayCount",
  /dayCount:list\.length/.test(read("functions/api/waybills/latest.js")));

t("月度视图汇总家数", /const stores=data\.reduce\(\(s,x\)=>s\+x\.stores,0\)/.test(MONTHLY));
t("月度视图把家数写进汇总", /animateNumber\(storesEl,stores,v=>String\(Math\.round\(v\)\)\)/.test(MONTHLY));
t("年度视图汇总家数（取 byMonth.totalStores）",
  /const stores=months\.reduce\(\(s,mk\)=>\{const x=byMonth\.get\(mk\);return s\+\(x\?Number\(x\.totalStores\)\|\|0:0\);\},0\)/.test(MONTHLY));
t("按月数据带上门店家数", /stores:Number\(item\?\.storeCount\)\|\|0/.test(MONTHLY));

/* 历史页月份条：单量 / 家数 / 重量三项 */
const HISTORY_RENDER = read("js/history/render.js");
t("历史月份条汇总单量", /totalOrders=items\.reduce\(\(n,x\)=>n\+\(Number\(x\.count\)\|\|0\),0\)/.test(HISTORY_RENDER));
t("历史月份条汇总家数", /totalStores=items\.reduce\(\(n,x\)=>n\+\(Number\(x\.storeCount\)\|\|0\),0\)/.test(HISTORY_RENDER));
t("历史月份条文案是「X单 · X家 · Xt」",
  /totalOrders\+"单 · "\+totalStores\+"家 · "\+fmtWeight\(totalWeight\)/.test(HISTORY_RENDER));

/* ===== 四、行为求值 ===== */
/* 历史页 fmtWeight 在 core.js 顶层，会读一堆 DOM —— 这里只取它需要的空桩。 */
const histCtx = createContext({
  document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
  window: {}, location: { search: "" },
  Intl, String, Number, Math, Object, Array, Map, Set, JSON, URLSearchParams,
});
runInContext(HISTORY_CORE, histCtx, { filename: "history/core.js" });
const histFmt = (v) => runInContext(`fmtWeight(${JSON.stringify(v)})`, histCtx);
t("历史页 1.2345 → 1.235t", histFmt(1.2345) === "1.235t", String(histFmt(1.2345)));
t("历史页 1.2344 → 1.234t（不进位）", histFmt(1.2344) === "1.234t", String(histFmt(1.2344)));
t("历史页 0 → 0.000t", histFmt(0) === "0.000t", String(histFmt(0)));
t("历史页空值 → 0.000t", histFmt(null) === "0.000t", String(histFmt(null)));
t("历史页 25.59 补成 25.590t（旧数据不丢零）", histFmt(25.59) === "25.590t", String(histFmt(25.59)));

const odCtx = createContext({
  document: { getElementById: () => null },
  window: {}, location: { search: "" },
  Intl, String, Number, Math, Object, Array, Map, Set, JSON, URLSearchParams,
});
runInContext(OD_CORE, odCtx, { filename: "order_detail/core.js" });
const odFmt = (v) => runInContext(`fmtWeight(${JSON.stringify(v)})`, odCtx);
t("详情页 1.2345 → 1.235", odFmt(1.2345) === "1.235", String(odFmt(1.2345)));
t("详情页 NaN → 0.000", odFmt(NaN) === "0.000", String(odFmt(NaN)));
t("详情页字符串数字 → 3 位", odFmt("12.5") === "12.500", String(odFmt("12.5")));

console.log(`\n统计口径（重量 3 位 + 单/家/吨）：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
