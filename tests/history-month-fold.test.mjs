/**
 * 历史运单页月份分组折叠（tests/history-month-fold.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30）：
 *   一、历史页按月份分组，原来「当月」默认展开、其余收起。当月往往有 20+ 天，
 *      展开后要滚很久才看到更早的月份。改为**默认全部收起**：一屏能看到一整年的月份条。
 *   二、收起之后又发现同时开多个月没意义——在长列表里翻月份时，上下两个月份都展开，
 *      等于把「一屏看完」的收益还回去。改为**手风琴：同时只展开一个月**，
 *      点 10 月展开 → 点 9 月自动收起 10 月、展开 9 月。
 *
 * 这条逻辑有三处容易踩空，全部钉在这里：
 *   1. 默认展开曾硬编码为 `month===currentMonth`——只删这句不够，必须确认没有任何
 *      路径会把某个月重新默认展开；
 *   2. render() 会因删除/回收站恢复整体重绘（data.js load → render），
 *      展开状态挂在 DOM 的 class 上会丢——用户删一条记录，列表整个塌下去；
 *   3. 「只展开一个」不能靠各月独立 toggle 碰巧成立：独立 toggle 下点第二个会变成
 *      两个展开。断言必须覆盖「点新月份时旧月份被收起」，而不只是「数量等于 1」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const CORE = read("js/history/core.js");
const RENDER = read("js/history/render.js");
const CSS = read("css/history-list.css") + read("css/history-shell.css");
const PAGE = read("pages/history.html");

/* ===== 一、源码红线 ===== */
t("当月默认展开的硬编码已移除", !/month\s*===\s*currentMonth/.test(RENDER));
t("render 不再为默认展开计算当月",
  !/currentMonth\s*=\s*monthKey\s*\(\s*now\s*\)/.test(RENDER), "render 里还有 currentMonth");
t("展开判定来自 expandedMonth（跨重绘的单一状态）",
  /expandedMonth\s*===\s*month/.test(RENDER));
t("expandedMonth 是 core.js 的状态，不是 render 局部变量",
  /let\s+expandedMonth\s*=\s*""/.test(CORE) && !/let\s+expandedMonth/.test(RENDER));
t("多选语义的 Set 已彻底退场（否则两套真相并存）",
  !/expandedMonths/.test(RENDER) && !/expandedMonths/.test(CORE));
t("点已展开的月 = 收起，点别的月 = 换展开",
  /expandedMonth\s*=\s*expandedMonth\s*===\s*month\s*\?\s*""\s*:\s*month/.test(RENDER));
