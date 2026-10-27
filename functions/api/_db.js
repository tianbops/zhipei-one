/**
 * 智配One · D1 存储引擎（Upstash Redis 的 D1 兼容替代层）
 * ------------------------------------------------------------------
 * 目标：在保持 functions/api 全部调用点（command / pipeline / get / set / del / EVAL）
 * 零改动的前提下，把存储后端从 Upstash Redis 切换到 Cloudflare D1（SQLite）。
 *
 * 设计：
 *   - 单张 kv 表（key 主键，value 文本，type 类型，expires_at 过期秒）。
 *   - string / hash / set / list 四种类型都用同一张表存，type 区分，值用 JSON 编码。
 *   - 事务模型（适配 D1 运行时约束）：D1 禁止显式 BEGIN/COMMIT（code 7500，线上实测），
 *     其原子原语是 db.batch()（一批语句原子提交）。因此每个 command/EVAL 采用
 *     「读立即执行 + 写缓冲 overlay + 结束时 batch 原子落库」：
 *       · 事务内读先查 overlay（同事务内先写后读可见），未命中再读库；
 *       · 全部写先记入 overlay（同键多次写自动合并为最终一条）；
 *       · 处理器正常返回后把 overlay 以 batch 一次性提交；中途抛错则不落库（等价回滚）。
 *     已知取舍：读与 batch 之间存在毫秒级竞态窗口，并发写同一键为 last-write-wins
 *     （Upstash EVAL 是强原子）。本项目为低并发管理端场景，可接受；如未来需要强
 *     串行化，可把热点命令升级为单条条件 SQL 或引入 Durable Object 串行化。
 *   - 本文件不直接依赖 Workers/D1 专有 API，而是通过注入的 db 对象（满足 D1 的
 *     prepare/bind/run/all/first/batch 形状）工作；tests 用 node:sqlite 适配器注入，
 *     无需真实 Cloudflare 环境即可离线验证。
 *
 * 注意：所有键都已由调用方带 "zp:" 前缀（command 收到的就是全限定键），本层原样存储。
 */

// ============ 类型常量 ============
const T_STRING = "string";
const T_HASH = "hash";
const T_SET = "set";
const T_LIST = "list";

const nowSec = () => Math.floor(Date.now() / 1000);

// ============ glob → SQL LIKE 转换 ============
// Redis SCAN/HSCAN 使用 glob：* 任意多字符，? 单字符，[..] 字符集（本项目未用字符集）。
function globToLike(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") out += "%";
    else if (c === "?") out += "_";
    else if (c === "%" || c === "_" || c === "\\") out += "\\" + c;
    else out += c;
  }
  return out;
}

// ============ 低层行读（读路径共用；惰性 TTL 判死） ============
async function rawGet(db, key) {
  const row = await db.prepare("SELECT key,value,type,expires_at FROM kv WHERE key=?").bind(key).first();
  if (!row) return null;
  if (row.expires_at != null && Number(row.expires_at) <= nowSec()) {
    await db.prepare("DELETE FROM kv WHERE key=?").bind(key).run();
    return null;
  }
  return row;
}

export class D1Backend {
  constructor(db) {
    this.db = db;
  }

  /**
   * 事务包装（D1 适配版）：读即时、写缓冲、结束时 batch 原子提交。
   * fn 抛错时 overlay 从未落库，等价于 ROLLBACK。
   */
  async tx(fn) {
    const ctx = this.makeCtx();
    const result = await fn(ctx);
    await ctx.__flush();
    return result;
  }

