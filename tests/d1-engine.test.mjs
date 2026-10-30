/**
 * 智配One · D1 引擎离线测试（无需真实 Cloudflare 环境）
 * ------------------------------------------------------------------
 * 用 node:sqlite 充当 D1 兼容后端（满足 prepare/bind/run/all/first/exec 形状），
 * 验证 functions/api/_db.js（D1 存储引擎）+ _redis-eval.js（EVAL 注册表）：
 *   1) 命令面：GET/SET/DEL/EXISTS/EXPIRE/TTL/INCR/H* / S* / L* / MGET / SCAN / HSCAN
 *   2) 事务原子性 + TTL 过期
 *   3) 注册表覆盖：源码里全部 EVAL 脚本都能在注册表命中（静态）
 *   4) 冒烟：全部 EVAL 脚本都能在引擎里找到处理器并执行（不抛 UNIMPLEMENTED_EVAL）
 *   5) 行为：分布式锁释放（CAS-DEL）、learnGlobal 版本自增（INCR+HSET+RPUSH+SET）
 *
 * 运行：node tests/d1-engine.test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
import { D1Backend } from "../functions/api/_db.js";
import { createD1SessionEnv } from "../functions/api/_redis.js";
import { lookupEval, HANDLERS } from "../functions/api/_redis-eval.js";
import { normalizeLua } from "../functions/api/_redis-norm.js";

const API = path.join(ROOT, "functions/api");

// ============ node:sqlite → D1 形态适配器 ============
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }
  run(...p) {
    const params = p.length ? p : this.params;
    const r = this.db._raw.prepare(this.sql).run(...params);
    return { changes: r.changes };
  }
  all(...p) {
    const params = p.length ? p : this.params;
    return { results: this.db._raw.prepare(this.sql).all(...params) };
  }
  first(...p) {
    const params = p.length ? p : this.params;
    const row = this.db._raw.prepare(this.sql).get(...params);
    return row === undefined ? null : row;
  }
}
class SqliteAdapter {
  constructor(raw) { this._raw = raw; }
  prepare(sql) { return new Stmt(this, sql); }
  exec(sql) { this._raw.exec(sql); }
  // D1 batch：原子执行一批语句（这里用本地事务模拟真实 D1 的原子性语义）。
  // 真实 D1 对 SELECT 返回 {results:[...]}、对写语句返回 {meta:{changes}}——按此形状回填。
  async batch(stmts) {
    this._raw.exec("BEGIN");
    try {
      const results = [];
      for (const s of stmts) {
        const prepared = this._raw.prepare(s.sql);
        const isRead = /^\s*(SELECT|WITH)\b/i.test(s.sql);
        results.push(isRead ? { results: prepared.all(...s.params) } : { meta: { changes: prepared.run(...s.params).changes } });
      }
      this._raw.exec("COMMIT");
      return results;
    } catch (e) {
      try { this._raw.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
}

function makeEngine() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, expires_at INTEGER)");
  const adapter = new SqliteAdapter(raw);
  const metrics = { prepare: 0, batch: 0 };
  const prepare = adapter.prepare.bind(adapter);
  const batch = adapter.batch.bind(adapter);
  adapter.prepare = sql => { metrics.prepare++; return prepare(sql); };
  adapter.batch = stmts => { metrics.batch++; return batch(stmts); };
  const backend = new D1Backend(adapter);
  return { raw, backend, metrics };
}

// ============ 轻量断言 ============
let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; fails.push(msg); console.error("  ✗ " + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`); }

// ============ 抽取源码里全部 EVAL 脚本（与迁移自检同源逻辑） ============
function readStr(src, start) {
  const q = src[start]; let j = start + 1; let s = "";
  while (j < src.length) {
    if (src[j] === "\\") { s += src[j] + (src[j + 1] || ""); j += 2; continue; }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") { s += "${}"; j += 2; continue; }
    if (src[j] === q) { j++; break; }
    s += src[j]; j++;
  }
  return { text: s, end: j };
}
function extractScripts(src) {
  const out = []; const n = src.length; let i = 0;
  while (i < n) {
    const p = src.indexOf("EVAL", i);
    if (p === -1) break;
    let j = src.indexOf('"', p); if (j === -1) { i = p + 4; continue; }
    j = readStr(src, j).end;
    while (j < n && ",[] \t".includes(src[j])) j++;
    if (j >= n || !"'\"`".includes(src[j])) { i = p + 4; continue; }
    out.push(readStr(src, j).text); i = j;
  }
  const re = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(['"`])/g; let m;
  while ((m = re.exec(src))) {
    const r = readStr(src, m.index + m[0].length - 1);
    if (/redis\.call/.test(r.text)) out.push(r.text);
  }
  return out;
}
function walkScripts(dir, files = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e); const st = statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", ".git", "tests", "tools", "scripts"].includes(e) || e.startsWith(".")) continue;
      walkScripts(p, files);
    } else if (e.endsWith(".js") && !["_redis-eval.js", "_db.js", "_redis-norm.js"].includes(e)) files.push(p);
  }
  return files;
}

// ============ 1) 命令面测试 ============
async function testCommandSurface() {
  console.log("\n[1] 命令面（string / hash / set / list / counter / scan）");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);

  // string
  eq(await c("SET", "k1", "hello"), "OK", "SET 返回 OK");
  eq(await c("GET", "k1"), "hello", "GET 取回原值");
  eq(await c("EXISTS", "k1"), 1, "EXISTS 命中=1");
  eq(await c("EXISTS", "nope"), 0, "EXISTS 未命中=0");
  eq(await c("DEL", "k1"), 1, "DEL 返回删除数");
  eq(await c("GET", "k1"), null, "DEL 后 GET 为 null");

  // SET NX / XX
  eq(await c("SET", "nxk", "v1", "NX"), "OK", "SET NX 新建成功");
  eq(await c("SET", "nxk", "v2", "NX"), null, "SET NX 已存在返回 null");
  eq(await c("SET", "xxk", "a", "XX"), null, "SET XX 不存在返回 null");
  await c("SET", "xxk", "a");
  eq(await c("SET", "xxk", "b", "XX"), "OK", "SET XX 已存在成功");

  // EX / TTL
  await c("SET", "tk", "x", "EX", "100");
  const ttl = await c("TTL", "tk"); ok(ttl >= 95 && ttl <= 100, "TTL 约等于 100（得到 " + ttl + "）");
  eq(await c("TTL", "nope"), -2, "TTL 不存在=-2");
  await c("SET", "perm", "y");
  eq(await c("TTL", "perm"), -1, "TTL 永不过期=-1");

  // INCR
  eq(await c("INCR", "cnt"), 1, "INCR 初值=1");
  eq(await c("INCR", "cnt"), 2, "INCR 自增=2");
  eq(await c("INCRBY", "cnt", 10), 12, "INCRBY +10=12");

  // hash
  eq(await c("HSET", "h1", "f1", "v1", "f2", "v2"), 2, "HSET 新增两字段");
  eq(await c("HGET", "h1", "f1"), "v1", "HGET 取字段");
  eq(await c("HGET", "h1", "missing"), null, "HGET 缺字段=null");
  eq(await c("HLEN", "h1"), 2, "HLEN=2");
  eq(await c("HDEL", "h1", "f1"), 1, "HDEL 删一字段");
  eq(await c("HLEN", "h1"), 1, "HDEL 后 HLEN=1");
  const hgetall = await c("HGETALL", "h1"); eq(hgetall, ["f2", "v2"], "HGETALL 扁平数组");
  // 空 hash 自动删除
  await c("HSET", "hempty", "x", "1"); await c("HDEL", "hempty", "x");
  eq(await c("EXISTS", "hempty"), 0, "空 hash 自动删键");

  // set
  eq(await c("SADD", "s1", "a", "b", "a"), 2, "SADD 去重后新增 2");
  eq(await c("SCARD", "s1"), 2, "SCARD=2");
  eq(await c("SISMEMBER", "s1", "a"), 1, "SISMEMBER 命中=1");
  eq(await c("SISMEMBER", "s1", "z"), 0, "SISMEMBER 未命中=0");
  const sm = await c("SMEMBERS", "s1"); ok(sm.includes("a") && sm.includes("b"), "SMEMBERS 返回集合");
  eq(await c("SREM", "s1", "a"), 1, "SREM 删 1");
  eq(await c("SREM", "s1", "a"), 0, "SREM 再删=0");
  await c("SADD", "sempty", "x"); await c("SREM", "sempty", "x");
  eq(await c("EXISTS", "sempty"), 0, "空 set 自动删键");

  // list
  eq(await c("RPUSH", "l1", "x", "y"), 2, "RPUSH 长度=2");
  eq(await c("LPUSH", "l1", "w"), 3, "LPUSH 长度=3");
  eq(await c("LRANGE", "l1", "0", "-1"), ["w", "x", "y"], "LRANGE 全量");
  eq(await c("LLEN", "l1"), 3, "LLEN=3");
  eq(await c("LPOP", "l1"), "w", "LPOP 头部");
  await c("LTRIM", "l1", "0", "0");
  eq(await c("LRANGE", "l1", "0", "-1"), ["x"], "LTRIM 后仅剩首元素");

  // MGET
  await c("SET", "m1", "A"); await c("SET", "m2", "B");
  eq(await c("MGET", "m1", "m2", "m3"), ["A", "B", null], "MGET 含缺失键=null");

  // SCAN（前缀）
  await c("SET", "zp:a", "1"); await c("SET", "zp:b", "2"); await c("SET", "other", "3");
  const scan = await c("SCAN", "0", "MATCH", "zp:*", "COUNT", "100");
  eq(scan[0], "0", "SCAN 游标归零");
  ok(scan[1].includes("zp:a") && scan[1].includes("zp:b") && !scan[1].includes("other"), "SCAN 前缀过滤正确");

  // HSCAN
  await c("HSET", "hscan1", "ka", "va", "kb", "vb");
  const hs = await c("HSCAN", "hscan1", "0");
  eq(hs[0], "0", "HSCAN 游标归零");
  ok(hs[1].includes("ka") && hs[1].includes("kb"), "HSCAN 返回全部字段");
}

// ============ 2) 事务原子性 + TTL 过期 ============
async function testTxAndTtl() {
  console.log("\n[2] 事务原子性 + TTL 过期");
  const { raw, backend } = makeEngine();
  const res = await backend.pipeline([["SET", "pk", "v"], ["INCR", "pc"], ["HSET", "ph", "f", "x"]]);
  eq(res, ["OK", 1, 1], "pipeline 逐条结果");
  eq(await backend.command(["GET", "pk"]), "v", "pipeline 后取值");
  raw.exec("INSERT INTO kv(key,value,type,expires_at) VALUES('expired','x','string',1)");
  eq(await backend.command(["GET", "expired"]), null, "过期键 GET 为 null");
  const cnt = raw.prepare("SELECT count(*) c FROM kv WHERE key='expired'").get().c;
  eq(cnt, 0, "过期键已被清理");
}

// ============ 3) + 4) 注册表覆盖 + EVAL 冒烟 ============
let allScripts = [];
function collectScripts() {
  const files = walkScripts(API);
  const seen = new Set();
  for (const f of files) {
    for (const text of extractScripts(readFileSync(f, "utf8"))) {
      const norm = normalizeLua(text);
      if (!seen.has(norm)) { seen.add(norm); allScripts.push(text); }
    }
  }
}
function testRegistryCoverage() {
  console.log("\n[3] 注册表静态覆盖（源码 EVAL 脚本是否全部命中）");
  const distinct = [...new Set(allScripts.map(normalizeLua))];
  let miss = 0;
  for (const norm of distinct) {
    if (!lookupEval(norm)) { miss++; console.error("  ✗ 未注册：" + norm.slice(0, 80)); }
  }
  ok(miss === 0, `全部 ${distinct.length} 个去重 EVAL 脚本均已在注册表命中（缺失 ${miss}）`);
  console.log(`  ℹ 去重脚本数：${distinct.length}`);
}
async function testEvalSmoke() {
  console.log("\n[4] EVAL 冒烟（全部脚本在引擎内可路由）");
  const { backend } = makeEngine();
  const distinct = [...new Set(allScripts.map(normalizeLua))];
  let miss = 0;
  for (const text of allScripts) {
    const keys = Array.from({ length: 12 }, (_, i) => "zp:smoke:" + i);
    const args = Array.from({ length: 12 }, (_, i) => "a" + i);
    try {
      await backend.command(["EVAL", text, "12", ...keys, ...args]);
    } catch (e) {
      if (e.code === "UNIMPLEMENTED_EVAL" || e.message === "UNIMPLEMENTED_EVAL") {
        miss++; console.error("  ✗ UNIMPLEMENTED：" + normalizeLua(text).slice(0, 80));
      }
      // 其他异常（缺前置条件导致 handler 返回错误码或抛逻辑错误）属预期，忽略
    }
  }
  ok(miss === 0, `冒烟通过：全部脚本均找到处理器（未实现 ${miss}）`);
}

// ============ 5) 行为：锁释放 CAS + learnGlobal 版本自增 ============
async function testEvalBehavior() {
  console.log("\n[5] 行为：分布式锁释放（CAS-DEL）+ learnGlobal 版本自增");
  const { backend } = makeEngine();

  const CAS = 'if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end';
  await backend.command(["SET", "zp:lock:1", "tokA"]);
  eq(await backend.command(["EVAL", CAS, "1", "zp:lock:1", "tokA"]), 1, "CAS 匹配 token → 删除返回 1");
  eq(await backend.command(["GET", "zp:lock:1"]), null, "CAS 删除后键不存在");
  await backend.command(["SET", "zp:lock:2", "tokB"]);
  eq(await backend.command(["EVAL", CAS, "1", "zp:lock:2", "wrong"]), 0, "CAS token 不符 → 返回 0");
  eq(await backend.command(["GET", "zp:lock:2"]), "tokB", "CAS 失败保留原键");

  const LEARN = 'local v=tonumber(redis.call("INCR",KEYS[2])) or 0; redis.call("HSET",KEYS[1],ARGV[1],ARGV[2]); redis.call("RPUSH",KEYS[3],ARGV[3]); redis.call("LTRIM",KEYS[3],"-5000","-1"); redis.call("SET",KEYS[4],cjson.encode({schemaVersion="2",version=v})); return v';
  const recKey = "zp:records", verKey = "zp:meta:version", evtKey = "zp:events", metaKey = "zp:meta";
  const v1 = await backend.command(["EVAL", LEARN, "4", recKey, verKey, evtKey, metaKey, "storeX", JSON.stringify({ ok: 1 }), JSON.stringify({ e: 1 })]);
  eq(v1, 1, "learnGlobal 首次 version=1");
  const v2 = await backend.command(["EVAL", LEARN, "4", recKey, verKey, evtKey, metaKey, "storeX", JSON.stringify({ ok: 2 }), JSON.stringify({ e: 2 })]);
  eq(v2, 2, "learnGlobal 二次 version=2");
  eq(await backend.command(["HGET", recKey, "storeX"]), JSON.stringify({ ok: 2 }), "learnGlobal HSET 写入/覆盖 record");
  const events = await backend.command(["LRANGE", evtKey, "0", "-1"]);
  eq(events, [JSON.stringify({ e: 1 }), JSON.stringify({ e: 2 })], "learnGlobal RPUSH 追加事件");
}

// ============ 6) delete_route 行为 + 409 回归（EVAL #47） ============
// 关键回归防护：旧实现 ARGV 下标整体错位 1 → 恒 return 5 → 上游 409；
// 新固定模板修好 409，但写入循环起始下标若写成 k=3+i（而非 4+i）会把 baseKey 当作用户键写入、
// 所有绑定用户的「解绑 JSON」整体错位一位，导致用户账号被下一个用户的完整 JSON 覆盖（数据损坏）。
// 本测试实证该回归已被修复。脚本文本直接从注册表提取（与 routes.js 实际调用同源，归一化必匹配）。
function registryScript(pred) {
  for (const k of HANDLERS.keys()) if (pred(k)) return k;
  throw new Error("注册表未找到匹配脚本");
}
const DELETE_ROUTE = registryScript((k) => k.includes("boundCount") && k.includes("return 5"));
async function testDeleteRoute() {
  console.log("\n[6] delete_route 行为 + 409 回归（EVAL #47）");
  const { backend, raw } = makeEngine();
  const c = (...p) => backend.command(p);
  const q = (k) => raw.prepare("SELECT value FROM kv WHERE key=?").get(k);
  const jget = (k) => { const r = q(k); return r ? JSON.parse(r.value) : null; };

  // —— 场景 A：带 driver(U1) + delivery(U2) 的线路删除 ——
  await c("SET", "zp:route:R1", JSON.stringify({ id: "R1", driverUserId: "U1", deliveryUserId: "U2" }));
  await c("SET", "zp:routes:index", JSON.stringify(["R1"]));
  await c("SET", "zp:route:R1:base", JSON.stringify({ routeId: "R1", version: 1 }));
  await c("SET", "zp:user:U1", JSON.stringify({ id: "U1", username: "u1", boundRouteId: "R1", routeDuty: "driver", passwordHash: "h1", sessionVersion: 1 }));
  await c("SET", "zp:user:U2", JSON.stringify({ id: "U2", username: "u2", boundRouteId: "R1", routeDuty: "delivery", passwordHash: "h2", sessionVersion: 1 }));

  const keys = ["zp:route:R1", "zp:routes:index", "zp:route:R1:base", "zp:user:U1", "zp:user:U2"];
  const args = [
    "R1", JSON.stringify([]), "U1", "U2", "driver", "delivery",
    JSON.stringify({ id: "U1", username: "u1", boundRouteId: null, routeDuty: null, passwordHash: "h1", sessionVersion: 2 }),
    JSON.stringify({ id: "U2", username: "u2", boundRouteId: null, routeDuty: null, passwordHash: "h2", sessionVersion: 2 }),
  ];
  eq(await backend.command(["EVAL", DELETE_ROUTE, String(keys.length), ...keys, ...args]), 1, "delete_route 带绑定用户返回 1");
  const u1 = jget("zp:user:U1"), u2 = jget("zp:user:U2");
  ok(u1 && u1.id === "U1" && u1.boundRouteId === null && u1.routeDuty === null && u1.sessionVersion === 2 && u1.passwordHash === "h1", "U1 解绑正确（未被错位写成他人）");
  ok(u2 && u2.id === "U2" && u2.boundRouteId === null && u2.routeDuty === null && u2.sessionVersion === 2 && u2.passwordHash === "h2", "U2 解绑正确（未被漏写）");
  eq(await c("GET", "zp:route:R1"), null, "线路主记录已删");
  eq(await c("GET", "zp:route:R1:base"), null, "线路 base 已删");
  eq(jget("zp:routes:index"), [], "route 索引已剔除本线路");

  // —— 场景 B：绑定不一致（duty 不匹配）→ 应 return 5（上游转 409），且用户数据不被破坏 ——
  await c("SET", "zp:route:R2", JSON.stringify({ id: "R2", driverUserId: "U3", deliveryUserId: "U4" }));
  await c("SET", "zp:routes:index", JSON.stringify(["R2"]));
  await c("SET", "zp:user:U3", JSON.stringify({ id: "U3", boundRouteId: "R2", routeDuty: "driver", passwordHash: "h3", sessionVersion: 1 }));
  await c("SET", "zp:user:U4", JSON.stringify({ id: "U4", boundRouteId: "R2", routeDuty: "delivery", passwordHash: "h4", sessionVersion: 1 }));
  const keys2 = ["zp:route:R2", "zp:routes:index", "zp:route:R2:base", "zp:user:U3", "zp:user:U4"];
  // 故意把 U4 的 duty 传成 driver（与存储的 delivery 不符），触发 return 5
  const args2 = [
    "R2", JSON.stringify([]), "U3", "U4", "driver", "driver",
    JSON.stringify({ id: "U3", boundRouteId: null, routeDuty: null, passwordHash: "h3", sessionVersion: 2 }),
    JSON.stringify({ id: "U4", boundRouteId: null, routeDuty: null, passwordHash: "h4", sessionVersion: 2 }),
  ];
  eq(await backend.command(["EVAL", DELETE_ROUTE, String(keys2.length), ...keys2, ...args2]), 5, "绑定不一致 → return 5（上游 409）");
  const u3 = jget("zp:user:U3");
  ok(u3 && u3.id === "U3" && u3.boundRouteId === "R2" && u3.routeDuty === "driver", "return 5 时用户数据未被破坏（仍绑定 R2）");
  eq(await c("GET", "zp:route:R2"), JSON.stringify({ id: "R2", driverUserId: "U3", deliveryUserId: "U4" }), "return 5 时线路主记录保留");
}

// ============ 7) 性能遥测聚合（EVAL #53：HINCRBY / HINCRBYFLOAT / phase） ============
const PERF = registryScript((k) => k.includes("HINCRBYFLOAT"));
async function testPerfAggregation() {
  console.log("\n[7] 性能遥测聚合（EVAL #53：HINCRBY/HINCRBYFLOAT/phase）");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);
  const hk = "zp:perf:hour:20261027T08";
  const rk = "zp:perf:ingest-rate:20261027T08";
  const evt = (over = {}) => {
    const e = { page: "home", endpoint: "page-load", status: "2xx", duration: "100", server: "50", hasServer: "1", phases: JSON.stringify({ "history-auth": 20 }), code: "" };
    return Object.assign(e, over);
  };
  const ev1 = evt();
  eq(await backend.command(["EVAL", PERF, "2", hk, rk, ...Object.values(ev1)]), 1, "perf 首报返回 1");
  const base = "home|page-load|2xx|";
  eq(await c("HGET", hk, base + "count"), "1", "count=1");
  eq(await c("HGET", hk, base + "sum"), "100", "sum=100（HINCRBYFLOAT）");
  eq(await c("HGET", hk, base + "max"), "100", "max=100");
  eq(await c("HGET", hk, base + "server_count"), "1", "server_count=1");
  eq(await c("HGET", hk, base + "server_sum"), "50", "server_sum=50");
  eq(await c("HGET", hk, base + "server_max"), "50", "server_max=50");
  eq(await c("HGET", hk, base + "phase:history-auth:count"), "1", "phase count=1");
  eq(await c("HGET", hk, base + "phase:history-auth:sum"), "20", "phase sum=20");
  eq(await c("HGET", hk, base + "phase:history-auth:max"), "20", "phase max=20");
  const ttl = await c("TTL", hk); ok(ttl > 1209600 - 5, "遥测键 TTL≈14天（得到 " + ttl + "）");
  // 第二次相同上报：count=2, sum=200, max 保持 100
  const ev2 = evt();
  eq(await backend.command(["EVAL", PERF, "2", hk, rk, ...Object.values(ev2)]), 1, "perf 二次上报返回 1");
  eq(await c("HGET", hk, base + "count"), "2", "count=2（累加）");
  eq(await c("HGET", hk, base + "sum"), "200", "sum=200（累加）");
  eq(await c("HGET", hk, base + "max"), "100", "max 不回退（100 不>100）");
  // 4xx 带 code 细分（注意 base 随 status 变化）
  const ev3 = evt({ status: "4xx", code: "409", duration: "30" });
  eq(await backend.command(["EVAL", PERF, "2", hk, rk, ...Object.values(ev3)]), 1, "perf 4xx 带 code 返回 1");
  const base4 = "home|page-load|4xx|";
  eq(await c("HGET", hk, base4 + "code:409|count"), "1", "4xx code 细分 count=1");
  eq(await c("HGET", hk, base4 + "code:409|sum"), "30", "4xx code 细分 sum=30");
}

// ============ 8) pipeline 事务回滚 ============
async function testPipelineRollback() {
  console.log("\n[8] pipeline 事务回滚（含非法命令 → 整体回滚）");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);
  await c("SET", "rb:1", "before");
  let threw = false;
  try {
    await backend.pipeline([
      ["SET", "rb:2", "should-not-persist"],
      ["NOT_A_REDIS_COMMAND", "x"],
      ["SET", "rb:3", "also-not"],
    ]);
  } catch (e) { threw = true; }
  ok(threw, "含非法命令的 pipeline 应抛错（D1_UNSUPPORTED_COMMAND）");
  eq(await c("GET", "rb:1"), "before", "回滚不影响事务外已提交的键");
  eq(await c("GET", "rb:2"), null, "回滚：pipeline 首个写未持久化");
  eq(await c("GET", "rb:3"), null, "回滚：pipeline 后续写未持久化");
}

// ============ 9) 并发事务串行化（排队不锁死） ============
async function testConcurrency() {
  console.log("\n[9] 并发事务串行化（D1 写锁串行化；node:sqlite 单连接需显式排队）");
  const { raw, backend } = makeEngine();
  // 真实 D1 服务端用 SQLite 写锁串行化所有写事务；node:sqlite 单连接无法原生并发开事务，
  // 故在适配器层用互斥链串行化 command/pipeline，模拟真实 D1 并发语义（写被排队而非锁死）。
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const c = (...p) => serial(() => backend.command(p));
  // 两个互不相干的事务同时发起，验证被串行化后都成功、不锁死、不丢写
  const [r1, r2] = await Promise.all([c("SET", "cc:1", "a"), c("SET", "cc:2", "b")]);
  eq(r1, "OK", "并发事务1提交成功");
  eq(r2, "OK", "并发事务2提交成功");
  eq(await c("GET", "cc:1"), "a", "并发写1持久化");
  eq(await c("GET", "cc:2"), "b", "并发写2持久化");
  // 并发读 + 写混合
  const [w, reads] = await Promise.all([
    c("INCR", "cc:counter"),
    Promise.all([c("GET", "cc:1"), c("GET", "cc:2")]),
  ]);
  eq(w, 1, "并发 INCR 成功");
  eq(reads, ["a", "b"], "并发读返回一致快照");
}

// ============ 10) 软删除依赖命令：RENAME / TYPE / PING（D1 移植缺口补齐回归） ============
// 历史回收站（_history-delete.js 软删除 / history-trash.js 恢复）用 RENAME 迁移子键，
// redis-diag.js 用 PING/TYPE。三者原不在 D1 命令面，上线 D1 会抛 D1_UNSUPPORTED_COMMAND。
async function testRenameTypePing() {
  console.log("\n[10] 软删除依赖命令：RENAME / TYPE / PING");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);

  eq(await c("PING"), "PONG", "PING 返回 PONG");

  // TYPE：四种类型 + 不存在
  await c("SET", "ty:s", "x");
  await c("HSET", "ty:h", "f", "v");
  await c("SADD", "ty:se", "m");
  await c("RPUSH", "ty:l", "e");
  eq(await c("TYPE", "ty:s"), "string", "TYPE string");
  eq(await c("TYPE", "ty:h"), "hash", "TYPE hash");
  eq(await c("TYPE", "ty:se"), "set", "TYPE set");
  eq(await c("TYPE", "ty:l"), "list", "TYPE list");
  eq(await c("TYPE", "ty:missing"), "none", "TYPE 不存在=none");

  // RENAME：基础移动
  await c("SET", "rn:src", "hello");
  eq(await c("RENAME", "rn:src", "rn:dst"), 1, "RENAME 存在→1");
  eq(await c("GET", "rn:src"), null, "RENAME 后源键消失");
  eq(await c("GET", "rn:dst"), "hello", "RENAME 后目标键持有原值");

  // RENAME：源不存在 → 0
  eq(await c("RENAME", "rn:nosuch", "rn:any"), 0, "RENAME 源不存在→0");

  // RENAME：覆盖式移动（目标已存在被覆盖，Redis 语义）
  await c("SET", "rn:s2", "new-value");
  await c("SET", "rn:d2", "old-value");
  eq(await c("RENAME", "rn:s2", "rn:d2"), 1, "RENAME 覆盖目标→1");
  eq(await c("GET", "rn:d2"), "new-value", "RENAME 覆盖后目标为新值");
  eq(await c("EXISTS", "rn:s2"), 0, "覆盖后源键消失");

  // RENAME：TTL 随源走
  await c("SET", "rn:s3", "ttl-val", "EX", "500");
  await c("RENAME", "rn:s3", "rn:d3");
  const ttl = await c("TTL", "rn:d3"); ok(ttl > 490 && ttl <= 500, "RENAME 后 TTL 随源（得到 " + ttl + "）");

  // RENAME：hash 类型迁移后结构不变（软删除子键迁移的核心场景）
  await c("HSET", "rn:hs", "fieldA", "va");
  await c("RENAME", "rn:hs", "rn:hd");
  eq(await c("TYPE", "rn:hd"), "hash", "RENAME 后类型保持 hash");
  eq(await c("HGET", "rn:hd", "fieldA"), "va", "RENAME 后 hash 字段可读");
  // RENAME：list 类型同理
  await c("RPUSH", "rn:ls", "e1", "e2");
  await c("RENAME", "rn:ls", "rn:ld");
  eq(await c("LRANGE", "rn:ld", "0", "-1"), ["e1", "e2"], "RENAME 后 list 元素保持");
}

// ============ 11) 补充分支覆盖：DECR/DECRBY、EXPIRE miss、UNIMPLEMENTED_EVAL、perf 限流分支 ============
async function testExtraBranches() {
  console.log("\n[11] 补充分支（DECR/DECRBY、EXPIRE miss、UNIMPLEMENTED_EVAL、perf 限流）");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);

  // DECR / DECRBY（incrby 负向分支）
  eq(await c("DECR", "dc:a"), -1, "DECR 初值=-1");
  eq(await c("DECR", "dc:a"), -2, "DECR 再减=-2");
  eq(await c("DECRBY", "dc:b", 5), -5, "DECRBY 新键=-5");
  await c("SET", "dc:c", "10");
  eq(await c("DECRBY", "dc:c", 3), 7, "DECRBY 已有值 10-3=7");

  // EXPIRE 不存在键 → 0（expire miss 分支）
  eq(await c("EXPIRE", "dc:missing", "60"), 0, "EXPIRE 不存在键返回 0");

  // 有效已落库键的 EXPIRE 必须只消耗一次 D1 batch（旧路径为 SELECT + batch）。
  {
    const { raw, backend: fast, metrics } = makeEngine();
    await fast.command(["SET", "session-fast", "value", "EX", "100"]);
    metrics.prepare = 0; metrics.batch = 0;
    eq(await fast.command(["EXPIRE", "session-fast", "7776000"]), 1, "EXPIRE 有效会话返回 1");
    eq(fast.quota.statements + fast.quota.batches, 1, "EXPIRE 单次 D1 查询配额 = 1");
    eq(metrics.batch, 1, "EXPIRE 仅执行一个 D1 batch");
    eq(metrics.prepare, 2, "EXPIRE batch 内仅 DELETE + UPDATE 两条语句");
    const ttl = await fast.command(["TTL", "session-fast"]);
    ok(ttl > 7775990 && ttl <= 7776000, "EXPIRE TTL 续期到 90 天（得到 " + ttl + "）");
    raw.exec("INSERT INTO kv(key,value,type,expires_at) VALUES('session-expired','x','string',1)");
    eq(await fast.command(["EXPIRE", "session-expired", "60"]), 0, "EXPIRE 不复活已过期键");
    eq(raw.prepare("SELECT count(*) c FROM kv WHERE key='session-expired'").get().c, 0, "EXPIRE 顺手清理已过期键");
    const pending = await fast.pipeline([["SET", "pending-expire", "v"], ["EXPIRE", "pending-expire", "60"]]);
    eq(pending, ["OK", 1], "pipeline 内先 SET 后 EXPIRE 保持 overlay 语义");
    ok((await fast.command(["TTL", "pending-expire"])) > 0, "pipeline 内 EXPIRE TTL 生效");
  }

  // 未注册 EVAL → UNIMPLEMENTED_EVAL（含归一化脚本摘要，供补表定位）
  let unimpl = null;
  try { await c("EVAL", 'return redis.call("GET","no-such-script-for-registry")', "1", "k"); }
  catch (e) { unimpl = e; }
  ok(unimpl && (unimpl.code === "UNIMPLEMENTED_EVAL" || unimpl.message === "UNIMPLEMENTED_EVAL"), "未注册 EVAL 抛 UNIMPLEMENTED_EVAL");
  ok(unimpl && typeof unimpl.script === "string" && unimpl.script.length > 0, "错误携带归一化脚本摘要（err.script）");

  // perf #53 限流分支：rateKey 预置 3001 → INCR 后 3002 > 3000 → 返回 -1（不写聚合）
  const hk = "zp:perf:hour:LIMIT", rk = "zp:perf:ingest-rate:LIMIT";
  await c("SET", rk, "3001");
  const ev = ["home", "page-load", "2xx", "100", "50", "1", "", ""];
  eq(await c("EVAL", registryScript((k) => k.includes("HINCRBYFLOAT")), "2", hk, rk, ...ev), -1, "rate>3000 → 返回 -1（限流）");
  eq(await c("EXISTS", hk), 0, "限流时聚合 hash 未写入");

  // perf #53 分支：hasServer=0 → 无 server_* 字段；非法 phase 名 → 不写 phase 字段
  const hk2 = "zp:perf:hour:B2", rk2 = "zp:perf:ingest-rate:B2";
  const ev2 = ["home", "page-load", "2xx", "80", "0", "0", JSON.stringify({ "history-UPPER": 50, "other": 1 }), ""];
  eq(await c("EVAL", registryScript((k) => k.includes("HINCRBYFLOAT")), "2", hk2, rk2, ...ev2), 1, "perf 正常上报返回 1");
  eq(await c("HGET", hk2, "home|page-load|2xx|count"), "1", "主 count 写入");
  eq(await c("HGET", hk2, "home|page-load|2xx|server_count"), null, "hasServer=0 不写 server_count");
  eq(await c("HGET", hk2, "home|page-load|2xx|phase:history-UPPER:count"), null, "非法 phase 名（大写）不写 phase 字段");
  eq(await c("HGET", hk2, "home|page-load|2xx|phase:other:count"), null, "非 history-* phase 名不写 phase 字段");
}

// ============ 12) D1 运行时硬限制适配（线上 2026-10-27 实战教训） ============
// D1：查询/调用配额 50（免费）、LIKE 模式 ≤50 字节、单查询绑定参数 ≤100；
// node:sqlite 均无此限制，离线测试必须显式覆盖这三个场景防回归。
async function testD1Limits() {
  console.log("\n[12] D1 运行时硬限制适配（长前缀 SCAN / >90 键 MGET / pipeline 同类读分组）");
  const { backend } = makeEngine();
  const c = (...p) => backend.command(p);
  // 长前缀（58 字节，超 LIKE 50B 上限）下的 SCAN：历史索引真实场景
  const routeId = "route_" + "a".repeat(8) + "d8f845e78221628bac1a6630";
  const prefix = "zp:route:" + routeId + ":waybills:";
  ok(prefix.length > 50, "前置确认：前缀长度 " + prefix.length + " 字节确超 D1 LIKE 上限（构造有效）");
  for (const d of ["2026-10-21", "2026-10-25", "2026-10-27"]) {
    await c("SADD", prefix + d, "w1", "w2");
    await c("SET", prefix + d + ":meta", "{}");
  }
  await c("SADD", "zp:route:other:waybills:2026-10-27", "w9"); // 不应被误捞
  const [cur1, keys1] = await c("SCAN", "0", "MATCH", prefix + "*", "COUNT", "500");
  eq(cur1, "0", "长前缀 SCAN 单页扫完游标归零");
  eq(keys1.length, 6, "长前缀 SCAN 命中 6 键（3 索引 + 3 meta），不串其他线路");
  ok(keys1.every((k) => k.startsWith(prefix)), "长前缀 SCAN 结果全部匹配前缀");
  // 游标分页
  const [cur2, page1] = await c("SCAN", "0", "MATCH", prefix + "*", "COUNT", "2");
  const [cur3, page2] = await c("SCAN", cur2, "MATCH", prefix + "*", "COUNT", "2");
  ok(page1.length === 2 && page2.length >= 1, "长前缀 SCAN 分页返回（2+2）");
  // >90 键 MGET 分块（D1 单查询绑定参数 ≤100）
  const manyKeys = [];
  for (let i = 0; i < 120; i++) { const k = "zp:bulk:" + String(i).padStart(3, "0"); manyKeys.push(k); await c("SET", k, "v" + i); }
  const mv = await c("MGET", ...manyKeys);
  eq(mv.length, 120, "MGET 120 键返回 120 结果");
  eq(mv[0], "v0", "MGET 分块首值正确");
  eq(mv[119], "v119", "MGET 分块尾值正确");
  // 中间夹缺失键 + 分块边界（第 91 个键跨块）：结果与输入同序、缺失为 null
  const mixed = [...manyKeys.slice(0, 90), "zp:bulk:missing", manyKeys[90]];
  const mmv = await c("MGET", ...mixed);
  eq(mmv.length, 92, "MGET 混合缺失键返回同序等长结果");
  eq(mmv[89], "v89", "MGET 块边界前正确");
  eq(mmv[90], null, "MGET 缺失键为 null");
  eq(mmv[91], "v90", "MGET 块边界后正确");
  // pipeline 同类读分组（SMEMBERS ×3 连续段 → 1 次 batch，结果逐条正确）
  const s1 = "zp:pl:set1", s2 = "zp:pl:set2", s3 = "zp:pl:set3";
  await c("SADD", s1, "a", "b");
  await c("SADD", s2, "c");
  const pr = await backend.pipeline([
    ["SMEMBERS", s1],
    ["SMEMBERS", s2],
    ["SMEMBERS", s3],
    ["GET", "zp:bulk:000"],
    ["SMEMBERS", s1],
  ]);
  eq(pr[0].length, 2, "pipeline 分组 SMEMBERS[0] 两个成员");
  eq(pr[1], ["c"], "pipeline 分组 SMEMBERS[1] 一个成员");
  eq(pr[2], [], "pipeline 分组 SMEMBERS[2] 空集");
  eq(pr[3], "v0", "pipeline 混入 GET 正常");
  eq(pr[4].length, 2, "pipeline 分组后再次 SMEMBERS 正常");
  // 分组读与 overlay 写混用：段前有缓冲写时不得误读旧值
  const pr2 = await backend.pipeline([
    ["SET", "zp:pl:mix", "newv"],
    ["GET", "zp:pl:mix"],
    ["GET", "zp:bulk:001"],
  ]);
  eq(pr2[0], "OK", "pipeline 写成功");
  eq(pr2[1], "newv", "同 pipeline 内先写后读读到新值（overlay）");
  eq(pr2[2], "v1", "pipeline 混合读写其余键正常");
  eq(await c("GET", "zp:pl:mix"), "newv", "pipeline 写已落库");
  // HGETALL / TYPE / TTL 分组
  await c("HSET", "zp:pl:h", "f", "1");
  const pr3 = await backend.pipeline([["HGETALL", "zp:pl:h"], ["TYPE", "zp:pl:h"], ["TYPE", "zp:pl:none"]]);
  eq(pr3[0], ["f", "1"], "pipeline 分组 HGETALL");
  eq(pr3[1], "hash", "pipeline 分组 TYPE");
  eq(pr3[2], "none", "pipeline 分组 TYPE 不存在键");
}

// ============ AUTH_READ 单 D1 batch 优化 ============
async function testAuthReadFastPath() {
  console.log("\\n[AUTH_READ] session + user 合并为一次 D1 batch");
  const { raw, backend, metrics } = makeEngine();
  const authSource = readFileSync(path.join(API, "_auth.js"), "utf8");
  const authScript = extractScripts(authSource).find(s => /local session = redis.call/.test(s));
  ok(!!authScript, "从 _auth.js 提取真实 AUTH_READ Lua 脚本");
  if (!authScript) return;

  const session = JSON.stringify({ userId: "U-AUTH", sessionVersion: 1 });
  const user = JSON.stringify({ id: "U-AUTH", username: "auth-user", sessionVersion: 1 });
  await backend.command(["SET", "zp:session:auth-fast", session]);
  await backend.command(["SET", "zp:user:U-AUTH", user]);
  metrics.prepare = 0; metrics.batch = 0;
  const pair = await backend.command(["EVAL", authScript, "1", "zp:session:auth-fast", "zp:user:"]);
  eq(pair, [session, user], "AUTH_READ 返回 session + user 原始值");
  eq(backend.quota.statements + backend.quota.batches, 1, "AUTH_READ D1 配额消耗仅 1 次");
  eq(metrics.batch, 1, "AUTH_READ 使用单次 D1 batch");
  eq(metrics.prepare, 2, "AUTH_READ batch 内为过期清理 + JOIN 查询");

  const missing = await backend.command(["EVAL", authScript, "1", "zp:session:missing", "zp:user:"]);
  eq(missing, [null, null], "AUTH_READ 缺失 session 返回空对");

  await backend.command(["SET", "zp:session:auth-bad", "{"]);
  const malformed = await backend.command(["EVAL", authScript, "1", "zp:session:auth-bad", "zp:user:"]);
  eq(malformed, ["{", null], "AUTH_READ 损坏 session 保留原值但不返回 user");

  const noUserSession = JSON.stringify({ userId: "U-NOT-FOUND", sessionVersion: 1 });
  await backend.command(["SET", "zp:session:auth-no-user", noUserSession]);
  const noUser = await backend.command(["EVAL", authScript, "1", "zp:session:auth-no-user", "zp:user:"]);
  eq(noUser, [noUserSession, null], "AUTH_READ 缺失 user 返回 session + null");

  raw.exec("INSERT INTO kv(key,value,type,expires_at) VALUES('zp:session:auth-expired','x','string',1)");
  const expired = await backend.command(["EVAL", authScript, "1", "zp:session:auth-expired", "zp:user:"]);
  eq(expired, [null, null], "AUTH_READ 过期 session 不复活");
  eq(raw.prepare("SELECT count(*) c FROM kv WHERE key='zp:session:auth-expired'").get().c, 0, "AUTH_READ 清理过期 session");

  const pendingSession = JSON.stringify({ userId: "U-PENDING", sessionVersion: 1 });
  const pendingUser = JSON.stringify({ id: "U-PENDING", sessionVersion: 1 });
  const pipeline = await backend.pipeline([
    ["SET", "zp:session:auth-pending", pendingSession],
    ["SET", "zp:user:U-PENDING", pendingUser],
    ["EVAL", authScript, "1", "zp:session:auth-pending", "zp:user:"],
  ]);
  eq(pipeline[2], [pendingSession, pendingUser], "pipeline 内 overlay session/user 仍可被 AUTH_READ 读取");
}


async function testRequestScopedSessionEnv() {
  const sessions = [];
  const db = {
    withSession(constraint) {
      const session = { constraint, id: sessions.length + 1 };
      sessions.push(session);
      return session;
    },
  };
  const cachedBackend = { shared: true };
  const original = { DB: db, __zpD1: cachedBackend, API_TOKEN: "kept" };
  const scoped = createD1SessionEnv(original);
  ok(scoped !== original, "D1 Session 使用独立 env，不修改共享 env");
  eq(scoped.DB, sessions[0], "独立 env 使用本次请求创建的 D1 Session");
  eq(scoped.DB.constraint, "first-primary", "默认从主库启动 Session");
  eq(scoped.__zpD1, undefined, "不复用原 env 上的 D1Backend 缓存");
  eq(scoped.API_TOKEN, "kept", "复制其余环境绑定");
  eq(original.DB, db, "原始 D1 binding 保持不变");
  eq(original.__zpD1, cachedBackend, "原始 D1Backend 缓存保持不变");

  const second = createD1SessionEnv(original);
  ok(second.DB !== scoped.DB && sessions.length === 2, "不同请求获得独立 Session");
  const fallback = { DB: { prepare() {} }, __zpD1: null };
  eq(createD1SessionEnv(fallback), fallback, "不支持 withSession 的环境原样回退");
  eq(createD1SessionEnv(null), null, "无环境时安全回退");
}

// ============ 主流程 ============
(async () => {
  console.log("=== D1 引擎离线测试 ===");
  collectScripts();
  await testCommandSurface();
  await testTxAndTtl();
  testRegistryCoverage();
  testEvalSmoke();
  await testEvalBehavior();
  await testDeleteRoute();
  await testPerfAggregation();
  await testPipelineRollback();
  await testConcurrency();
  await testRenameTypePing();
  await testExtraBranches();
  await testAuthReadFastPath();
  await testRequestScopedSessionEnv();
  await testD1Limits();

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  if (fail > 0) {
    console.error("失败明细：\n - " + fails.join("\n - "));
    process.exit(1);
  } else {
    console.log("✅ 全部通过");
  }
})();