t("切换后统一对齐 DOM（applyFold），而不是只 toggle 被点的那个",
  /function\s+applyFold\s*\(/.test(RENDER) &&
  /main\.onclick[\s\S]{0,220}?applyFold\s*\(\s*\)/.test(RENDER));
t("applyFold 遍历全部分组重设 class 与 aria",
  /querySelectorAll\(\s*"\.history-month"\s*\)/.test(RENDER));
t("展开状态同步到 aria-expanded / aria-controls",
  /setAttribute\(\s*"aria-expanded"/.test(RENDER) && /"aria-controls"/.test(RENDER));
t("月份条仍是 <button>，不是 div（否则点不开）",
  /document\.createElement\(\s*"button"\s*\)[\s\S]{0,80}history-month-main/.test(RENDER));

/* CSS：收起必须有真正的隐藏规则，且只由 .expanded 打开。 */
t("CSS 收起态隐藏月份内容",
  /\.history-month-body\{[^}]*display\s*:\s*none/.test(CSS.replace(/\s*\n\s*/g, "")));
t("CSS 仅 .expanded 时显示月份内容",
  /\.history-month\.expanded\s+\.history-month-body\{[^}]*display\s*:\s*block/.test(CSS.replace(/\s*\n\s*/g, "")));

/* 页面脚本顺序：core.js 先于 render.js（expandedMonth 由 core 定义）。 */
const iCore = PAGE.indexOf("/js/history/core.js");
const iRender = PAGE.indexOf("/js/history/render.js");
t("history.html 先引 core.js 再引 render.js", iCore > 0 && iRender > iCore, `${iCore} / ${iRender}`);

/* ===== 二、行为求值：真跑 render()，看 DOM 结果 =====
 * 不引 jsdom：只用到 element 的几个方法，手写最小桩更直观，
 * 也避免「测试依赖比被测代码还重」。 */
function makeDom() {
  let seq = 0;
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.id = "";
      this.dataset = {};
      this.style = {};
      this.attrs = {};
      this.children = [];
      this.handlers = {};
      this.textContent = "";
      this._cls = new Set();
      this._uid = ++seq;
    }
    get className() { return [...this._cls].join(" "); }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() {
      const s = this._cls;
      return {
        add: (...n) => n.forEach((x) => s.add(x)),
        remove: (...n) => n.forEach((x) => s.delete(x)),
        contains: (n) => s.has(n),
        toggle: (n, force) => {
          const on = force === undefined ? !s.has(n) : !!force;
          if (on) s.add(n); else s.delete(n);
          return on;
        },
      };
    }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    get innerHTML() { return this._html || ""; }
    append(...kids) { for (const k of kids) this.children.push(k); }
    appendChild(k) { this.children.push(k); return k; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    /* 页面用 el.onclick = fn 赋值（不走 addEventListener），click() 两种都要认。 */
    click() {
      const ev = { target: this, preventDefault() {}, stopPropagation() {} };
      if (typeof this.onclick === "function") this.onclick(ev);
      for (const fn of this.handlers.click || []) fn(ev);
    }
    _descendants(pred, out = []) {
      for (const c of this.children) { if (pred(c)) out.push(c); c._descendants(pred, out); }
      return out;
    }
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      return this._descendants((c) => c._cls && c._cls.has(cls))[0] || null;
    }
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, "");
      return this._descendants((c) => c._cls && c._cls.has(cls));
    }
    getBoundingClientRect() { return { width: 300, height: 40, top: 0, left: 0 }; }
  }
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) { const e = new El("div"); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    createElement: (tag) => new El(tag),
    querySelector: () => null,
    addEventListener() {},
    documentElement: new El("html"),
  };
  return { document, byId };
}

const { document, byId } = makeDom();
const ctx = createContext({
  document,
  window: {},
  location: { search: "", pathname: "/pages/history", replace() {} },
  sessionStorage: { getItem: () => null, setItem() {}, clear() {} },
  console,
  Intl, Date, Math, Number, String, Object, Array, Map, Set, Promise, JSON, URLSearchParams,
  setTimeout, clearTimeout,
});
runInContext(CORE, ctx, { filename: "core.js" });
runInContext(RENDER, ctx, { filename: "render.js" });

/* 造数据：跨 3 个月，其中含当月。 */
const nowYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date());
const curMonth = nowYmd.slice(0, 7);
const back = (n) => {
  const [y, m] = curMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
};
const prevMonth = back(1), prev2Month = back(2);
const history = [
  { date: curMonth + "-03", count: 1, storeCount: 6, totalWeight: 150 },
  { date: curMonth + "-02", count: 1, storeCount: 5, totalWeight: 120 },
  { date: curMonth + "-01", count: 1, storeCount: 4, totalWeight: 90 },
  { date: prevMonth + "-15", count: 2, storeCount: 7, totalWeight: 210 },
  { date: prev2Month + "-08", count: 1, storeCount: 3, totalWeight: 60 },
];
/* model 是 core.js 顶层的 let 绑定，只能从 vm 内部赋值（挂 ctx 属性覆盖不了词法绑定）。 */
runInContext("model = " + JSON.stringify({ history, range: { start: prev2Month + "-01", end: nowYmd } }), ctx);

const sectionsOf = () => byId.get("historyList").children.filter((c) => (c.className || "").includes("history-month"));
const expandedOf = () => sectionsOf().filter((s) => s.classList.contains("expanded")).map((s) => s.dataset.month);
const mainOf = (ym) => sectionsOf().find((s) => s.dataset.month === ym).querySelector(".history-month-main");

