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

test("redis-diag: 支持 ?w=1 写探针（区分真空库与 SCAN 失效）", () => {
  assert.ok(src.includes('searchParams.get("w")'), "必须支持写探针开关");
  assert.ok(src.includes("seen_by_scan"), "写探针必须回传 SCAN 是否能看到刚写的键");
  assert.ok(src.includes('"EX", "60"'), "临时键必须带 TTL，不能留下垃圾");
  assert.ok(src.includes('["DEL", probe]'), "写完必须清理");
});

test("redis-diag: 暴露 Worker 所在 PoP 与 RTT 采样（迁移效果要靠它量化）", () => {
  assert.ok(src.includes('request.cf?.colo'), "必须回传 CF PoP，用于确认 Worker 落点");
  assert.ok(src.includes('["PING"]'), "必须做 PING 往返采样");
  assert.ok(src.includes("endpoint"), "必须回传端点（用于确认连的是哪个区域的库）");
});

test("redis-diag: 报告管理员初始化密钥是否已配置（空库死锁的判据）", async () => {
  // 只报布尔，绝不回传密钥值
  assert.ok(src.includes("adminSetupKeyConfigured"), "必须回传管理员初始化密钥的配装状态");
  assert.ok(!/adminSetupKeyConfigured:\s*env\.ADMIN_SETUP_KEY/.test(src),
    "绝不能回传 ADMIN_SETUP_KEY 的值");
  const res = await mod.onRequestGet(ctx("?k=zpdiag-8f3a2c", {ADMIN_SETUP_KEY: "s3cret"}));
  assert.equal((await res.json()).adminSetupKeyConfigured, true);
  const res2 = await mod.onRequestGet(ctx("?k=zpdiag-8f3a2c", {}));
  assert.equal((await res2.json()).adminSetupKeyConfigured, false);
});

test("redis-diag: 环境变量自检表覆盖全部必填项，且绝不回传变量值", async () => {
  for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
                      "PADDLEOCR_ACCESS_TOKEN", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH"]) {
    assert.ok(src.includes('name:"' + name + '"'), "自检表缺少必填变量: " + name);
  }
  // 僵尸变量要能被识别出来，否则用户会一直以为"配了就生效"
  for (const name of ["ADMIN_BOOTSTRAP_KEY", "DATA_RESET_KEY"]) {
    assert.ok(src.includes('name:"' + name + '"') && src.includes("deprecated:true"),
      "应把 " + name + " 标为已废弃（代码从不读取）");
  }
  // 只回传 set 布尔，任何变量值都不许出现在输出里
  assert.ok(!/value\s*:\s*env\./.test(src), "自检表绝不能回传变量值");

  const bare = await (await mod.onRequestGet(ctx("?k=zpdiag-8f3a2c", {
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1", UPSTASH_REDIS_REST_TOKEN: "t",
  }))).json();
  const chk = bare.env_check;
  assert.ok(chk, "必须输出环境变量自检表");
  assert.equal(chk.ok, false, "缺管理员变量时 ok 必须为 false");
  assert.deepEqual(chk.missing_required.sort(),
    ["ADMIN_PASSWORD_HASH", "ADMIN_USERNAME", "PADDLEOCR_ACCESS_TOKEN"],
    "缺失项必须逐条列出");

  // 只配账号不配哈希 = 不可用（envAdminCredentials 要求成对且格式合法）
  const half = await (await mod.onRequestGet(ctx("?k=zpdiag-8f3a2c", {
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1", UPSTASH_REDIS_REST_TOKEN: "t",
    PADDLEOCR_ACCESS_TOKEN: "x", ADMIN_USERNAME: "root",
  }))).json();
  assert.equal(half.env_check.env_admin_usable, false, "管理员变量必须成对配置");
  assert.equal(half.env_check.ok, false);
});
