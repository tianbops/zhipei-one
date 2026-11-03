#!/usr/bin/env node
/**
 * 全局容器（卡片 / 面板 / 弹层）必须不透明，且底色随外观切换。
 *
 * ## 为什么单独立一条护栏
 * 半透明卡片（--zp-card-translucent / -2）是设计语言的一部分：卡片压在页面纯色底上，
 * 略透一点会更「轻」。但同一套 token 被复制到**浮层**上时，底下压的是正文：
 * 弹窗背后的门店名、备注会直接透进面板，和弹窗自己的文字叠在一起，
 * 看起来像重影/乱码 —— 用户描述为「弹窗透明，文字混乱」。
 *
 * 2026-11-04 用户要求「全局统一风格，取消透明，随外观色变化而变化」：
 * 不再只修浮层，而是把 --zp-card-translucent / -2 两个 token 整体收敛为
 * --zp-card（=--zp-surface）/ --zp-card-2（=--zp-surface-2），
 * 102 处引用一次性变实底；因为值本身是 var(--zp-surface*)，深浅主题各自解析，
 * 所以「随外观变化」是结构保证，不靠逐处补丁。
 *
 * ## 判定口径
 * 只看「最终会覆盖在内容之上」的面板类，且只判该类的**背景**：
 *   - 面板类出现在选择器末尾（.dialog / .data-import-panel{...}）→ 判
 *   - 面板类只是祖先（.dialog button{...}）→ 跳过，按钮在实底上无所谓
 * 遮罩层另有要求：必须是 scrim，不能拿卡片色当遮罩（白雾既挡不住内容也不像遮罩）。
 *
 * 用法：node tests/overlay-surface-opacity.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 覆盖在内容之上的面板容器（含各页自己的实现）。新增弹窗请登记到这里。 */
const PANELS = [
  ".dialog",
  ".account-dialog",
  ".data-import-panel",
  ".history-dialog-panel",
  ".history-picker-panel",
  ".order-dialog-panel",
  ".order-menu",
  ".data-page-menu",
  ".data-feedback",
  ".zp-pk-sheet",
  ".upload-sheet",
  ".zp-confirm-panel",
];

/** 全屏遮罩：必须是 scrim（深色半透明），不能是卡片色。 */
const SCRIMS = [".dialog-bg", ".zp-pk-bg"];

const cssFiles = fs
  .readdirSync(path.join(root, "css"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ file: `css/${f}`, text: fs.readFileSync(path.join(root, "css", f), "utf8") }));

/** 去注释，避免注释里的示例值参与判定。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 拆规则：`选择器{声明}`，够用于本项目（无嵌套 CSS）。 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

/** 选择器的最后一段（去掉 ::after、:hover、[hidden] 等修饰）。 */
function lastCompound(selector) {
  const parts = selector.split(",").map((s) => s.trim());
  const last = parts[parts.length - 1];
  const idx = last.search(/[\s>+~]/);
  return (idx < 0 ? last : last.slice(idx + 1)).replace(/::?[a-z-]+(\([^)]*\))?/gi, "").replace(/\[[^\]]*\]/g, "");
}

function bgValue(body) {
  const m = body.match(/(?<![\w-])background(?:-color)?\s*:\s*([^;]+)/);
  return m ? m[1].trim() : null;
}

test("浮层面板一律不透明（禁止 translucent / 低 alpha rgba）", () => {
  const bad = [];
  for (const { file, text } of cssFiles) {
    for (const r of rules(text)) {
      const tail = lastCompound(r.selector);
      // 精确到类名：.data-page-menu-btn 不是 .data-page-menu
      const classes = (tail.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1));
      if (!PANELS.some((p) => classes.includes(p.slice(1)))) continue;
      const bg = bgValue(r.body);
      if (!bg) continue;
      const translucent = bg.includes("translucent");
      const lowAlpha = /rgba?\([^)]*,\s*(0?\.\d+|0)\s*\)/.test(bg);
      if (translucent || lowAlpha) bad.push(`${file}  ${r.selector}  →  ${bg}`);
    }
  }
  assert.deepEqual(bad, [], "以下浮层面板背景半透明，背后的正文会透进来：\n" + bad.join("\n"));
});

