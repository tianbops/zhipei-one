/**
 * zp-picker 单元测试（unit-zp-picker）
 * ============================================================================
 * 覆盖对象：js/ui/zp-picker.js 的纯函数核心 zpPickerCore。
 *
 * 背景：App 内「全局文字大小」滑杆只能缩放网页 DOM，Android WebView 的原生
 * <select> 下拉与日期对话框是系统弹层，不认网页字号/主题（深色模式下白底
 * 弹层、滑杆调大字后弹层还是小字，均为线上实测问题）。
 * zp-picker 把原生控件升级为页内底部弹层，弹层即普通 HTML，自动继承主题
 * 令牌与字号缩放；原生控件保留作数据源，业务 JS 零改动。
 *
 * 本测试在无 DOM 环境（vm 沙箱）加载脚本，验证核心纯函数：
 *   - clampScale：滑杆值域钳制（0.85–1.3，非法值回落 1）
 *   - toISO/parseISO：日期序列化/反序列化（含闰年 2/29、月末、非法输入）
 *   - monthMatrix：6×7 月矩阵（月初补位、跨月填充、天数正确性）
 *   - fmtCN/dateLabel：中文日期展示（含空值回落）
 *   - selectLabel：select 当前展示文本（选中项优先、首项回落、空选项）
 * DOM 装配部分由 e2e/集成场景覆盖，不进本单测。
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();

/** 无 DOM 环境加载 zp-picker.js，返回 zpPickerCore 与「是否装配了 DOM」标记 */
function loadCore() {
  const src = fs.readFileSync(path.join(root, "js/ui/zp-picker.js"), "utf8");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    core: sandbox.zpPickerCore,
    hasDomWiring: typeof sandbox.zpPicker === "object",
  };
}

const { core, hasDomWiring } = loadCore();

test("zp-picker：无 DOM 环境下只暴露纯函数核心，不装配 DOM", () => {
  assert.ok(core, "zpPickerCore 必须暴露");
  assert.equal(hasDomWiring, false, "无 document 时不得装配 DOM（Node 可加载）");
});

test("clampScale：滑杆值域钳制在 0.85–1.3，非法值回落 1", () => {
  assert.equal(core.clampScale(1), 1);
  assert.equal(core.clampScale(0.85), 0.85);
  assert.equal(core.clampScale(1.3), 1.3);
  assert.equal(core.clampScale(0.1), 0.85, "低于下限钳到 0.85");
  assert.equal(core.clampScale(2), 1.3, "高于上限钳到 1.3");
  assert.equal(core.clampScale(NaN), 1, "NaN 回落 1");
  assert.equal(core.clampScale("1.15"), 1.15, "数字字符串可解析");
  assert.equal(core.clampScale("abc"), 1, "非数字字符串回落 1");
  assert.equal(core.clampScale(undefined), 1, "undefined 回落 1");
});

test("toISO/parseISO：本地时区序列化往返一致", () => {
  const d = new Date(2026, 9, 25); // 2026-10-25 本地时间
  assert.equal(core.toISO(d), "2026-10-25");
  const back = core.parseISO("2026-10-25");
  // 注意：parseISO 跑在 vm 沙箱里，其 Date 与测试域不同构，不能 instanceof，
  // 用 toISO 往返 + 内部方法探测验证「确为可用日期」。
  assert.equal(Object.prototype.toString.call(back), "[object Date]");
  assert.equal(back.getFullYear(), 2026);
  assert.equal(back.getMonth(), 9);
  assert.equal(back.getDate(), 25);
  assert.equal(core.toISO(back), "2026-10-25", "往返一致");
});

test("parseISO：闰日与月末边界", () => {
  const leap = core.parseISO("2024-02-29"); // 2024 是闰年
  assert.ok(leap, "闰年 2/29 必须可解析");
  assert.equal(core.toISO(leap), "2024-02-29");
  assert.equal(core.toISO(core.parseISO("2026-12-31")), "2026-12-31", "年末边界");
  assert.equal(core.toISO(core.parseISO("2026-01-01")), "2026-01-01", "年初边界");
});

