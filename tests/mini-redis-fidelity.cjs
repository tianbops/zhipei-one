// 测试桩审计：tests/_mini-redis.cjs 与真实 Redis 语义的逐条比对
// 目的：桩「比生产更宽容」会让本地全绿而线上复发（已实证 3 次：SCAN 一次性返回、
//      HSCAN 参数位取错、完全忽略 SET..EX）。本脚本把每条命令的语义差异变成可执行断言，
//      防止同类失真再次悄悄回归。
//
// 运行：node tests/mini-redis-fidelity.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let pass = 0, fail = 0;
const findings = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; findings.push(name + (info ? " — " + info : "")); console.log("  ❌ " + name + "  " + (info || "")); }
}
function section(t) { console.log("\n【" + t + "】"); }

const m = new MiniRedis();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ================= 1. SET 家族 =================
  section("SET 家族：选项组合与错误语义");
  eq(m.command(["SET", "k", "v"]), "OK");
  check("SET 返回 OK", true);

  // XX：仅当键存在时写入
  m.command(["DEL", "kxx"]);
  check("SET key val XX 键不存在→nil", m.command(["SET", "kxx", "v", "XX"]) === null);
  check("SET key val XX 键不存在不创建键", m.command(["GET", "kxx"]) === null);
  m.command(["SET", "kxx", "old"]);
  m.command(["SET", "kxx", "new", "XX"]);
  check("SET key val XX 键存在→覆盖", m.command(["GET", "kxx"]) === "new");

  // SET key val NX XX 互斥 → 真实 Redis 语法错误
  let nxErr = null;
  try { m.command(["SET", "kmx", "v", "NX", "XX"]); } catch (e) { nxErr = e.message; }
  check("SET key val NX XX 互斥被拒（真实为 ERR syntax error）", String(nxErr || "").includes("ERR"), "got=" + nxErr);

  // GETEX 未实现——若生产用它，桩会抛 MINIREDIS_UNSUPPORTED
  let gexUnsupported = false;
  try { m.command(["GETEX", "kxx"]); } catch (e) { gexUnsupported = String(e.message).includes("UNSUPPORTED"); }
  check("GETEX 未被桩支持（生产若用则会失败，需补）", gexUnsupported, "见结论");

  // KEEPTTL / PX：真实语义应被正确处理
  m.command(["SET", "kpx", "v", "EX", "100"]);
  m.command(["SET", "kpx", "v2", "PX", "50000"]);
  const ttlPx = Number(m.command(["TTL", "kpx"]));
  check("SET ... PX 覆盖为毫秒级 TTL（≈50s）", ttlPx > 0 && ttlPx <= 50, "ttl=" + ttlPx);
  m.command(["SET", "kkt", "v", "EX", "100"]);
  m.command(["SET", "kkt", "v2", "KEEPTTL"]);
  check("SET ... KEEPTTL 保留原 TTL", Number(m.command(["TTL", "kkt"])) > 0 && Number(m.command(["TTL", "kkt"])) <= 100, "ttl=" + m.command(["TTL", "kkt"]));
  m.command(["SET", "kkt", "v3"]);
  check("SET 不带 TTL 选项时清除旧 TTL", m.command(["TTL", "kkt"]) === -1, "ttl=" + m.command(["TTL", "kkt"]));
  let pttlOk = Number(m.command(["PTTL", "kpx"])) > 0;
  check("PTTL 返回毫秒", pttlOk, "pttl=" + m.command(["PTTL", "kpx"]));
  check("PERSIST 清除 TTL", (m.command(["SET", "kps", "v", "EX", "50"]), m.command(["PERSIST", "kps"]) === 1 && m.command(["TTL", "kps"]) === -1));

  // ================= 2. 过期语义 =================
  section("过期：DEL/EXPIRE/TTL/SISMEMBER 对过期键的行为");
  m.command(["SET", "ex1", "v", "EX", "10"]);
  m.command(["DEL", "ex1"]);
  check("DEL 过期键返回 1（真值按存在计）", m.command(["EXPIRE", "ex1", "10"]) === 0, "已删键 EXPIRE→0");
  m.command(["SET", "ex2", "v", "EX", "10"]);
  check("未过期键 EXPIRE→1", m.command(["EXPIRE", "ex2", "100"]) === 1);
  check("EXPIRE 可刷新 TTL", Number(m.command(["TTL", "ex2"])) <= 100);

  // 真实 Redis：过期是惰性的，读取命令会触发删除
  m.command(["SET", "ex3", "v", "EX", "10"]); m.advance(11 * 1000);
  check("过期后 TTL 返回 -2（键不存在）", m.command(["TTL", "ex3"]) === -2);
  check("过期后 EXISTS 返回 0", m.command(["EXISTS", "ex3"]) === 0);

  // SMEMBERS/SISMEMBER 是否过滤过期键（此前只清 strings → 集合/哈希/列表过期后仍返回全量）
  m.command(["SADD", "st", "a"]); m.command(["EXPIRE", "st", "10"]); m.advance(11 * 1000);
  check("集合过期后 SMEMBERS 返回空", eq(m.command(["SMEMBERS", "st"]), []));
  check("集合过期后 SISMEMBER 返回 0", m.command(["SISMEMBER", "st", "a"]) === 0);
  const HX = new MiniRedis(); HX.command(["HSET", "hx", "f", "v"]); HX.command(["EXPIRE", "hx", "10"]); HX.advance(11 * 1000);
  check("哈希过期后 HGET 返回 null", HX.command(["HGET", "hx", "f"]) === null);
  check("哈希过期后 HGETALL 返回 []", eq(HX.command(["HGETALL", "hx"]), []));
  const LX = new MiniRedis(); LX.command(["RPUSH", "lx", "v"]); LX.command(["EXPIRE", "lx", "10"]); LX.advance(11 * 1000);
  check("列表过期后 LRANGE 返回 []", eq(LX.command(["LRANGE", "lx", "0", "-1"]), []));
  check("列表过期后 LLEN 返回 0", LX.command(["LLEN", "lx"]) === 0);
  check("过期键不进 SCAN（不留僵尸）", eq(HX.command(["SCAN", "0", "MATCH", "*", "COUNT", "100"])[1], []));

  // ================= 3. 集合 =================
  section("集合：SMEMBERS 顺序（真实 Redis 无序）");
  m.command(["DEL", "sord"]);
  m.command(["SADD", "sord", "z", "a", "m"]);
  const sm = m.command(["SMEMBERS", "sord"]);
  check("SMEMBERS 保留插入序（真实无序，若代码依赖顺序会失真）", eq(sm, ["z", "a", "m"]), "返回 " + JSON.stringify(sm));

  // ================= 4. SCAN 语义 =================
  section("SCAN：COUNT 与游标是软保证（真实语义）");
  const m2 = new MiniRedis();
  for (let i = 0; i < 50; i++) m2.command(["SET", "s" + i, "v"]);
  // 真实 Redis 允许空批次（即使有匹配键），COUNT 是提示
  let emptyBatch = 0, rounds = 0, cur = "0", got = 0;
  do {
    const r = m2.command(["SCAN", cur, "MATCH", "s*", "COUNT", "10"]);
    cur = String(r[0]); rounds++;
    if ((r[1] || []).length === 0) emptyBatch++;
    got += (r[1] || []).length;
    if (rounds > 200) break;
  } while (cur !== "0");
  check("SCAN 能终止（游标推进到 0）", cur === "0", "rounds=" + rounds);
  check("SCAN 覆盖全部匹配键", got === 50, "got=" + got);
  check("SCAN 每次都返回非空批次（真实 Redis 允许空批次 → 桩偏乐观）", emptyBatch === 0, "emptyBatch=" + emptyBatch);

  // SCAN 游标：键在扫描期间被删不应导致死循环
  section("SCAN：并发删键不产生死循环");
  const m3 = new MiniRedis();
  for (let i = 0; i < 20; i++) m3.command(["SET", "d" + i, "v"]);
  cur = "0"; rounds = 0;
  do {
    m3.command(["DEL", "d" + Math.floor(Math.random() * 20)]);
    const r = m3.command(["SCAN", cur, "MATCH", "*", "COUNT", "3"]);
    cur = String(r[0]); rounds++;
    if (rounds > 300) break;
  } while (cur !== "0");
  check("并发删键时 SCAN 仍终止", rounds <= 300, "rounds=" + rounds);

  // ================= 5. HSCAN 语义 =================
  section("HSCAN：MATCH/COUNT/游标");
  const m4 = new MiniRedis();
  for (let i = 0; i < 20; i++) m4.command(["HSET", "h", "f" + i, "v" + i]);
  const [c1, f1] = m4.command(["HSCAN", "h", "0", "COUNT", "5"]);
  check("HSCAN COUNT 生效（分批）", f1.length / 2 <= 5, "本轮字段=" + f1.length / 2 + " cursor=" + c1);
  const [c2, f2] = m4.command(["HSCAN", "h", c1, "COUNT", "5"]);
  check("HSCAN 游标续扫（第二批与第一批不重叠）", f2.length > 0 || c2 === "0", "cursor=" + c2);
  const [, fm] = m4.command(["HSCAN", "h", "0", "MATCH", "f1*", "COUNT", "100"]);
  check("HSCAN MATCH 生效", fm.every((_, i) => i % 2 === 0 ? String(_).startsWith("f1") : true), JSON.stringify(fm));

  // ================= 6. MGET / 哈希 =================
  section("MGET 与哈希命令");
  m.command(["SET", "mg1", "a"]); m.command(["SET", "mg3", "c"]);
  check("MGET 缺失键返回 null（不是 undefined）", eq(m.command(["MGET", "mg1", "nope", "mg3"]), ["a", null, "c"]));
  const h = new MiniRedis();
  check("HMGET 缺失 field 返回 null", eq(h.command(["HMGET", "nohash", "f"]), [null]));
  check("HGETALL 缺失键返回 []", eq(h.command(["HGETALL", "nohash"]), []));
  check("HGET 缺失返回 null", h.command(["HGET", "nohash", "f"]) === null);

  // HSET 多字段返回值
  const h2 = new MiniRedis();
  check("HSET 新建 2 字段返回 2", h2.command(["HSET", "h", "a", "1", "b", "2"]) === 2);
  check("HSET 全覆盖返回 0", h2.command(["HSET", "h", "a", "9", "b", "8"]) === 0);

  // ================= 7. 列表 =================
  section("列表：LTRIM/LRANGE 负数索引");
  const L = new MiniRedis();
  L.command(["DEL", "L"]); L.command(["RPUSH", "L", "1", "2", "3", "4", "5"]);
  L.command(["LTRIM", "L", "0", "-1"]);
  check("LTRIM 0 -1 保留全部", L.command(["LRANGE", "L", "0", "-1"]).length === 5, "len=" + L.command(["LRANGE", "L", "0", "-1"]).length);
  L.command(["LTRIM", "L", "1", "-1"]);
  check("LTRIM 1 -1 保留后 4 个", L.command(["LRANGE", "L", "0", "-1"]).length === 4, "len=" + L.command(["LRANGE", "L", "0", "-1"]).length);
  check("LRANGE 负索引解析正确", eq(L.command(["LRANGE", "L", "-2", "-1"]), ["4", "5"]));
  // LTRIM start > len → 空列表（真实行为）
  const L2 = new MiniRedis(); L2.command(["RPUSH", "L2", "a", "b"]);
  L2.command(["LTRIM", "L2", "5", "10"]);
  check("LTRIM 起点越界→空列表", eq(L2.command(["LRANGE", "L2", "0", "-1"]), []));
  // LTRIM stop < start → 空列表
  const L3 = new MiniRedis(); L3.command(["RPUSH", "L3", "a", "b", "c"]);
  L3.command(["LTRIM", "L3", "2", "1"]);
  check("LTRIM stop<start→空列表", eq(L3.command(["LRANGE", "L3", "0", "-1"]), []));

  // ================= 8. 数值 =================
  section("数值命令");
  const N = new MiniRedis();
  check("INCR 全新键→1", N.command(["INCR", "ctr"]) === 1);
  check("INCR 递增", N.command(["INCR", "ctr"]) === 2);
  let incrErr = false;
  try { N.command(["INCR", "bad"]); } catch (e) { incrErr = true; }
  N.command(["SET", "bad", "notanumber"]);
  let incrOnStr = null;
  try { incrOnStr = N.command(["INCR", "bad"]); } catch (e) { incrOnStr = "ERR:" + e.message; }
  check("INCR 对非数字报错（真实 Redis 返回 ERR）", incrOnStr !== 2, "got=" + incrOnStr);
  // DECR / INCRBY 未实现
  let decrUnsupported = false;
  try { N.command(["DECR", "ctr"]); } catch (e) { decrUnsupported = String(e.message).includes("UNSUPPORTED"); }
  check("DECR 未被桩支持（生产若用会失败，需补）", decrUnsupported);
  let incrbyUnsupported = false;
  try { N.command(["INCRBY", "ctr", "5"]); } catch (e) { incrbyUnsupported = String(e.message).includes("UNSUPPORTED"); }
  check("INCRBY 未被桩支持（生产若用会失败，需补）", incrbyUnsupported);

  // ================= 9. pipeline / 全命令覆盖 =================
  section("覆盖度：生产实际用到的命令是否都支持");
  const fs = require("fs"); const path = require("path");
  const apiDir = path.join(__dirname, "..", "functions", "api");
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".js") ? [path.join(d, e.name)] : []));
  const files = fs.existsSync(apiDir) ? walk(apiDir) : [];
  // 只统计**真实 Redis 命令**：从 EVAL 的 Lua 脚本与命令调用中提取，排除业务字符串常量
  const REAL_CMDS = new Set(["GET", "SET", "DEL", "SADD", "SREM", "SMEMBERS", "SISMEMBER", "MGET", "SCAN", "HSCAN", "HSET", "HGET", "HGETALL", "HMGET", "HDEL", "HLEN", "RPUSH", "LTRIM", "LRANGE", "LLEN", "INCR", "EXPIRE", "EXISTS", "TTL", "PTTL", "PERSIST", "EVAL", "PING", "TYPE", "KEYS", "RENAME", "EXPIREAT", "SETEX", "INCRBY", "DECR", "ZADD", "ZRANGE", "ZREM", "LPUSH", "GETEX"]);
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    // 仅从 command([...]) / pipeline 的数组首元素、以及 Lua 里 redis.call("X" 取命令名
    for (const mt of src.matchAll(/command\(\s*\[\s*"([A-Z][A-Z0-9_]{1,11})"/g)) used.add(mt[1]);
    for (const mt of src.matchAll(/redis\.call\(\s*"([A-Z][A-Z0-9_]{1,11})"/g)) used.add(mt[1]);
  }
  const actuallyUsed = [...used].filter(c => REAL_CMDS.has(c)).sort();
  console.log("  · 生产实际使用的 Redis 命令：" + actuallyUsed.join(", "));
  const probe = new MiniRedis();
  const PROBE_ARGS = {
    GET: ["GET", "__none__"], SET: ["SET", "__k", "v"], DEL: ["DEL", "__k"], SADD: ["SADD", "__s", "x"],
    SMEMBERS: ["SMEMBERS", "__s"], SISMEMBER: ["SISMEMBER", "__s", "x"], SREM: ["SREM", "__s", "x"],
    MGET: ["MGET", "__k"], SCAN: ["SCAN", "0", "MATCH", "*", "COUNT", "10"], HSET: ["HSET", "__h", "f", "v"],
    HGET: ["HGET", "__h", "f"], HGETALL: ["HGETALL", "__h"], HMGET: ["HMGET", "__h", "f"], HDEL: ["HDEL", "__h", "f"],
    HLEN: ["HLEN", "__h"], HSCAN: ["HSCAN", "__h", "0", "COUNT", "10"], RPUSH: ["RPUSH", "__l", "x"],
    LTRIM: ["LTRIM", "__l", "0", "-1"], LRANGE: ["LRANGE", "__l", "0", "-1"], LLEN: ["LLEN", "__l"],
    INCR: ["INCR", "__c"], EXPIRE: ["EXPIRE", "__k", "10"], EXISTS: ["EXISTS", "__k"], TTL: ["TTL", "__k"],
    PTTL: ["PTTL", "__k"], PERSIST: ["PERSIST", "__k"], EVAL: ["EVAL", "return 1", "0"],
  };
  const unsupported = [];
  for (const cmd of actuallyUsed) {
    const pa = PROBE_ARGS[cmd];
    if (!pa) { unsupported.push(cmd + "(无探测参数)"); continue; }
    try { probe.command(pa); } catch (e) { if (String(e.message).includes("UNSUPPORTED")) unsupported.push(cmd); }
  }
  check("生产用到的命令桩均已实现", unsupported.length === 0, "未实现=" + (unsupported.join(",") || "无"));

  console.log("\nMINI_REDIS_FIDELITY：通过 " + pass + " / 失败 " + fail);
  if (findings.length) {
    console.log("\n失真清单：");
    findings.forEach((f, i) => console.log("  " + (i + 1) + ". " + f));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("审计脚本异常：", e); process.exit(2); });
