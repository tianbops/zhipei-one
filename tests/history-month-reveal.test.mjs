/**
 * 历史查询「展开月份从顶部开始显示」契约（node tests/history-month-reveal.test.mjs）
 * ------------------------------------------------------------------------------
 * 背景（2026-11-04 用户录屏）：
 *   手风琴一次只展开一个月。10 月展开 → 向下滚到 9 月 → 点开 9 月，10 月收起
 *   是对的，但 9 月却「从底部开始显示」：屏幕里是月末几行，9 月标题和月初
 *   日期都在视口上方。
 *
 * 根因不是 CSS 动画，而是滚动位置：10 月那二十几行 display:none 后文档高度骤减，
 *   浏览器把 .zp-scroll 的 scrollTop 裁到新的最大值（≈列表底部）。真浏览器实测：
 *   点击前 scrollTop=933 / 9 月标题 y=356；点击后 scrollTop=823=maxScroll / 标题 y=-749，
 *   可见行变成「10月7日 → 10月1日」。切换回任意月份同理（标题被顶到 y=-932）。
 *
 * 修复：applyFold() 切换完 class 后，按新布局把目标月份标题贴到 .zp-scroll 顶部。
 *   实测修复后 scrollTop=74 / 标题 y=0 / 首行 y=65 / 可见首行 =「10月20日」。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) 有 revealMonthTop，且只在「展开」时调用（收起不抢滚动位置）；
 *   2) 调用必须在 applyFold() **之后** —— 位置要按新布局算，早一步就是旧坐标；
 *   3) 只操作 .zp-scroll 的 scrollTop，不用 scrollIntoView（会连带滚动整页 / 被顶栏遮挡）；
 *   4) 目标值取 max(0, …)，负值会被浏览器夹到 0，先夹再赋值更可预测；
 *   5) 行为求值：标题在视口上方时 scrollTop 必须减小；收起时 scrollTop 不变；
 *      容器缺失时静默跳过（不能让整页点击报错）。
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

console.log("历史月份展开方向契约");
{
  t("存在 revealMonthTop（按新布局把标题贴到滚动区顶部）",
    /function\s+revealMonthTop\s*\(/.test(RENDER));
  t("滚动容器按类名取 .zp-scroll（与浮岛底栏同一容器）",
    /document\.querySelector\(\s*"\.zp-scroll"\s*\)/.test(RENDER));
  t("用 scrollTop 赋值，不用 scrollIntoView（后者会滚整页 / 被顶栏遮挡）",
    /sc\.scrollTop\s*=/.test(RENDER) && !/scrollIntoView/.test(RENDER));
  t("目标值先夹到 0，避免负 scrollTop 依赖浏览器兜底",
    /Math\.max\(\s*0\s*,/.test(RENDER));
  t("容器缺失时静默跳过（不抛错、不影响点击）",
    /if\s*\(\s*!sc\s*\|\|\s*!section\s*\)\s*return/.test(RENDER));

  const click = RENDER.slice(RENDER.indexOf("main.onclick="), RENDER.indexOf("main.onclick=") + 260);
  t("切换后统一 applyFold，再按展开态决定是否贴顶",
    /applyFold\s*\(\s*\)/.test(click), click.slice(0, 160));
  t("顺序：applyFold() 在 revealMonthTop() 之前（否则按旧布局算坐标）",
    click.indexOf("applyFold()") >= 0 && click.indexOf("revealMonthTop(") > click.indexOf("applyFold()"),
    click.slice(0, 200));
  t("只在展开时贴顶（if(expandedMonth)），收起不抢滚动位置",
    /if\s*\(\s*expandedMonth\s*\)\s*revealMonthTop\s*\(/.test(click), click.slice(0, 200));
  t("目标 section 由 render 闭包直接传入，不靠复杂选择器回查",
    /revealMonthTop\s*\(\s*section\s*\)/.test(RENDER));
}

/* ===== 行为求值：在 vm 里真跑 render() + 点击 =====
 * 用最小 DOM 桩模拟 .zp-scroll 的 scrollTop 与「切换后标题被顶到视口上方」，
 * 验证公式方向（top<0 → scrollTop 减小），而不是只验字符串。 */
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
      this._top = 0;
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
    getBoundingClientRect() { return { width: 300, height: 40, top: this._top || 0, left: 0 }; }
  }
  const byId = new Map();
  const scroller = {
    scrollTop: 823,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 390, height: 844 }),
  };
  const document = {
    getElementById(id) {
      if (!byId.has(id)) { const e = new El("div"); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    createElement: (tag) => new El(tag),
    querySelector: (sel) => (sel === ".zp-scroll" ? scroller : null),
    addEventListener() {},
    documentElement: new El("html"),
  };
  return { document, byId, scroller };
}

const { document, byId, scroller } = makeDom();
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

const nowYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const curMonth = nowYmd.slice(0, 7);
const back = (n) => {
  const [y, m] = curMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - n, 1)).toISOString().slice(0, 7);
};
const history = [
  { date: curMonth + "-03", count: 1, storeCount: 6, totalWeight: 150 },
  { date: curMonth + "-02", count: 1, storeCount: 5, totalWeight: 120 },
  { date: back(1) + "-15", count: 2, storeCount: 7, totalWeight: 210 },
  { date: back(2) + "-08", count: 1, storeCount: 3, totalWeight: 60 },
];
runInContext("model = " + JSON.stringify({ history, range: { start: back(2) + "-01", end: nowYmd } }), ctx);
runInContext("render()", ctx);

const sections = () => byId.get("historyList").children.filter((c) => (c.className || "").includes("history-month"));
const mainOf = (i) => sections()[i].querySelector(".history-month-main");

t("vm 前置：渲染出 3 个月份且全部收起", sections().length === 3 && sections().every((s) => !s.classList.contains("expanded")));

/* 展开第一个月：标题本来就在顶部（top=0），scrollTop 不该被改动。 */
scroller.scrollTop = 823;
mainOf(0).click();
t("展开首月：标题已在顶部时不额外滚动", scroller.scrollTop === 823, "scrollTop=" + scroller.scrollTop);

/* 核心：模拟「切到第二个月时，上方月份收起把标题顶到 y=-749」，
   期望 scrollTop 从 823 减到 74（= 823 + (-749)），把标题拉回可视区顶部。 */
sections()[1]._top = -749;
scroller.scrollTop = 823;
mainOf(1).click();
t("切到下方月份：标题被顶出视口时 scrollTop 减小到 74（贴顶）",
  scroller.scrollTop === 74, "scrollTop=" + scroller.scrollTop);
t("切到下方月份：第二个月展开、首月自动收起（手风琴未被破坏）",
  sections()[1].classList.contains("expanded") && !sections()[0].classList.contains("expanded"));

/* 收起：不抢滚动位置。 */
scroller.scrollTop = 400;
mainOf(1).click();
t("再点一次收起：不改动 scrollTop", scroller.scrollTop === 400, "scrollTop=" + scroller.scrollTop);
t("收起后无月份展开", sections().every((s) => !s.classList.contains("expanded")));

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
