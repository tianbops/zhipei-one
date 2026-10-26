/**
 * 模态焦点管理单元测试（ui-modal-focus）
 * ============================================================================
 * 覆盖对象：js/ui/core.js 中的模态焦点管理纯函数核心
 *   - UI.focusables：收集容器内可聚焦元素（过滤 disabled / tabindex=-1 /
 *     隐藏祖先 / aria-hidden / 不可见项）
 *   - UI.trapFocusTarget：焦点陷阱的纯决策（首尾循环）
 *   - UI.trapTab：把焦点锁在容器内；焦点逸出层外时拉回层内
 *
 * 背景：对话框（aria-modal）打开后，Tab/Shift+Tab 会在文档里乱走，键盘焦点
 * 逃出遮罩——这是 P3「对话框焦点陷阱」的落点。决策拆成纯函数放进无副作用的
 * UI 内核（js/ui/core.js），便于在此单测；DOM 装配与 ESC/Tab 分发器在
 * js/ui/back.js，由 Playwright 集成验证覆盖。
 *
 * 同时固化内核契约：core.js 不得有副作用（不注册监听、不改 DOM），
 * 因此在「无 document」环境下也必须能加载。
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();

/** 构造一个最小可用的假元素，够 core.js 的可聚焦判定使用 */
function fakeEl(opts = {}) {
  const attrs = opts.attrs || {};
  const rectCount = opts.rects === undefined ? 1 : opts.rects;
  const el = {
    disabled: !!opts.disabled,
    focused: false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: (sel) => (sel === "[hidden]" && opts.hiddenAncestor ? { hidden: true } : null),
    offsetParent:
      opts.offsetParent !== undefined ? opts.offsetParent : opts.visible === false ? null : {},
    getClientRects: () => new Array(rectCount).fill(0),
    focus() {
      el.focused = true;
    },
  };
  return el;
}

/** 假容器：querySelectorAll 返回给定元素列表 */
function fakeRoot(children) {
  return {
    querySelectorAll: () => children,
    contains: (n) => children.includes(n),
  };
}

/** 在 vm 沙箱中加载 core.js，返回 UI 与沙箱内的 document 桩 */
function loadUI() {
  const src = fs.readFileSync(path.join(root, "js/ui/core.js"), "utf8");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { UI: sandbox.window.__zpUi, sandbox };
}

test("core.js：无 document 环境下可加载（内核保持无副作用）", () => {
  const { UI } = loadUI();
  assert.ok(UI, "__zpUi 必须暴露");
  assert.equal(typeof UI.focusables, "function");
  assert.equal(typeof UI.trapFocusTarget, "function");
  assert.equal(typeof UI.trapTab, "function");
});

test("focusables：保留正常可见项，过滤 disabled / tabindex=-1 / 隐藏祖先 / aria-hidden / 不可见", () => {
  const { UI } = loadUI();
  const ok = fakeEl();
  const disabled = fakeEl({ disabled: true });
  const noTab = fakeEl({ attrs: { tabindex: "-1" } });
  const hidden = fakeEl({ hiddenAncestor: true });
  const ariaHidden = fakeEl({ attrs: { "aria-hidden": "true" } });
  const invisible = fakeEl({ visible: false, rects: 0 });
  const list = UI.focusables(fakeRoot([ok, disabled, noTab, hidden, ariaHidden, invisible]));
  assert.equal(list.length, 1, "只有正常可见项入选");
  assert.equal(list[0], ok, "入选的就是那个正常可见项");
});

test("focusables：position:fixed 元素（offsetParent 为 null）仍算可见", () => {
  const { UI } = loadUI();
  const fixed = fakeEl({ offsetParent: null }); // getClientRects 仍有 1 项
  const list = UI.focusables(fakeRoot([fixed]));
  assert.equal(list.length, 1, "fixed 定位不应被误判为隐藏");
  assert.equal(list[0], fixed);
});

test("trapFocusTarget：焦点在末项→回首项；焦点在首项+Shift→跳末项；焦点在中间→不干预", () => {
  const { UI } = loadUI();
  const a = fakeEl(), b = fakeEl(), c = fakeEl();
  const list = [a, b, c];
  assert.equal(UI.trapFocusTarget(list, c, false), a, "末项按 Tab 回到首项");
  assert.equal(UI.trapFocusTarget(list, a, true), c, "首项按 Shift+Tab 跳到末项");
  assert.equal(UI.trapFocusTarget(list, b, false), null, "中间项不干预");
  assert.equal(UI.trapFocusTarget(list, b, true), null, "中间项不干预");
  assert.equal(UI.trapFocusTarget([], a, false), null, "空列表不干预");
  assert.equal(UI.trapFocusTarget(null, a, false), null, "空输入不干预");
});

test("trapTab：焦点在末项时搬运到首项并阻止默认行为", () => {
  const { UI, sandbox } = loadUI();
  const a = fakeEl(), b = fakeEl();
  const r = fakeRoot([a, b]);
  sandbox.document = { activeElement: b };
  let prevented = false;
  const moved = UI.trapTab(r, { shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(moved, true);
  assert.equal(a.focused, true, "焦点应搬到首项");
  assert.equal(b.focused, false);
  assert.equal(prevented, true, "必须阻止默认行为，否则焦点会跑出弹层");
});

test("trapTab：焦点已逸出层外（切到隐藏面板后落在 body）时，Tab 把它拉回层内", () => {
  const { UI, sandbox } = loadUI();
  const a = fakeEl(), b = fakeEl();
  const r = fakeRoot([a, b]);
  sandbox.document = { activeElement: null }; // 焦点不在层内
  let prevented = false;
  const moved = UI.trapTab(r, { shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(moved, true);
  assert.equal(a.focused, true, "应把焦点拉回首项");
  assert.equal(prevented, true);
});

test("trapTab：层内无可聚焦元素时不干预（不吞掉 Tab）", () => {
  const { UI, sandbox } = loadUI();
  sandbox.document = { activeElement: null };
  let prevented = false;
  const moved = UI.trapTab(fakeRoot([]), { shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(moved, false);
  assert.equal(prevented, false, "空层不应吞掉 Tab");
});
