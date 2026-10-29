/**
 * CSS 强制声明配额守卫（node tests/css-important-budget.test.mjs）
 * -----------------------------------------------------------
 * 背景：`!important` 曾从几十条悄悄涨到 274 条，原因是没有任何机制拦截。
 * 2026-10-29 的 UI 专项把它们压到 48 条（管理端三文件 84 → 0，密码框 9 条清零），
 * 但删完不设闸门，下次还会长回去。本测试就是那道闸门。
 *
 * 规则：
 *   1) 每文件条数不得高于基线（基线只减不增）；
 *   2) 基线里没有的文件出现任何一条即失败；
 *   3) 总数不得高于 TOTAL。
 *
 * 为什么不是「一条都不许有」：剩下 48 条里约一半是机制性的，见下面 BASELINE 的分组注释。
 * 真要新增，正确做法是先证明「普通级联做不到」，再改基线并写清理由 —— 让增长有成本。
 *
 * 统计口径：用 PostCSS 解析后读声明值，注释里出现的 important 字样不计入
 * （2026-10-29 就踩过正则统计把注释算进去、指标失真的坑）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import postcss from "postcss";

const root = fileURLToPath(new URL("..", import.meta.url));
const CSS_DIR = `${root}css`;

/** 构建产物（由 home-base / home-trend / home-dashboard / home-light 拼接），不重复计数。 */
const GENERATED = new Set(["home.bundle.css"]);

/**
 * 基线：文件 → { 条数, 说明 }
 * 分组说明（2026-10-29 复盘时的定性结论）：
 *   机制必需 —— 删除即功能受损，理应长期保留：
 *     · ui-overlay 6：层级令牌（modal / stack / toast / menu / float）。层级系统的本质
 *       就是「无视上下文顺序地压在最上层」，用级联无法表达，属于 !important 的正当用途。
 *     · zp-picker 11：隐藏原生 <select>（JS 会写 inline style）+ 触发器按压态被 inline 覆盖。
 *     · ui-base 4：`[hidden][hidden]`（对抗 display:flex）、`.zp-ui-ready` 首屏关动画总闸、
 *       `.zp-password-eye[hidden]`（同 [hidden] 家族）。
 *     · mobile-ui 4：reduce-motion 无障碍（0.01ms 动画时长必须覆盖全站组件）。
 *     · ui-shell 1：登录壳防闪，与内联 style 竞争。
 *   局部修饰 —— 压的是单点属性（一个颜色/一条过渡），非双份实现，暂保留：
 *     · history-overlays 8、order_detail 5、history-list 5、data 2、business-pages 1、home-trend 1。
 */
const BASELINE = {
  "ui-overlay.css": { n: 6, why: "机制：层级令牌 z-index" },
  "zp-picker.css": { n: 11, why: "机制：隐藏原生 select / 按压态" },
  "ui-base.css": { n: 4, why: "机制：[hidden]、动画总闸、眼睛按钮隐藏" },
  "mobile-ui.css": { n: 4, why: "机制：reduce-motion 无障碍" },
  "ui-shell.css": { n: 1, why: "机制：登录壳防闪" },
  "history-overlays.css": { n: 8, why: "局部修饰：单个按钮配色" },
  "order_detail.css": { n: 5, why: "局部修饰：a:visited 去下划线" },
  "history-list.css": { n: 5, why: "局部修饰：浅色主题卡片透明" },
  "data.css": { n: 2, why: "局部修饰：图标按钮字号归零" },
  "business-pages.css": { n: 1, why: "局部修饰：危险色" },
  "home-trend.css": { n: 1, why: "局部修饰：图表过渡" },
};
const TOTAL = Object.values(BASELINE).reduce((s, v) => s + v.n, 0);

/** 统计一份 CSS 里的强制声明数（按声明值判断，注释不计）。 */
function countImportant(cssText) {
  const rootNode = postcss.parse(cssText);
  let n = 0;
  rootNode.walkDecls((decl) => {
    if (/!\s*important/i.test(decl.value)) n += 1;
  });
  return n;
}

test("CSS !important 配额：单文件不得超基线，新增文件不得引入", () => {
  const files = readdirSync(CSS_DIR).filter((f) => f.endsWith(".css") && !GENERATED.has(f));
  const actual = {};
  for (const f of files) {
    const n = countImportant(readFileSync(`${CSS_DIR}/${f}`, "utf8"));
    if (n) actual[f] = n;
  }

  const problems = [];

  for (const [file, n] of Object.entries(actual)) {
    const base = BASELINE[file];
    if (!base) {
      problems.push(`${file}: 新增 ${n} 条（该文件基线为 0，不允许引入 !important）`);
    } else if (n > base.n) {
      problems.push(`${file}: ${base.n} → ${n}（+${n - base.n}，${base.why}）`);
    }
  }

  const total = Object.values(actual).reduce((s, n) => s + n, 0);
  if (total > TOTAL) problems.push(`总数 ${TOTAL} → ${total}（+${total - TOTAL}）`);

  assert.deepEqual(
    problems,
    [],
    `检测到 !important 增长：\n  ${problems.join("\n  ")}\n\n` +
      "优先用「收紧上游选择器作用域 / 提高组件特异性 / 收编为单一来源」解决；\n" +
      "确属机制必需（层级、[hidden]、无障碍总闸）再改 tests/css-important-budget.test.mjs 的 BASELINE 并写明理由。"
  );
});

test("配额基线自身的账目自洽", () => {
  // 防止有人只改 BASELINE 数字却不写理由，或写出负数/非整数
  for (const [file, base] of Object.entries(BASELINE)) {
    assert.ok(Number.isInteger(base.n) && base.n > 0, `${file} 基线应为正整数`);
    assert.ok(base.why && base.why.length >= 4, `${file} 基线缺少理由说明`);
  }
  assert.equal(TOTAL, 48, "总数基线应为 48（2026-10-29 UI 专项收尾值）");
});
