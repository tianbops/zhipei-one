/**
 * 启动显示优化守卫测试（node tests/home-startup-skeleton.test.mjs）
 * ------------------------------------------------------------------
 * 2026-10-30：启动序列「黑 splash → 深色空窗 → 浅页面 + 空卡」的 Web 侧优化：
 *   ① 首页骨架屏：今日卡列表占位条 + 月度统计卡首帧出框架（is-skel）；
 *   ② 本地快照秒开：今日卡 zp_home_today_v1 / 历史窗口 zp_home_hist_v1，
 *      启动先渲染快照（SWR），网络返回后覆盖渲染。
 * 本测试静态锁定这些改动不被回退；真浏览器行为验证见 tests/e2e-startup-skeleton.cjs。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => readFileSync(root + f, "utf8");

let pass = 0, fail = 0;
const fails = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };

/* ---------- 1. home.html：骨架 DOM ---------- */
const html = read("home.html");

t("趋势卡首帧可见（不再 hidden）且带 is-skel 骨架态",
  /<section class="trend-card is-skel" id="trendCard"/.test(html) && !/id="trendCard"[^>]*hidden/.test(html));
t("趋势卡图表位有骨架条（skel-chart）", html.includes('class="trend-skel skel-chart"'));
t("趋势卡汇总位有骨架条（skel-stats）", html.includes('class="trend-skel skel-stats"'));
{
  const list = html.match(/<div class="today-store-list"[\s\S]*?<\/div>\s*<div class="today-metrics"/);
  t("今日卡列表有 4 行骨架占位", !!list && (list[0].match(/skel-bar skel-idx/g) || []).length === 4);
}

/* ---------- 2. CSS：骨架样式与令牌 ---------- */
const cssHome = read("css/home-base.css");
const cssTrend = read("css/home-trend.css");
const cssBundle = read("css/home.bundle.css");

t("home-base.css：骨架 keyframes 独立命名（zpSkeleton 在 data.css，不进首页 bundle）",
  /@keyframes zpSkelHome/.test(cssHome) && !/@keyframes zpSkeleton/.test(cssHome));
t("home-base.css：.skel-bar 用全局 --zp-sk 令牌（深浅色自动适配）",
  /\.skel-bar\{[\s\S]*?var\(--zp-sk-a\)[\s\S]*?var\(--zp-sk-b\)/.test(cssHome.replace(/\n/g, "")));
t("home-base.css：骨架行带 reduced-motion 降级",
  /@media\(prefers-reduced-motion:reduce\)\{\.skel-bar\{animation:none\}\}/.test(cssHome));
t("home-trend.css：is-skel 期间禁交互（防骨架期点控件）",
  /\.trend-card\.is-skel\{pointer-events:none\}/.test(cssTrend));
t("home-trend.css：is-skel 期间隐藏真实汇总行、显示骨架",
  /\.trend-card\.is-skel \.trend-bottom-row\{display:none\}/.test(cssTrend) &&
  /\.trend-card\.is-skel \.trend-skel\{display:block\}/.test(cssTrend));
t("home.bundle.css 已包含骨架样式", cssBundle.includes("zpSkelHome") && cssBundle.includes(".trend-card.is-skel{pointer-events:none}"));

/* ---------- 3. JS：快照读写与 SWR ---------- */
const today = read("js/home/today.js");
const monthly = read("js/home-monthly.js");
const glue = read("scripts/home-bundle-glue.frag");
const jsBundle = read("js/home.bundle.js");

t("today.js：快照渲染与新数据渲染共用同一函数（防两份实现漂移）",
  /function zpRenderTodayCard\(/.test(today) &&
  /zpRenderTodayCard\(w,dayOrders,false\)/.test(today) &&
  /zpRenderTodayCard\(snap\.waybill,Number\(snap\.dayOrders\)\|\|0,true\)/.test(today));
t("today.js：快照限当天（日期不一致自动失效）",
  /s\.date===zpTodayKey\(\)/.test(today));
t("today.js：快照渲染不回写（fromCache 时禁止旧数据自我续命）",
  /if\(!fromCache\)\{[\s\S]*?TODAY_SNAP_KEY/.test(today));
t("today.js：重量仍为 3 位小数口径", /toFixed\(3\)\+"t"/.test(today));

t("home-monthly.js：历史响应成功后写快照（zp_home_hist_v1）",
  /HIST_CACHE_KEY="zp_home_hist_v1"/.test(monthly) &&
  /localStorage\.setItem\(HIST_CACHE_KEY/.test(monthly));
t("home-monthly.js：先 hydrate 快照再发请求（SWR 顺序）",
  monthly.indexOf("readHistCache()") < monthly.indexOf('zpFetch("/api/history?months=13"'));
t("home-monthly.js：数据到达移除 is-skel 骨架态",
  /classList\.remove\("is-skel"\)/.test(monthly));
t("home-monthly.js：无快照且请求失败回退 hidden（骨架卡不得永久停留）",
  /if\(!hydrated\)card\.hidden=true/.test(monthly));
t("home-monthly.js：初始化即写当前月份标签（HTML 静态文案会过期）",
  /monthEl\.textContent=label\(cnMonth\(\)\)/.test(monthly));

t("退出登录清除两份快照（防换账号串数据）",
  glue.includes('localStorage.removeItem("zp_home_today_v1")') &&
  glue.includes('localStorage.removeItem("zp_home_hist_v1")'));

t("js/home.bundle.js 已包含全部改动",
  jsBundle.includes("zp_home_today_v1") && jsBundle.includes("zp_home_hist_v1") &&
  jsBundle.includes("zpRenderTodayCard") && jsBundle.includes('classList.remove("is-skel")'));

/* ---------- 4. bundle 新鲜度（防改源不重建） ---------- */
execFileSync("node", [root + "scripts/build-home-bundle.mjs", "--check"], { stdio: "pipe" });
t("home.bundle.(js|css) 与源文件逐字节一致", true);

/* ---------- 5. home.html 的 ?v= 引用与 bundle 哈希一致 ---------- */
import { createHash } from "node:crypto";
const h8 = (s) => createHash("md5").update(s).digest("hex").slice(0, 8);
t("home.html 引用的 bundle 版本号最新",
  html.includes("/js/home.bundle.js?v=" + h8(jsBundle)) &&
  html.includes("/css/home.bundle.css?v=" + h8(cssBundle)));

console.log(`\n${pass} 通过, ${fail} 失败`);
if (fail) { console.error("失败项：\n - " + fails.join("\n - ")); process.exit(1); }
console.log("✅ 启动显示优化（骨架 + 快照）守卫全部通过");