test("parseISO：非法输入返回 null（不抛异常）", () => {
  assert.equal(core.parseISO(""), null);
  assert.equal(core.parseISO("   "), null);
  assert.equal(core.parseISO("not-a-date"), null);
  assert.equal(core.parseISO("2026-13-01"), null, "月份 13 非法");
  assert.equal(core.parseISO("2026-00-10"), null, "月份 0 非法");
  assert.equal(core.parseISO("2026-02-30"), null, "2/30 溢出非法");
  assert.equal(core.parseISO("26-10-25"), null, "两位数年份非法");
  assert.equal(core.parseISO(null), null, "null 安全");
  assert.equal(core.parseISO(undefined), null, "undefined 安全");
});

test("parseISO：容忍首尾空白", () => {
  assert.equal(core.toISO(core.parseISO("  2026-10-25  ")), "2026-10-25");
});

test("monthMatrix：6×7 结构，天数与补位正确", () => {
  const rows = core.monthMatrix(2026, 9); // 2026 年 10 月
  assert.equal(rows.length, 6, "固定 6 行");
  rows.forEach(r => assert.equal(r.length, 7, "每行 7 列"));
  // 2026-10-01 是周四 → 首行前 4 格补位
  assert.equal(rows[0].filter(x => x === null).length, 4);
  const days = rows.flat().filter(Boolean);
  assert.equal(days.length, 31 + 7, "10 月 31 天 + 跨月补齐 7 天（11/1–11/7）");
  assert.equal(core.toISO(days[0]), "2026-10-01", "首个有效格是 10/1");
  assert.equal(core.toISO(days[30]), "2026-10-31", "第 31 个有效格是 10/31");
  assert.equal(core.toISO(days[31]), "2026-11-01", "跨月填充从 11/1 开始");
});

test("monthMatrix：2 月（平年 28 天）", () => {
  // 2026-02-01 是周日（无补位）→ 42 格全有效：28 天 + 跨月补齐 14 天
  const days = core.monthMatrix(2026, 1).flat().filter(Boolean); // 2026 平年 2 月
  assert.equal(days.length, 28 + 14);
  assert.equal(core.toISO(days[0]), "2026-02-01");
  assert.equal(core.toISO(days[27]), "2026-02-28");
  assert.equal(core.toISO(days[28]), "2026-03-01");
});

test("monthMatrix：闰年 2 月 29 天", () => {
  // 2024-02-01 是周四（补位 4）→ 38 格有效：29 天 + 跨月补齐 9 天
  const days = core.monthMatrix(2024, 1).flat().filter(Boolean); // 2024 闰年
  assert.equal(days.length, 29 + 9);
  assert.equal(core.toISO(days[28]), "2024-02-29");
  assert.equal(core.toISO(days[29]), "2024-03-01");
});

test("monthMatrix：月初是周日时无补位", () => {
  // 2026-11-01 是周日
  const rows = core.monthMatrix(2026, 10);
  assert.equal(rows[0].filter(x => x === null).length, 0);
  assert.equal(core.toISO(rows[0][0]), "2026-11-01");
});

test("fmtCN/dateLabel：中文日期展示与空值回落", () => {
  assert.equal(core.fmtCN(new Date(2026, 9, 25)), "2026年10月25日");
  assert.equal(core.fmtCN(new Date(2026, 0, 1)), "2026年1月1日");
  assert.equal(core.dateLabel("2026-10-25"), "2026年10月25日");
  assert.equal(core.dateLabel(""), "", "空值返回空串（触发器据此显示占位文案）");
  assert.equal(core.dateLabel(null), "");
  assert.equal(core.dateLabel("garbage"), "");
});

test("selectLabel：选中项优先、首项回落、空选项安全", () => {
  const twoOpts = { options: [{ text: "司机" }, { text: "配送" }], selectedIndex: 1 };
  assert.equal(core.selectLabel(twoOpts), "配送", "取选中项");
  assert.equal(core.selectLabel({ ...twoOpts, selectedIndex: -1 }), "司机", "无选中回落首项");
  assert.equal(core.selectLabel({ options: [], selectedIndex: -1 }), "", "空选项返回空串");
  assert.equal(
    core.selectLabel({ options: [{ text: "甲" }, { value: "b" }], selectedIndex: 1 }),
    "", "选中项无 text 时回落空串（与原生 selectedOptions.textContent 一致）"
  );
  // 越界 selectedIndex 不得抛错
  assert.equal(core.selectLabel({ options: [{ text: "only" }], selectedIndex: 5 }), "only");
});