  /** 构造本命令的读写上下文（读透 overlay；写进 overlay，由 __flush 原子提交）。 */
  makeCtx() {
    const db = this.db;
    const self = this;
    // pending: key -> {op:'del'} | {op:'set', value, type, expires_at}（Map 保序，flush 按首次写入顺序）
    const pending = new Map();
    const bufSet = (key, value, type, expires_at) => pending.set(key, { op: "set", value, type, expires_at });
    const bufDel = (key) => pending.set(key, { op: "del" });
    // 读：先 overlay 后库（惰性 TTL 判死）
    async function readRow(key) {
      const p = pending.get(key);
      if (p) {
        if (p.op === "del") return null;
        if (p.expires_at != null && Number(p.expires_at) <= nowSec()) return null;
        return { key, value: p.value, type: p.type, expires_at: p.expires_at };
      }
      return rawGet(db, key);
    }
    const ctx = {
      db,
      // ---- 内部（供 tx flush 与 RENAME 的原样 upsert；EVAL 处理器不使用） ----
      async __flush() {
        if (!pending.size) return;
        const stmts = [];
        for (const [key, p] of pending) {
          if (p.op === "del") stmts.push(db.prepare("DELETE FROM kv WHERE key=?").bind(key));
          else
            stmts.push(
              db
                .prepare(
                  "INSERT INTO kv(key,value,type,expires_at) VALUES(?,?,?,?) " +
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value, type=excluded.type, expires_at=excluded.expires_at"
                )
                .bind(key, p.value, p.type, p.expires_at)
            );
        }
        pending.clear();
        await db.batch(stmts);
      },
      async setRaw(key, value, type, expires_at) {
        bufSet(key, value, type, expires_at);
      },
      // ---- 通用行 ----
      async get(key) {
        const row = await readRow(key);
        return row ? row.value : null;
      },
      async getRow(key) {
        return readRow(key);
      },
      async set(key, value, ttlSeconds = null) {
        const expires_at = ttlSeconds && Number(ttlSeconds) > 0 ? nowSec() + Math.floor(Number(ttlSeconds)) : null;
        bufSet(key, value, T_STRING, expires_at);
      },
      async del(key) {
        const row = await readRow(key);
        if (!row) return 0;
        bufDel(key);
        return 1;
      },
      // ---- hash ----
      async hget(key, field) {
        const row = await readRow(key);
        if (!row || row.type !== T_HASH) return null;
        let obj;
        try { obj = JSON.parse(row.value); } catch { return null; }
        if (obj && Object.prototype.hasOwnProperty.call(obj, field)) return obj[field];
        return null;
      },
      async hgetall(key) {
        // 返回 Redis 形态扁平数组 [field,value,field,value,...]
        const row = await readRow(key);
        if (!row || row.type !== T_HASH) return [];
        let obj;
        try { obj = JSON.parse(row.value); } catch { return []; }
        const out = [];
        for (const k of Object.keys(obj)) out.push(k, obj[k]);
        return out;
      },
      async hmget(key, fields) {
        const row = await readRow(key);
        let obj = {};
        if (row && row.type === T_HASH) {
          try { obj = JSON.parse(row.value); } catch { obj = {}; }
        }
        return fields.map((f) => (obj && Object.prototype.hasOwnProperty.call(obj, f) ? obj[f] : null));
      },
      async hset(key, entries) {
        // entries: [[field,value],...]
        const row = await readRow(key);
        let obj = {};
        if (row && row.type === T_HASH) {
          try { obj = JSON.parse(row.value); } catch { obj = {}; }
        }
        let added = 0;
        for (const [f, v] of entries) {
          if (!Object.prototype.hasOwnProperty.call(obj, f)) added++;
          obj[f] = v;
        }
        bufSet(key, JSON.stringify(obj), T_HASH, row ? row.expires_at : null);
        return added;
      },
      async hdel(key, fields) {
        const row = await readRow(key);
        if (!row || row.type !== T_HASH) return 0;
        let obj;
        try { obj = JSON.parse(row.value); } catch { return 0; }
        let removed = 0;
        for (const f of fields) {
          if (Object.prototype.hasOwnProperty.call(obj, f)) { delete obj[f]; removed++; }
        }
        if (Object.keys(obj).length === 0) bufDel(key);
        else bufSet(key, JSON.stringify(obj), T_HASH, row.expires_at);
        return removed;
      },
      async hlen(key) {
        const row = await readRow(key);
        if (!row || row.type !== T_HASH) return 0;
        try { return Object.keys(JSON.parse(row.value)).length; } catch { return 0; }
      },
      async hscan(key, cursor = "0", match = "*", count = 200) {
        // 本项目使用场景：遍历整张 hash（records/aliases）。一次返回全部，游标置 "0"。
        const row = await readRow(key);
        let obj = {};
        if (row && row.type === T_HASH) {
          try { obj = JSON.parse(row.value); } catch { obj = {}; }
        }
        const like = globToLike(match);
        const entries = [];
        for (const k of Object.keys(obj)) {
          if (like !== "%" && !likeTest(k, match)) continue;
          entries.push([k, obj[k]]);
        }
        const flat = [];
        for (const [k, v] of entries) flat.push(k, v);
        return ["0", flat];
      },
      // ---- 计数器（hash 字段自增，供性能遥测聚合） ----
      async hincrby(key, field, n) {
        const row = await readRow(key);
        let obj = {};
        let expires_at = null;
        if (row && row.type === T_HASH) {
          try { obj = JSON.parse(row.value); } catch { obj = {}; }
          expires_at = row.expires_at;
        }
        const cur = Number(obj[field]);
        const next = (Number.isFinite(cur) ? cur : 0) + Math.floor(Number(n));
        obj[field] = String(next);
        bufSet(key, JSON.stringify(obj), T_HASH, expires_at);
        return next;
      },
      async hincrbyfloat(key, field, f) {
        const row = await readRow(key);
        let obj = {};
        let expires_at = null;
        if (row && row.type === T_HASH) {
          try { obj = JSON.parse(row.value); } catch { obj = {}; }
          expires_at = row.expires_at;
        }
        const cur = Number(obj[field]);
        const next = Math.round(((Number.isFinite(cur) ? cur : 0) + Number(f)) * 1e6) / 1e6;
        obj[field] = String(next);
        bufSet(key, JSON.stringify(obj), T_HASH, expires_at);
        return String(next);
      },
      // ---- set ----
      async sadd(key, members) {
        const row = await readRow(key);
        let arr = [];
        let expires_at = null;
        if (row && row.type === T_SET) {
          try { arr = JSON.parse(row.value); } catch { arr = []; }
          expires_at = row.expires_at;
        }
        const set = new Set(arr);
        let added = 0;
        for (const m of members) {
          const s = String(m);
          if (!set.has(s)) { set.add(s); added++; }
        }
        if (set.size === 0) bufDel(key);
        else bufSet(key, JSON.stringify([...set]), T_SET, expires_at);
        return added;
      },
      async srem(key, members) {
        const row = await readRow(key);
        if (!row || row.type !== T_SET) return 0;
        let arr;
        try { arr = JSON.parse(row.value); } catch { return 0; }
        const set = new Set(arr);
        let removed = 0;
        for (const m of members) {
          const s = String(m);
          if (set.delete(s)) removed++;
        }
        if (set.size === 0) bufDel(key);
        else bufSet(key, JSON.stringify([...set]), T_SET, row.expires_at);
        return removed;
      },
      async smembers(key) {
        const row = await readRow(key);
        if (!row || row.type !== T_SET) return [];
        try { return JSON.parse(row.value); } catch { return []; }
      },
      async scard(key) {
        const row = await readRow(key);
        if (!row || row.type !== T_SET) return 0;
        try { return JSON.parse(row.value).length; } catch { return 0; }
      },
      async sismember(key, member) {
        const row = await readRow(key);
        if (!row || row.type !== T_SET) return 0;
        try { return JSON.parse(row.value).includes(String(member)) ? 1 : 0; } catch { return 0; }
      },
      // ---- list ----
      async rpush(key, values) {
        const row = await readRow(key);
        let arr = [];
        let expires_at = null;
        if (row && row.type === T_LIST) {
          try { arr = JSON.parse(row.value); } catch { arr = []; }
          expires_at = row.expires_at;
        }
        for (const v of values) arr.push(String(v));
        bufSet(key, JSON.stringify(arr), T_LIST, expires_at);
        return arr.length;
      },
      async lpush(key, values) {
        const row = await readRow(key);
        let arr = [];
        let expires_at = null;
        if (row && row.type === T_LIST) {
          try { arr = JSON.parse(row.value); } catch { arr = []; }
          expires_at = row.expires_at;
        }
        for (let i = values.length - 1; i >= 0; i--) arr.unshift(String(values[i]));
        bufSet(key, JSON.stringify(arr), T_LIST, expires_at);
        return arr.length;
      },
      async lrange(key, start, stop) {
        const row = await readRow(key);
        if (!row || row.type !== T_LIST) return [];
        let arr;
        try { arr = JSON.parse(row.value); } catch { return []; }
        const len = arr.length;
        let s = Number(start), e = Number(stop);
        if (s < 0) s = len + s;
        if (e < 0) e = len + e;
        s = Math.max(0, s); e = Math.min(len - 1, e);
        if (s > e || s >= len) return [];
        return arr.slice(s, e + 1);
      },
      async llen(key) {
        const row = await readRow(key);
        if (!row || row.type !== T_LIST) return 0;
        try { return JSON.parse(row.value).length; } catch { return 0; }
      },
      async lpop(key) {
        const row = await readRow(key);
        if (!row || row.type !== T_LIST) return null;
        let arr;
        try { arr = JSON.parse(row.value); } catch { return null; }
        if (!arr.length) return null;
        const v = arr.shift();
        if (arr.length === 0) bufDel(key);
        else bufSet(key, JSON.stringify(arr), T_LIST, row.expires_at);
        return v;
      },
      async ltrim(key, start, stop) {
        const row = await readRow(key);
        if (!row || row.type !== T_LIST) return;
        let arr;
        try { arr = JSON.parse(row.value); } catch { return; }
        const len = arr.length;
        let s = Number(start), e = Number(stop);
        if (s < 0) s = len + s;
        if (e < 0) e = len + e;
        s = Math.max(0, s); e = Math.min(len - 1, e);
        if (s > e || s >= len) { bufDel(key); return; }
        bufSet(key, JSON.stringify(arr.slice(s, e + 1)), T_LIST, row.expires_at);
      },
      // ---- 计数器 ----
      async incrby(key, n) {
        const row = await readRow(key);
        let cur = 0;
        let expires_at = null;
        if (row) {
          const v = Number(row.value);
          cur = Number.isFinite(v) ? v : 0;
          expires_at = row.expires_at;
        }
        const next = cur + Number(n);
        bufSet(key, String(next), T_STRING, expires_at);
        return next;
      },
      async incr(key) { return ctx.incrby(key, 1); },
      // ---- 通用 ----
      async exists(key) { return (await readRow(key)) ? 1 : 0; },
      async expire(key, ttlSeconds) {
        const row = await readRow(key);
        if (!row) return 0;
        const expires_at = Math.floor(Number(ttlSeconds)) > 0 ? nowSec() + Math.floor(Number(ttlSeconds)) : null;
        bufSet(key, row.value, row.type, expires_at);
        return 1;
      },
      async ttl(key) {
        const row = await readRow(key);
        if (!row) return -2;
        if (row.expires_at == null) return -1;
        return Math.max(0, Number(row.expires_at) - nowSec());
      },
      async mget(keys) {
        if (!keys.length) return [];
        // overlay 优先，其余键走一次 IN 查询
        const rest = [];
        const map = new Map();
        for (const k of keys) {
          const p = pending.get(k);
          if (p) map.set(k, p.op === "del" ? null : p.value);
          else rest.push(k);
        }
        if (rest.length) {
          const placeholders = rest.map(() => "?").join(",");
          const rows = await db.prepare(`SELECT key,value,type,expires_at FROM kv WHERE key IN (${placeholders})`).bind(...rest).all();
          for (const r of rows.results || []) {
            if (r.expires_at != null && Number(r.expires_at) <= nowSec()) continue;
            map.set(r.key, r.value);
          }
        }
        return keys.map((k) => (map.has(k) ? map.get(k) : null));
      },
      async scan(pattern, count = 500, cursor = "0") {
        // 支持游标分页（offset 式），与 Redis SCAN 的「分多次取完」语义对齐，
        // 避免单次 LIMIT 截断导致大键空间下漏键。返回 [nextCursor, keys]。
        // overlay 合并：剔除本事务待删键；追加本事务新写且匹配模式的键。
        const like = globToLike(pattern);
        const offset = Math.max(0, parseInt(cursor, 10) || 0);
        const rows = await db
          .prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ? OFFSET ?")
          .bind(like, Number(count) + 1, offset)
          .all();
        const all = rows.results || [];
        const page = all.slice(0, count).map((r) => r.key);
        const nextCursor = all.length > count ? String(offset + count) : "0";
        // 应用 overlay：去掉待删键，补上新写键
        const filtered = page.filter((k) => {
          const p = pending.get(k);
          return !(p && p.op === "del");
        });
        if (pending.size) {
          const have = new Set(filtered);
          for (const [k, p] of pending) {
            if (p.op === "set" && !have.has(k) && likeTest(k, pattern)) filtered.push(k);
          }
        }
        return [nextCursor, filtered];
      },
    };
    return ctx;
  }

