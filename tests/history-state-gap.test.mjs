/**
 * 历史查询「选择日期」下方空白契约（node tests/history-state-gap.test.mjs）
 * ------------------------------------------------------------------
 * 守护需求：有历史数据时，「选择日期」按钮到第一个月份之间只保留工具栏
 * 正常留白（约 18px），不得出现一大块纯黑空白（用户对比图反馈）。
 *
 * 根因（2026-11-04）：render.js 渲染成功后只 stateEl.textContent="" 清空文本，
 * 不隐藏元素；而 #historyState 是 .zp-empty（padding:28px 12px），空元素仍
 * 白占 56px，把整个月份列表往下推 —— 实测按钮底→首月顶 75px，其中 56px
 * 来自这个空节点。修复：css/history-shell.css 加 #historyState:empty{display:none}。
 *
 * 契约要点（易回归，必须锁死）：
 *   1) #historyState:empty{display:none} 存在；
 *   2) .zp-empty 仍带 padding:28px（这正是空节点会占位的原因，规则不可省）；
 *   3) render.js 成功分支确实清空文本（使 :empty 成立）；
 *   4) 空态 / 错误态仍写入文案（有文本 → 不 :empty → 提示照常显示），
 *      且不得用 hidden 属性常驻隐藏（否则空态也不显示）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHELL = readFileSync(fileURLToPath(new URL("../css/history-shell.css", import.meta.url)), "utf8");
const BASE = readFileSync(fileURLToPath(new URL("../css/ui-base.css", import.meta.url)), "utf8");
const RENDER = readFileSync(fileURLToPath(new URL("../js/history/render.js", import.meta.url)), "utf8");
const DATA = readFileSync(fileURLToPath(new URL("../js/history/data.js", import.meta.url)), "utf8");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

console.log("历史查询「选择日期」下方空白契约（5 条）");
{
  t("空提示节点不占位：#historyState:empty{display:none}",
    /#historyState:empty\s*\{\s*display:none/.test(SHELL));

  // .zp-empty 的 padding 是元凶；若哪天它改成 0，规则仍无害，但这条断言提示
  // 「曾有一个 56px 的空占位」，避免有人误以为规则多余而删掉。
  const zpEmpty = BASE.slice(BASE.indexOf(".zp-empty{"), BASE.indexOf(".zp-empty{") + 240);
  t(".zp-empty 自带 padding:28px（空节点本会白占 56px，规则不可省）",
    /padding:28px/.test(zpEmpty), zpEmpty.slice(0, 120));

  t("render.js 渲染成功分支清空文本（使 :empty 成立）",
    /stateEl\.textContent\s*=\s*""\s*;/.test(RENDER));

  t("空态仍写入「暂无历史记录」文案（有文本 → 提示照常显示，不会被 :empty 隐藏）",
    /stateEl\.textContent\s*=\s*"暂无历史记录"/.test(RENDER));

  t("错误态仍写入失败文案，且不用 hidden 常驻隐藏（空态/错误态都能显示）",
    /stateEl\.textContent\s*=\s*e\.message/.test(DATA) &&
    !/stateEl\.hidden\s*=\s*true/.test(RENDER) &&
    !/stateEl\.hidden\s*=\s*true/.test(DATA));
}

function finish() {
  console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}
finish();