runInContext("render()", ctx);

let secs = sectionsOf();
t("渲染出 3 个月份分组", secs.length === 3, String(secs.length));
t("首屏所有月份都是收起态（含当月）", expandedOf().length === 0, expandedOf().join(","));
t("当月分组确实在列表里（不是没渲染才「收起」）", secs.some((s) => s.dataset.month === curMonth));

/* 月份条文案：「X单 · X家 · Xt」三项，且重量 3 位小数（与首页统计同一口径）。
 * 造的数据：当月 3 天、每天 1 单、门店 6+5+4=15 家、重量 150+120+90=360。 */
const monthText = sectionsOf().find((s) => s.dataset.month === curMonth).querySelector(".history-month-main").innerHTML;
t("月份条是「3单 · 15家 · 360.000t」", monthText.includes("3单 · 15家 · 360.000t"), monthText);
t("月份条不再出现「N天」口径", !/\d+天/.test(monthText), monthText);

t("收起态 aria-expanded=false", mainOf(curMonth).getAttribute("aria-expanded") === "false");
const curBody = sectionsOf().find((s) => s.dataset.month === curMonth).querySelector(".history-month-body");
t("aria-controls 指向本月内容容器",
  mainOf(curMonth).getAttribute("aria-controls") === "history-month-body-" + curMonth &&
  curBody.id === "history-month-body-" + curMonth);

/* ---- 手风琴核心：展开 A ---- */
mainOf(curMonth).click();
t("点当月 → 展开", expandedOf().join() === curMonth, expandedOf().join());
t("展开后 aria-expanded=true", mainOf(curMonth).getAttribute("aria-expanded") === "true");

/* ---- 展开 B：A 必须自动收起 ---- */
mainOf(prevMonth).click();
t("点 9 月 → 9 月展开", expandedOf().join() === prevMonth, expandedOf().join());
t("点 9 月 → 10 月被自动收起", !expandedOf().includes(curMonth), expandedOf().join());
t("点 9 月 → 10 月的 aria-expanded 回到 false", mainOf(curMonth).getAttribute("aria-expanded") === "false");
t("任意时刻最多一个月份展开", expandedOf().length <= 1, expandedOf().join());

/* ---- 点已展开的那个 = 收起，且不会误开别的 ---- */
mainOf(prevMonth).click();
t("再点 9 月 → 全部收起", expandedOf().length === 0, expandedOf().join());
t("全部收起后所有 aria-expanded 都是 false",
  sectionsOf().every((s) => s.querySelector(".history-month-main").getAttribute("aria-expanded") === "false"));

/* ---- 重绘（删记录 / 回收站恢复）后保持「哪一个月展开」 ---- */
mainOf(prev2Month).click();
t("前置：8 月已展开", expandedOf().join() === prev2Month, expandedOf().join());
runInContext("render()", ctx);
t("重绘后仍展开 8 月", expandedOf().join() === prev2Month, expandedOf().join());
t("重绘后没有多开别的月份", expandedOf().length === 1, expandedOf().join());

/* ---- 遍历点击，任意顺序都不允许出现两个展开 ---- */
const months = [curMonth, prevMonth, prev2Month];
let maxExpanded = 0, badStep = "";
for (const ym of [...months, months[0], months[2], months[1]]) {
  mainOf(ym).click();
  const n = expandedOf().length;
  if (n > maxExpanded) maxExpanded = n;
  if (n > 1) badStep = ym + " → " + expandedOf().join(",");
}
t("随机顺序连点：从未出现两个同时展开", maxExpanded <= 1, badStep);

/* ---- 冷启动（新会话、expandedMonth 为空）永远全收起 ---- */
runInContext('expandedMonth = ""', ctx);
runInContext("render()", ctx);
t("expandedMonth 清空后重绘：全部收起，无自弹开", expandedOf().length === 0, expandedOf().join());

console.log(`\n历史月份折叠：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