  /** 执行单条命令（非 EVAL）。读即时、写经 batch 原子提交。 */
  async command(parts) {
    const cmd = String(parts[0] || "").toUpperCase();
    return this.tx(async (ctx) => this.execCommand(ctx, parts, cmd));
  }

  async execCommand(ctx, parts, cmd) {
    switch (cmd) {
      case "GET":
        return ctx.get(parts[1]);
      case "SET": {
        // SET key value [EX seconds] [PX ms] [NX|XX]
        const value = parts[2];
        let ttl = null, nx = false, xx = false;
        for (let j = 3; j < parts.length; j++) {
          const opt = String(parts[j] || "").toUpperCase();
          if (opt === "EX") ttl = parts[++j];
          else if (opt === "PX") ttl = Number(parts[++j]) / 1000;
          else if (opt === "NX") nx = true;
          else if (opt === "XX") xx = true;
        }
        if (nx || xx) {
          const row = await ctx.getRow(parts[1]);
          if (nx && row) return null;   // 已存在 → NX 落空
          if (xx && !row) return null;  // 不存在 → XX 落空
        }
        await ctx.set(parts[1], String(value), ttl);
        return "OK";
      }
      case "DEL": {
        let total = 0;
        for (let i = 1; i < parts.length; i++) total += await ctx.del(parts[i]);
        return total;
      }
      case "EXISTS":
        return ctx.exists(parts[1]);
      case "EXPIRE":
        return ctx.expire(parts[1], parts[2]);
      case "TTL":
        return ctx.ttl(parts[1]);
      case "INCR":
        return ctx.incr(parts[1]);
      case "INCRBY":
        return ctx.incrby(parts[1], parts[2]);
      case "DECR":
        return ctx.incrby(parts[1], -1);
      case "DECRBY":
        return ctx.incrby(parts[1], -Number(parts[2] || 1));
      case "HGET":
        return ctx.hget(parts[1], parts[2]);
      case "HSET": {
        const entries = [];
        for (let i = 2; i + 1 < parts.length; i += 2) entries.push([parts[i], parts[i + 1]]);
        return ctx.hset(parts[1], entries);
      }
      case "HMGET":
        return ctx.hmget(parts[1], parts.slice(2));
      case "HGETALL":
        return ctx.hgetall(parts[1]);
      case "HDEL":
        return ctx.hdel(parts[1], parts.slice(2));
      case "HLEN":
        return ctx.hlen(parts[1]);
      case "HSCAN": {
        // ["HSCAN", key, cursor, "MATCH", pattern, "COUNT", n]
        // 选项键位于下标 3,5…，游标恒为下标 2，键恒为下标 1。
        const key = parts[1];
        const cursor = String(parts[2] || "0");
        let match = "*", count = 200;
        for (let i = 3; i + 1 < parts.length; i += 2) {
          const opt = String(parts[i] || "").toUpperCase();
          if (opt === "MATCH") match = parts[i + 1];
          else if (opt === "COUNT") count = Number(parts[i + 1]) || 200;
        }
        return ctx.hscan(key, cursor, match, count);
      }
      case "SADD":
        return ctx.sadd(parts[1], parts.slice(2));
      case "SREM":
        return ctx.srem(parts[1], parts.slice(2));
      case "SMEMBERS":
        return ctx.smembers(parts[1]);
      case "SCARD":
        return ctx.scard(parts[1]);
      case "SISMEMBER":
        return ctx.sismember(parts[1], parts[2]);
      case "SMOVE":
        // 本项目未使用，备查：从 set1 移除并加入 set2
        return ctx.srem(parts[1], [parts[2]]);
      case "RPUSH":
        return ctx.rpush(parts[1], parts.slice(2));
      case "LPUSH":
        return ctx.lpush(parts[1], parts.slice(2));
      case "LRANGE":
        return ctx.lrange(parts[1], parts[2], parts[3]);
      case "LLEN":
        return ctx.llen(parts[1]);
      case "LPOP":
        return ctx.lpop(parts[1]);
      case "LTRIM":
        return ctx.ltrim(parts[1], parts[2], parts[3]);
      case "MGET":
        return ctx.mget(parts.slice(1));
      case "PING":
        return "PONG";
      case "TYPE": {
        const row = await ctx.getRow(parts[1]);
        return row ? row.type : "none";
      }
      case "RENAME": {
        // Redis RENAME：源不存在返回 0（温和于 Redis 的 ERR，调用方按移动成功与否判断）；
        // 存在则覆盖式移动（目标键被覆盖），TTL 随源走。软删除/恢复的子键迁移依赖此命令。
        const src = parts[1], dst = parts[2];
        const row = await ctx.getRow(src);
        if (!row) return 0;
        if (src === dst) return 1;
        await ctx.del(dst);
        await ctx.setRaw(dst, row.value, row.type, row.expires_at);
        await ctx.del(src);
        return 1;
      }
      case "SCAN": {
        // ["SCAN", cursor, "MATCH", pattern, "COUNT", n]
        // 选项键位于偶数下标（2,4…），游标恒为下标 1。
        let pattern = "*", count = 500;
        const cursor = String(parts[1] || "0");
        for (let i = 2; i + 1 < parts.length; i += 2) {
          const opt = String(parts[i] || "").toUpperCase();
          if (opt === "MATCH") pattern = parts[i + 1];
          else if (opt === "COUNT") count = Number(parts[i + 1]) || 500;
        }
        const [next, keys] = await ctx.scan(pattern, count, cursor);
        return [next, keys];
      }
      case "EVAL":
      case "EVALSHA":
        return execEval(ctx, parts);
      default:
        throw new Error("D1_UNSUPPORTED_COMMAND:" + cmd);
    }
  }

