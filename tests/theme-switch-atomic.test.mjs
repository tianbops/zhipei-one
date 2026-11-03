/**
 * 外观切换原子性与壳侧提前量（theme-switch-atomic）
 * ============================================================================
 * 针对的线上缺陷：安卓壳内深浅外观切换时，顶部状态栏位置闪一下**纯黑/纯白**。
 *
 * 根因（两条叠加，都在 Web 侧）：
 *   1) color-scheme 不是可过渡属性，data-zp-theme 一改瞬时生效，把 UA 基层
 *      （canvas / 滚动条 / 表单控件 / WebView 合成层底色）立刻翻成该配方的默认
 *      极端色（深=纯黑、浅=纯白）；而 .zp-ui-ready 给全站（含 html/body）挂了
 *      background-color .22s 渐变，主题色要 220ms 才到位。两者时间常数不一致，
 *      中间露出的既非 #121826 也非 #F6F7F9，正是用户看到的黑白闪。
 *   2) 壳侧换色要经 JavaBridge → runOnUiThread → 下一帧，比网页慢 1~3 帧，
 *      错配带被进一步拉长。
 *
 * 因此本测试钉四条不变量（任何一条被改回去，黑白闪都会复发）：
 *   A. 切换期间摘掉过渡宿主 zp-ui-ready，换完再挂回 —— 保证同帧原子换色；
 *   B. 桥调用必须**先于** data-zp-theme 写入 —— 保证原生尽早起跑；
 *   C. 全站颜色过渡确实以 .zp-ui-ready 为唯一宿主 —— 否则 A 是空操作；
 *   D. 提前入口只接受已解析主题与在册色值 —— 不把未知色送进原生染色通道。
 * ============================================================================
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const appearance = read("js/ui/appearance.js");
const themeSync = read("js/theme-sync.js");
const base = read("css/ui-base.css");

// 只取 applyTheme 函数体，避免断言漂到别处的同名标识符上。
const start = appearance.indexOf("const applyTheme=theme=>{");
const end = appearance.indexOf("\n    };", start);
assert.ok(start >= 0 && end > start, "appearance.js 必须保留 applyTheme 结构（否则本测试锚点失效）");
const body = appearance.slice(start, end);

test("A. 切换期间关闭过渡宿主，换色完成后挂回", () => {
  const gate = body.indexOf('root.classList.contains("zp-ui-ready")');
  const remove = body.indexOf('root.classList.remove("zp-ui-ready")');
  const write = body.indexOf("root.dataset.zpTheme=resolved");
  const reAdd = body.indexOf('root.classList.add("zp-ui-ready")');

  assert.ok(gate >= 0 && remove > gate, "必须先看 zp-ui-ready 是否已挂（首帧前本就没有，不该无谓挂回）");
  assert.ok(remove >= 0 && remove < write, "必须在改写 data-zp-theme 之前摘掉过渡宿主");
  assert.ok(reAdd > write, "必须在换色之后才把过渡宿主挂回");
});

test("B. 壳侧同步先于 DOM 主题属性写入", () => {
  const bridge = body.indexOf("window.zpShellThemeSync(resolved,bg)");
  const write = body.indexOf("root.dataset.zpTheme=resolved");
  assert.ok(bridge >= 0, "applyTheme 必须调用壳侧提前入口");
  assert.ok(bridge < write, "原生要多跳两趟线程，必须在改 DOM 前下发，否则系统栏落后网页");
});

test("C. 全站颜色过渡确实以 .zp-ui-ready 为宿主（B/A 的前提）", () => {
  const decls = base.split("\n").filter(l => /^\s*transition\s*:\s*background-color/.test(l));
  assert.ok(decls.length >= 1, "ui-base 必须仍有背景色过渡规则");
  // 每条 background-color 过渡都必须落在 .zp-ui-ready 规则块内；
  // 若哪天有人把过渡改成无宿主（如裸 *{transition:...}），摘 zp-ui-ready 就关不住它。
  const scoped = /\.zp-ui-ready\s+:where\(\*\)/.test(base);
  assert.ok(scoped, "背景色过渡必须由 .zp-ui-ready :where(*) 承载，切换期摘掉宿主才有效");
});

test("D. 提前入口校验主题与色值", () => {
  const hook = themeSync.indexOf("window.zpShellThemeSync");
  assert.ok(hook >= 0, "theme-sync.js 必须导出 zpShellThemeSync 供 appearance.js 提前调用");
  const hookBody = themeSync.slice(hook, themeSync.indexOf("\n  };", hook));
  assert.match(hookBody, /theme\s*!==?\s*"dark"[\s\S]*"light"/, "只接受已解析的 dark/light，拒绝 system 这类未解析值");
  assert.match(hookBody, /COLORS\.dark\s*\|\|\s*color\s*===\s*COLORS\.light|color\s*===\s*COLORS\.dark/, "色值必须在册，非法值回落主题默认");
  assert.match(hookBody, /push\(/, "提前入口与观察器共用同一去重通道，避免重复跨桥");
});

test("E. 去重仍由单一 lastKey 承担（提前入口不得另起一套缓存）", () => {
  const keys = themeSync.match(/lastKey/g) || [];
  assert.ok(keys.length >= 3, "lastKey 应同时出现在声明、比对与写入处");
  assert.doesNotMatch(themeSync, /var\s+(lastShellKey|shellCache)/, "不允许出现第二份去重状态（两份缓存必然对不齐）");
});

test("F. home bundle 已含同一段原子切换逻辑（打包产物不能落后于源）", () => {
  const bundle = read("js/home.bundle.js");
  assert.match(bundle, /window\.zpShellThemeSync\(resolved,bg\)/, "home.bundle.js 缺提前下发，home 页仍会闪");
  assert.match(bundle, /root\.classList\.remove\("zp-ui-ready"\)/, "home.bundle.js 缺过渡闸门");
});

console.log("✓ 外观切换原子换色与壳侧提前量契约完整");
