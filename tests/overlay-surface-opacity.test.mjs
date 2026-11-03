#!/usr/bin/env node
/**
 * 浮层面板必须不透明。
 *
 * ## 为什么单独立一条护栏
 * 半透明卡片（--zp-card-translucent / -2）是设计语言的一部分：卡片压在页面纯色底上，
 * 略透一点会更「轻」。但同一套 token 被复制到**浮层**上时，底下压的是正文：
 * 弹窗背后的门店名、备注会直接透进面板，和弹窗自己的文字叠在一起，
 * 看起来像重影/乱码 —— 用户描述为「弹窗透明，文字混乱」。
 *
 * v1.0.33 之前 .data-import-panel 就是 var(--zp-card-translucent)（白 82%），
 * 数据页「恢复数据」弹窗直接把下面的列表透出来。
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