test("全屏遮罩用 scrim，不用卡片色", () => {
  const bad = [];
  for (const { file, text } of cssFiles) {
    for (const r of rules(text)) {
      const tail = lastCompound(r.selector);
      if (!SCRIMS.some((s) => tail === s || tail.endsWith(s))) continue;
      const bg = bgValue(r.body);
      if (!bg) continue;
      if (!/var\(--zp-scrim/.test(bg)) bad.push(`${file}  ${r.selector}  →  ${bg}`);
    }
  }
  assert.deepEqual(bad, [], "以下遮罩没有用 --zp-scrim / --zp-scrim-dialog：\n" + bad.join("\n"));
});

/* ===== 2026-11-04 全局收敛：令牌层与全容器层 ===== */

const cssText = cssFiles.map((f) => ({ file: f.file, text: stripComments(f.text) }));

test("半透明卡片令牌已下线，不得复活", () => {
  const bad = [];
  for (const { file, text } of cssText) {
    if (/--zp-card-translucent/.test(text)) bad.push(file);
  }
  assert.deepEqual(bad, [], "以下文件仍引用 --zp-card-translucent*（已下线，改用 --zp-card / --zp-card-2）：\n" + bad.join("\n"));
});

test("--zp-card / --zp-card-2 指向表面令牌，只在 :root 定义一次", () => {
  const found = { "--zp-card": [], "--zp-card-2": [] };
  for (const { file, text } of cssText) {
    for (const m of text.matchAll(/(--zp-card(?:-2)?)\s*:\s*([^;}]+)/g)) {
      found[m[1]].push({ file, value: m[2].trim() });
    }
  }
  // home.bundle.css 是首页的打包副本，允许同一令牌在 ui-base 与 bundle 各定义一次，
  // 但值必须完全一致；深色不得再单独重定义（靠 --zp-surface 覆盖自动跟随）。
  for (const [name, expect] of [["--zp-card", "var(--zp-surface)"], ["--zp-card-2", "var(--zp-surface-2)"]]) {
    const hits = found[name];
    assert.ok(hits.length >= 1, `${name} 未定义`);
    const wrong = hits.filter((x) => x.value !== expect);
    assert.deepEqual(wrong, [], `${name} 只能等于 ${expect}；深色请改 --zp-surface*，不要重定义卡片令牌`);
    const files = hits.map((x) => x.file);
    assert.equal(new Set(files).size, files.length, `${name} 在同一文件内重复定义：${files.join(", ")}`);
  }
});

test("任何 background 都不得使用半透明字面量（遮罩除外）", () => {
  const bad = [];
  for (const { file, text } of cssText) {
    for (const r of rules(text)) {
      const bg = bgValue(r.body);
      if (!bg) continue;
      if (/rgba?\(/.test(bg)) bad.push(`${file}  ${r.selector}  →  ${bg}`);
    }
  }
  assert.deepEqual(bad, [], "以下容器直接用 rgba 做背景，深色下极易变成白雾/黑雾：\n" + bad.join("\n"));
});

test("交互态与卡片底差一档（:active / .selected 不得用 --zp-card）", () => {
  const bad = [];
  for (const { file, text } of cssText) {
    for (const r of rules(text)) {
      if (!/(:active|\.selected|\.is-active)/.test(r.selector)) continue;
      const bg = bgValue(r.body);
      if (!bg) continue;
      if (bg === "var(--zp-card)") bad.push(`${file}  ${r.selector}  →  ${bg}`);
    }
  }
  assert.deepEqual(bad, [], "以下交互态与卡片同色，按下去看不出反馈（应改 --zp-card-2）：\n" + bad.join("\n"));
});