  /** pipeline：多条命令按序执行，全部写经 batch 原子提交，返回逐条结果数组。 */
  async pipeline(commands) {
    return this.tx(async (ctx) => {
      const out = [];
      for (const parts of commands) {
        const cmd = String(parts[0] || "").toUpperCase();
        out.push(await this.execCommand(ctx, parts, cmd));
      }
      return out;
    });
  }
}

// glob 直接匹配（用于 hscan match，简单实现）
function likeTest(k, match) {
  // 仅支持 * 与 ?（本项目 match 多为 "*" 或精确，这里做最小实现）
  const re = new RegExp("^" + match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(k);
}

// ============ EVAL 分发 ============
// 运行时按「归一化脚本文本」查找处理器；找不到抛 UNIMPLEMENTED_EVAL（带归一化文本，便于补表）。
import { lookupEval } from "./_redis-eval.js";
import { normalizeLua } from "./_redis-norm.js";

export function normalizeEvalScript(script) {
  return normalizeLua(script);
}

function execEval(ctx, parts) {
  const script = parts[1];
  const numkeys = Number(parts[2] || 0);
  const keys = parts.slice(3, 3 + numkeys).map(String);
  const args = parts.slice(3 + numkeys).map((a) => (a == null ? "" : String(a)));
  const norm = normalizeLua(script);
  const handler = lookupEval(norm);
  if (!handler) {
    const err = new Error("UNIMPLEMENTED_EVAL");
    err.code = "UNIMPLEMENTED_EVAL";
    err.script = norm.slice(0, 240);
    throw err;
  }
  return handler(ctx, keys, args);
}

// ============ 注入式后端工厂 ============
// 检测 env.DB 是否存在，存在则返回 D1 后端（非破坏性：不存在时调用方应回退 Upstash）。
export function createD1Backend(env) {
  if (env && env.DB) return new D1Backend(env.DB);
  return null;
}

export default { D1Backend, createD1Backend, normalizeEvalScript };
