/**
 * 历史运单页月份分组折叠（tests/history-month-fold.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-10-30）：历史页按月份分组，原来「当月」默认展开、其余收起。
 * 当月往往有 20+ 天，展开后要滚很久才看到更早的月份，翻旧单只能一天天翻。
 * 改为**默认全部收起**：一屏能看到一整年的月份条，直接定位到目标月份。
 *
 * 这条改动有三个容易踩的坑，全部钉在这里：
 *   1. 默认展开是硬编码在 render 里的 `month===currentMonth`——只删这句还不够，
 *      必须确认没有任何一条路径会把某个月重新默认展开；
 *   2. render() 会因删除/回收站恢复而整体重绘（data.js load → render），
 *      展开状态若只挂在 DOM 的 class 上会丢——用户删一条记录，列表整个塌下去；
 *   3. 收起态靠 CSS `.history-month.expanded` 控制 display，JS 与 CSS 必须对得上，
 *      否则「收起」只是 class 没了、内容还在，或者反过来永远展开。
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
t("展开判定来自 expandedMonths（跨重绘的状态）",
  /expandedMonths\.has\(\s*month\s*\)/.test(RENDER));
t("expandedMonths 是 core.js 的状态，不是 render 局部变量",
  /const\s+expandedMonths\s*=\s*new\s+Set\(\)/.test(CORE) && !/const\s+expandedMonths/.test(RENDER));
t("点击月份条时同步 add/delete",
  /expandedMonths\.add\(\s*month\s*\)/.test(RENDER) && /expandedMonths\.delete\(\s*month\s*\)/.test(RENDER));
t("展开状态同步到 aria-expanded（屏幕阅读器要知道折叠了）",
  /setAttribute\(\s*"aria-expanded"/.test(RENDER) && /"aria-controls"/.test(RENDER));
t("月份条仍是 <button>，不是 div（否则点不开）",
  /document\.createElement\(\s*"button"\s*\)[\s\S]{0,80}history-month-main/.test(RENDER));

/* CSS：收起必须有真正的隐藏规则，且只由 .expanded 打开。 */
t("CSS 收起态隐藏月份内容",
  /\.history-month-body\{[^}]*display\s*:\s*none/.test(CSS.replace(/\s*\n\s*/g, "")));
t("CSS 仅 .expanded 时显示月份内容",
  /\.history-month\.expanded\s+\.history-month-body\{[^}]*display\s*:\s*block/.test(CSS.replace(/\s*\n\s*/g, "")));

/* 页面脚本顺序：core.js 先于 render.js（expandedMonths 由 core 定义）。 */
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
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      const walk = (n) => {
        for (const c of n.children) {
          if (c._cls && c._cls.has(cls)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
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
  return { document, El, byId };
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
const prevMonth = (() => {
  const [y, m] = curMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
})();
const prev2Month = (() => {
  const [y, m] = curMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 7);
})();
const history = [
  { date: curMonth + "-02", count: 1, storeCount: 5, totalWeight: 120 },
  { date: curMonth + "-01", count: 1, storeCount: 4, totalWeight: 90 },
  { date: prevMonth + "-15", count: 2, storeCount: 7, totalWeight: 210 },
  { date: prev2Month + "-08", count: 1, storeCount: 3, totalWeight: 60 },
];
/* model 是 core.js 顶层的 let 绑定，只能从 vm 内部赋值（挂 ctx 属性覆盖不了词法绑定）。 */
runInContext("model = " + JSON.stringify({ history, range: { start: prev2Month + "-01", end: nowYmd } }), ctx);

runInContext("render()", ctx);

const listEl = byId.get("historyList");
const sections = listEl.children.filter((c) => (c.className || "").includes("history-month"));
t("渲染出 3 个月份分组", sections.length === 3, String(sections.length));
t("首屏所有月份都是收起态（含当月）",
  sections.every((s) => !s.classList.contains("expanded")),
  sections.map((s) => s.dataset.month + ":" + s.classList.contains("expanded")).join(","));
t("当月分组确实在列表里（不是没渲染才「收起」）",
  sections.some((s) => s.dataset.month === curMonth));

const curSection = sections.find((s) => s.dataset.month === curMonth);
const curMain = curSection.querySelector(".history-month-main");
t("收起态 aria-expanded=false", curMain.getAttribute("aria-expanded") === "false", curMain.getAttribute("aria-expanded"));
t("aria-controls 指向月份内容容器",
  curMain.getAttribute("aria-controls") === curSection.querySelector(".history-month-body").id &&
  String(curMain.getAttribute("aria-controls")).startsWith("history-month-body-"));

/* 点开当月 */
curMain.click();
t("点月份条 → 展开", curSection.classList.contains("expanded"));
t("展开后 aria-expanded=true", curMain.getAttribute("aria-expanded") === "true");
t("展开后落在 expandedMonths 里", runInContext(`expandedMonths.has(${JSON.stringify(curMonth)})`, ctx) === true);

/* 删除/恢复触发的整体重绘：状态要活下来 */
runInContext("render()", ctx);
const sections2 = byId.get("historyList").children.filter((c) => (c.className || "").includes("history-month"));
const cur2 = sections2.find((s) => s.dataset.month === curMonth);
t("重绘后已展开的月份保持展开", cur2.classList.contains("expanded"));
t("重绘后其他月份仍是收起",
  sections2.filter((s) => s !== cur2).every((s) => !s.classList.contains("expanded")));

/* 再点一次收起 */
cur2.querySelector(".history-month-main").click();
t("再点一次 → 收起", !cur2.classList.contains("expanded"));
t("收起后从 expandedMonths 移除", runInContext(`expandedMonths.has(${JSON.stringify(curMonth)})`, ctx) === false);

/* 冷启动（新会话、Set 为空）永远全收起——不能有月份「自己弹开」 */
runInContext("expandedMonths.clear()", ctx);
runInContext("render()", ctx);
const sections3 = byId.get("historyList").children.filter((c) => (c.className || "").includes("history-month"));
t("Set 清空后重绘：全部收起，无自弹开",
  sections3.every((s) => !s.classList.contains("expanded")));

console.log(`\n历史月份折叠：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
