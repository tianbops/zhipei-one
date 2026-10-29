/**
 * 错误响应纪律护栏（error-response-discipline）
 * ============================================================================
 * 背景（审计报告 P0-5，2026-10-30）：
 *   `functions/api/waybills/process.js` 的流式兜底把 `error.stack` 直接塞进
 *   `detail` 发给浏览器 —— 一次未捕获异常就会把函数内部路径、依赖调用栈、
 *   键名结构暴露给客户端。同类写法（`error: e?.message`）在 confirm / base
 *   等用户可见端点也存在，只是没到 stack 这一级。
 *
 * 本护栏把"什么能出去、什么只能进日志"固化为 CI 不变量：
 *   ① 任何 functions/ 下的响应体都不得出现 `.stack`
 *      （唯一例外：functions/api/_errors.js —— 它的职责就是把 stack 写进
 *       console.error，而不是写进响应）；
 *   ② 用户可见端点必须经 clientMessage / clientDetail 出文案，不得裸写
 *      `error: e?.message`；
 *   ③ 未预期异常必须留痕（logServerError），否则脱敏等于把故障变成哑巴。
 *
 * 投毒验证：伪造一段 `detail:error?.stack` 必须被扫描器抓到。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { clientDetail, clientMessage, isDomainError } from "../functions/api/_errors.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUNCTIONS = join(ROOT, "functions");

/** 递归收集 functions/ 下所有 .js 文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** stack 泄露扫描：返回命中行（文件:行号:内容） */
function scanStackLeak(files, { allow = new Set() } = {}) {
  const hits = [];
  for (const file of files) {
    const rel = relative(FUNCTIONS, file).replace(/\\/g, "/");
    if (allow.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // 注释里提到 .stack 不算（说明性文字），只抓真实取值
      const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      if (/\.stack\b/.test(code)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

// ① stack 不得进响应体（_errors.js 是唯一合法的 stack 落脚点）
{
  const files = walk(FUNCTIONS);
  const hits = scanStackLeak(files, { allow: new Set(["api/_errors.js"]) });
  assert.deepEqual(hits, [], `响应体出现 error.stack 泄露：\n${hits.join("\n")}`);
}

// ①' 投毒：真实写一个临时文件验证扫描器能命中（否则①的"全绿"没有意义）
{
  const fake = join(ROOT, "functions", "__poison_stack_check.js");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  writeFileSync(fake, 'export function f(){return {detail:error?.stack}}\n');
  try {
    const hits = scanStackLeak([fake], {});
    assert.equal(hits.length, 1, "投毒：detail:error?.stack 必须被扫描器拦截");
  } finally {
    unlinkSync(fake);
  }
}

// ② 用户可见端点必须走 clientMessage / clientDetail
{
  const mustUse = [
    "api/waybills/process.js",
    "api/waybills/confirm.js",
    "api/base.js",
  ];
  for (const rel of mustUse) {
    const src = readFileSync(join(FUNCTIONS, rel), "utf8");
    assert.ok(/clientMessage\s*\(/.test(src), `${rel} 应使用 clientMessage 出错误文案`);
    assert.ok(
      !/error\s*:\s*[a-zA-Z_$][\w$]*\??\.message\b/.test(src),
      `${rel} 不得裸写 error: e?.message（应经 clientMessage 判定域内/未预期）`
    );
  }
}

// ③ 脱敏不得把故障变哑巴：未预期异常必须留痕
{
  for (const rel of ["api/waybills/process.js", "api/waybills/confirm.js", "api/base.js"]) {
    const src = readFileSync(join(FUNCTIONS, rel), "utf8");
    assert.ok(/logServerError\s*\(/.test(src), `${rel} 应在服务端记录完整异常`);
  }
}

// ④ _errors.js 行为单测
{
  // 域内错误：文案透传
  const domain = Object.assign(new Error("线路门店顺序必须从1开始连续排列"), {
    code: "BASE_ROUTE_ORDER_INVALID",
  });
  assert.equal(isDomainError(domain), true);
  assert.equal(clientMessage(domain, "兜底"), "线路门店顺序必须从1开始连续排列");
  assert.equal(clientDetail(domain), "线路门店顺序必须从1开始连续排列");

  // 兜底捕获点自身的码：语义即"未知内部错误"，不可透传
  const internal = Object.assign(new Error("WRONGTYPE Operation against a key"), {
    code: "CONFIRM_INTERNAL_ERROR",
  });
  assert.equal(isDomainError(internal), false);
  assert.equal(clientMessage(internal, "确认待定门店失败"), "确认待定门店失败");
  assert.equal(clientDetail(internal), "", "未预期异常不得透出 detail");

  const unhandled = Object.assign(new Error("boom"), { code: "PROCESS_UNHANDLED_ERROR" });
  assert.equal(isDomainError(unhandled), false);
  assert.equal(clientMessage(unhandled, "处理流程发生未捕获异常"), "处理流程发生未捕获异常");

  // 无 code 的运行时异常
  const plain = new TypeError("Cannot read properties of undefined (reading 'id')");
  assert.equal(clientMessage(plain, "服务器开小差了"), "服务器开小差了");
  assert.equal(clientDetail(plain), "");

  // 非 Error 抛出物不得让脱敏本身抛异常
  assert.equal(clientMessage("raw string", "兜底"), "兜底");
  assert.equal(clientMessage(undefined, "兜底"), "兜底");
  assert.equal(clientDetail(null), "");

  // 超长域内文案必须截断，避免把整段上游响应带回前端
  const long = Object.assign(new Error("x".repeat(999)), { code: "OCR_API" });
  assert.equal(clientDetail(long, 200).length, 200, "detail 必须按 limit 截断");
}

console.log(
  "\n错误响应纪律检查通过：响应体零 stack 泄露（含投毒验证）、用户可见端点经 clientMessage 脱敏、未预期异常均留痕、_errors.js 行为单测通过"
);
