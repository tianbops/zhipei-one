/**
 * /api/* 兜底 404 契约（tests/api-404.test.mjs）
 * ------------------------------------------------------------
 * 背景：Pages 静态资源有 SPA fallback，未命中的 /api/* 会返回 200 + index.html。
 * 端点被删除或路径写错时，客户端拿到的是 HTML，JSON.parse 报
 * "Unexpected token '<'"，排查时无法区分「404」与「服务异常」，日志里也没有痕迹。
 *
 * 本守卫断言：
 *   1. functions/api/[[path]].js 存在，且未命中时返回 404 + 机器可读的 JSON code；
 *   2. 真实端点文件仍然存在（catch-all 不得因为命名/位置问题把已有路由顶掉）；
 *   3. 响应体不是 HTML。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catchAll = path.join(root, "functions", "api", "[[path]].js");

assert.ok(existsSync(catchAll), "缺少 functions/api/[[path]].js 兜底 404");

const { onRequest } = await import("../functions/api/[[path]].js");
const res = await onRequest({
  request: new Request("https://example.com/api/definitely-not-a-route"),
  env: {},
});
assert.equal(res.status, 404, "未知 /api/* 必须返回 404");
assert.match(
  String(res.headers.get("content-type") || ""),
  /application\/json/,
  "兜底响应必须是 JSON，不能是 HTML"
);
const body = await res.json();
assert.equal(body.success, false, "success 必须为 false");
assert.equal(body.code, "API_NOT_FOUND", "code 必须为 API_NOT_FOUND");
assert.ok(body.error, "必须带人类可读的 error 文案");

// 不允许 catch-all 顶掉真实端点：抽查几个高频端点文件仍在原位
for (const rel of ["health.js", "waybills/process.js", "history.js", "admin/users.js"]) {
  assert.ok(
    existsSync(path.join(root, "functions", "api", rel)),
    `真实端点丢失：functions/api/${rel}`
  );
}

console.log("API 兜底 404 守卫：通过（未知端点返回 404 JSON，真实端点未被遮挡）");
