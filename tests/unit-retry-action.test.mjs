/**
 * 运单处理失败 → 前端「一键重试」动作映射回归测试
 * ------------------------------------------------------------------
 * 运行：node tests/unit-retry-action.test.mjs
 *
 * 实现方式：直接截取 js/home/upload-error.js 中 [RETRY-MAP-START]..[RETRY-MAP-END] 之间的
 * 真实源码（retryActionInfo + RETRY_ACTION_INFO），以 new Function 求值后断言，
 * 因此修改源文件后本测试自动跟随，不会出现「测试通过但线上不是这个行为」的情况。
 * 与后端 process.js 的 failProcess 信封（action/recoverable）对齐。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../js/home/upload-error.js", import.meta.url)), "utf8");
const START = "/* [RETRY-MAP-START]";
const END = "[RETRY-MAP-END] */";
const i = SRC.indexOf(START);
const j = SRC.indexOf(END);
if (i < 0 || j < 0 || j <= i) throw new Error("未找到 RETRY-MAP 切片锚点，请检查 home.js");
const body = SRC.slice(i, j + END.length);
const factory = new Function(body + "\nreturn { retryActionInfo, RETRY_ACTION_INFO };");
const { retryActionInfo, RETRY_ACTION_INFO } = factory();

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

// 1) 自动复用同文件重试的三类：OCR / 保存 / 重处理
t("RETRY_OCR → 重新识别且可自动重试", (() => { const x = retryActionInfo("RETRY_OCR"); return x && x.label === "重新识别" && x.autoRetry === true; })());
t("RETRY_SAVE → 重试保存且可自动重试", (() => { const x = retryActionInfo("RETRY_SAVE"); return x && x.label === "重试保存" && x.autoRetry === true; })());
t("REPROCESS → 重新处理且可自动重试", (() => { const x = retryActionInfo("REPROCESS"); return x && x.label === "重新处理" && x.autoRetry === true; })());

// 2) 需重新选文件 / 仅提示：不可自动重试
t("RESUBMIT → 重新上传且不可自动重试", (() => { const x = retryActionInfo("RESUBMIT"); return x && x.label === "重新上传" && x.autoRetry === false; })());
t("RETRY_LATER → 不可自动重试", (() => { const x = retryActionInfo("RETRY_LATER"); return x && x.autoRetry === false; })());

// 3) 不可重试（含 OCR_NOT_CONFIGURED 的 null action、未知值、空值）→ 返回 null，按钮退化为关闭
t("null action → 不可重试(null)", retryActionInfo(null) === null);
t("空串 action → 不可重试(null)", retryActionInfo("") === null);
t("未知 action → 不可重试(null)", retryActionInfo("WAYBILL_NOT_A_KNOWN_ACTION") === null);

// 4) 与后端枚举完整对齐：process.js 产出的全部 action 值都应在映射中（除 null 外）
const backendActions = ["RETRY_OCR", "RETRY_SAVE", "REPROCESS", "RESUBMIT", "RETRY_LATER"];
for (const a of backendActions) {
  t("后端动作 " + a + " 在映射中存在", !!RETRY_ACTION_INFO[a]);
}

console.log(`重试动作映射：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✅ 全部通过");
