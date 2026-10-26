/**
 * 剪贴板「一键粘贴」读取链护栏（paste-bridge）
 * ============================================================================
 * 覆盖对象：js/home/upload-sheet.js 的剪贴板读取优先级与三态处理。
 *
 * 背景：App 壳（tianbops/zhipei）通过 ZhipeiNative.getClipboardText() 直接读系统
 * 剪贴板——因为 WebView 里 navigator.clipboard.readText() 在国产 WebView 与系统
 * 内置浏览器上普遍不可用，导致「一键粘贴」只能退化成"请长按粘贴"。这是跨仓库
 * 契约：壳暴露方法、Web 侧按约定调用，任一侧改签名都会静默失效（只在真机上
 * 暴露，CI 跑不到），故在此把契约与优先级钉死。
 *
 * 三态约定（与壳 MainActivity.getClipboardText 对齐）：
 *   非空字符串 = 剪贴板文本 → 直接粘入
 *   ""         = 剪贴板无文字（空/非文本条目）→ 权威结论，不降级
 *   null/无桥  = 读取失败或不在 App 内 → 继续走 Web 链路
 *
 * 读取链优先级：原生桥 → 异步 Clipboard API → execCommand('paste') → 长按引导
 * ============================================================================
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SRC = fs.readFileSync(path.join(root, "js/home/upload-sheet.js"), "utf8");

/* 扫描前先剥掉注释：注释里会解释「为什么优先原生桥」，里面同样出现
   navigator.clipboard 等字样，不剥掉会把注释位置误判成代码位置。
   块注释整段去；行注释只去「整行以 // 开头」的那些（不会误伤 URL 里的 //）。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/* 只扫描「一键粘贴」点击处理器本体：文件里更早的位置有辅助函数，那不是
   运行时读取链的先后顺序。 */
const HANDLER_START = CODE.indexOf('pasteFromClipboardBtn.addEventListener("click"');
const HANDLER_END = CODE.indexOf("if(textPanelBackBtn)", HANDLER_START);
const HANDLER = CODE.slice(HANDLER_START, HANDLER_END);
assert.ok(HANDLER_START > 0 && HANDLER_END > HANDLER_START, "必须能定位到粘贴点击处理器");

test("存在原生壳桥接调用：ZhipeiNative.getClipboardText", () => {
  assert.ok(CODE.includes("ZhipeiNative"), "必须读取 window.ZhipeiNative");
  assert.ok(CODE.includes("getClipboardText"), "必须调用 getClipboardText");
});

test("读取链优先级：原生桥 → 异步 Clipboard API → execCommand → 长按引导", () => {
  const iNative = HANDLER.indexOf("ZhipeiNative");
  const iAsync = HANDLER.indexOf("navigator.clipboard");
  const iExec = HANDLER.indexOf("tryExecCommandPaste()");
  const iHint = HANDLER.indexOf("长按下方输入框粘贴");
  assert.ok(iNative > 0 && iAsync > 0 && iExec > 0 && iHint > 0, "四段链路都必须存在");
  assert.ok(iNative < iAsync, "原生桥必须排在异步 Clipboard API 之前");
  assert.ok(iAsync < iExec, "异步 API 必须排在 execCommand 之前");
  assert.ok(iExec < iHint, "execCommand 必须排在长按引导之前");
});

test("三态处理：区分「剪贴板无文字」与「读取失败」", () => {
  assert.ok(CODE.includes("nativeChecked"), "必须用 nativeChecked 区分「桥不存在」与「桥返回空」");
  assert.ok(
    CODE.includes('typeof nativeText==="string"'),
    "必须按 typeof 判定原生桥是否给出权威结论（空串 vs null）"
  );
  assert.ok(CODE.includes("剪贴板里没有文字"), "剪贴板无文字时应有明确提示");
});

test("原生桥读到文本时直接粘入，不再走降级", () => {
  const iNative = HANDLER.indexOf("ZhipeiNative");
  const iInsert = HANDLER.indexOf("insertWaybillText(nativeText)");
  assert.ok(iInsert > iNative, "粘入动作必须发生在调用原生桥之后");
});

test("成功路径不强制聚焦文本框（避免无谓弹出输入法）", () => {
  const nativeBlock = HANDLER.slice(HANDLER.indexOf('if(nativeChecked&&typeof nativeText==="string")'));
  const asyncBlock = HANDLER.slice(HANDLER.indexOf("const text=await navigator.clipboard.readText()"));
  assert.ok(nativeBlock.includes("insertWaybillText(nativeText)"), "原生桥路径须粘入");
  assert.ok(
    !/insertWaybillText\(nativeText\);\s*return;\s*}\s*waybillTextInput\.focus\(\)/.test(nativeBlock),
    "原生桥成功路径不应再 focus()"
  );
  assert.ok(asyncBlock.includes("insertWaybillText(text)"), "异步 API 路径须粘入");
});
