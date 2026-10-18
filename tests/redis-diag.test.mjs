// Redis 链路自检接口的守门测试。
// 目的只有一个：这个接口上线后不能变成"无门槛的 Redis 探针"，
// 也不能在诊断过程中把键名/键值吐出去（它返回的是聚合统计，靠这里钉死）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const src = fs.readFileSync(path.join(root, "functions/api/redis-diag.js"), "utf8");

// Windows 下绝对路径必须转成 file:// URL，否则 ESM 加载器报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(path.join(root, "functions/api/redis-diag.js")).href);

function ctx(query, env){
  return {request: new Request("https://example.invalid/api/redis-diag" + query), env: env || {}};
}

test("redis-diag: 无 k 参数直接 404，不消耗 Redis", async () => {
  const res = await mod.onRequestGet(ctx("", {UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t"}));
  assert.equal(res.status, 404, "未带诊断密钥必须当作接口不存在");
});

test("redis-diag: k 正确但未配置 Redis 时只报未配置，不发请求", async () => {
  const res = await mod.onRequestGet(ctx("?k=zpdiag-8f3a2c", {}));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.equal(body.error, "REDIS_NOT_CONFIGURED");
});

test("redis-diag: 只输出聚合统计，不回显键名与键值", () => {
  // 禁止出现能拿到键内容的读命令
  for (const cmd of ["GET,", "HGETALL", "LRANGE", "SMEMBERS", "MGET"]) {
    assert.ok(!src.includes('"' + cmd + '"') && !src.includes("'" + cmd + "'"),
      "诊断接口不应读取键内容: " + cmd);
  }
  // 输出体里不能带键名数组
  assert.ok(!/sample_keys|keys:\s*keys|allKeys\b/.test(src), "诊断接口不应输出键名清单");
  assert.ok(src.includes("by_prefix"), "应当只按前缀聚合");
});

test("redis-diag: 暴露 Worker 所在 PoP 与 RTT 采样（迁移效果要靠它量化）", () => {
  assert.ok(src.includes('request.cf?.colo'), "必须回传 CF PoP，用于确认 Worker 落点");
  assert.ok(src.includes('["PING"]'), "必须做 PING 往返采样");
  assert.ok(src.includes("endpoint"), "必须回传端点（用于确认连的是哪个区域的库）");
});
