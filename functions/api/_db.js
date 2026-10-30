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

import { degraded } from "./_degrade.js";

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
  constructor(db, options) {
    this.quota = {
      // statements：独立语句数（**不含**已进 batch 的语句，它们在 batch 提交时被抵扣）
      // batches：batch 次数（D1 按 1 次查询计）
      // consumed = statements + batches ≈ D1 侧真实配额消耗
      statements: 0,
      batches: 0,
      // Cloudflare D1 免费版：单次 Worker 调用最多 50 条查询（batch 内多条按 1 计）。
      // 2026-10-27 上线首日就踩到过：历史概览路径 ~100 查询导致首页统计板块直接消失。
      // 那次是靠事后线上现象才定位到，代价太大；这里改成**事前可观测**。
      WARN_AT: (options && options.warnAt) || 35,   // 70%，提前预警
      CRIT_AT: (options && options.critAt) || 45,   // 90%，接近触顶
      // tag -> 已上报过（**作用域内**去重，见 __resetQuota：随每次外层调用清零）
      alerted: {},
    };
    // 调用作用域深度：>0 表示当前处在某次 command/tx/pipeline 调用内。
    this.__scopeDepth = 0;
    this.db = this.__counting(db);
  }

  /**
   * 配额计数的**口径边界**。
   *
   * 教训（2026-10-28 复盘，务必记住）：
   *   这里最初把 quota 当作「实例级 = 单次 Worker 调用」来用，理由是 _redis.js 里
   *   `if (!env.__zpD1) env.__zpD1 = createD1Backend(env)` 把后端缓存在 env 上。
   *   但**那个前提是错的**：Cloudflare 官方文档明确写着
   *     "a single Workers instance may handle multiple requests ... Cloudflare
   *      recommends you do not use or mutate global state."
   *   env 上的缓存在同一 isolate 生命周期内会跨请求命中（这正是它作为缓存惯用法的全部意义），
   *   所以实例级计数会**单调累积**，且 alerted 是一次性锁存 ——
   *   组合效果是：isolate 存活期内只告警一次，此后**永久沉默**，护栏彻底哑火。
   *
   * 修正：把口径改为确定边界 —— **一次最外层 Redis 层调用**（command/tx/pipeline）。
   *   · command()/pipeline() 都委托给 tx()，嵌套调用靠深度保护不会被误清零；
   *   · D1 的 50 查询限额按 Worker invocation 计，而历史上真实踩到的那次
   *     （2026-10-27 首页统计板块消失）正是**单次 pipeline 内膨胀到 ~100 条**，
   *     所以「每次 Redis 层调用」这个口径能覆盖真实故障形态；
   *   · 代价：同一个请求内多次 command 累加的场景不会在这里体现 ——
   *     那种情况 D1 会直接抛错并写 ERROR 日志，仍有别的手段兜住。
   * 宁可用一个口径明确、不会哑火的近似值，也不要一个依赖错误假设的"精确值"。
   */
  __resetQuota() {
    this.quota.statements = 0;
    this.quota.batches = 0;
    this.quota.alerted = {};
  }

  __beginScope() {
    this.__scopeDepth = (this.__scopeDepth || 0) + 1;
    if (this.__scopeDepth === 1) this.__resetQuota();
  }

  __endScope() {
    this.__scopeDepth = Math.max(0, (this.__scopeDepth || 0) - 1);
  }

  /**
   * 给注入的 db 包一层计数代理：其余代码零改动即可统计每次 prepare/batch。
   *
   * 为什么计数是实例级：这里只做**旁路累加**，边界由 tx() 的调用作用域给出（见 __resetQuota）。
   * 实例本身必须保持"无跨请求语义"——任何依赖 env 生命周期的假设都不能成立。
   *
   * 注意：只做旁路统计，**绝不拦截、绝不改行为**；代理本身出任何问题都退化为"（不计数）"。
   */
  __counting(db) {
    if (!db || typeof db !== "object") return db;
    const self = this;
    try {
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql) => {
              self.__tick("statements");
              return target.prepare(sql);
            };
          }
          if (prop === "batch") {
            return (stmts) => {
              // 【口径修正】batch 内的每条语句在 prepare 时已经各计了一次 statements，
              // 但 D1 侧一次 batch 只算 1 次查询配额。若不在提交时抵扣，一次含 10 条
              // 写入的事务会被计成 11 —— 高估一个数量级，告警线形同虚设
              // （真实验证：写 10 个键 → 抵扣前报 11，D1 实际消耗 1）。
              const n = Array.isArray(stmts) ? stmts.length : 0;
              self.quota.statements = Math.max(0, self.quota.statements - n);
              self.__tick("batches");
              return target.batch(stmts);
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    } catch {
      // 代理不可用（极少见）时宁可不计数，也不能让存储层失效
      return db;
    }
  }

  /**
   * 累加计数并在跨过阈值时上报一次。
   * 口径说明： consumed = statements + batches 近似 D1 的查询配额消耗
   * （batch 内多条语句在 D1 侧按 1 次查询计，故此处用 batches 而非其内部语句数）。
   */
  __tick(kind) {
    if (kind === "statements") this.quota.statements += 1;
    else this.quota.batches += 1;
    const used = this.quota.statements + this.quota.batches;
    if (used >= this.quota.CRIT_AT) this.__alert("crit", used);
    else if (used >= this.quota.WARN_AT) this.__alert("warn", used);
  }

  __alert(level, used) {
    const tag = level === "crit" ? "d1.quota-critical" : "d1.quota-warning";
    if (this.quota.alerted[tag]) return;
    this.quota.alerted[tag] = true;
    // 动态引入避免 _db.js 承担额外耦合；失败也无所谓（纯观测）
    try {
      // eslint-disable-next-line no-undef
      degraded(tag, new Error(`D1 查询配额接近上限：已用 ${used}（告警线 ${this.quota.WARN_AT} / 危险线 ${this.quota.CRIT_AT}，免费版上限 50）`), {
        used,
        statements: this.quota.statements,
        batches: this.quota.batches,
        limit: 50,
      });
    } catch {
      /* 观测不许影响存储层 */
    }
  }

  /**
   * 事务包装（D1 适配版）：读即时、写缓冲、结束时 batch 原子提交。
   * fn 抛错时 overlay 从未落库，等价于 ROLLBACK。
   */
  async tx(fn) {
    // 配额口径边界：只有最外层调用重置，嵌套（command→tx、事务套事务）不会被清零
    this.__beginScope();
    try {
      // makeCtx 也放进 try：它若抛出（极端情况）必须同样归还作用域，
      // 否则 __scopeDepth 永久 >0，之后**所有**调用都不再重置计数，护栏再次哑火。
      const ctx = this.makeCtx();
      const result = await fn(ctx);
      await ctx.__flush();
      return result;
    } finally {
      this.__endScope();
    }
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
      // overlay 只读视图（pipeline 分组读用它判断段内是否有缓冲写的键）
      __pending: pending,
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
      // AUTH_READ 专用：把 session → user 的依赖读取合并为一次 D1 batch。
      // Redis Lua 原子脚本在 D1 解释器里原本会顺序执行两个 SELECT；这里用 JOIN
      // 在同一批次内完成，且先清理过期 session。overlay 命中时回退原读语义。
      async authRead(sessionKey, userPrefix) {
        if (pending.has(sessionKey)) {
          const sessionRow = await readRow(sessionKey);
          if (!sessionRow) return [null, null];
          const session = sessionRow.value;
          let data;
          try { data = JSON.parse(session); } catch { return [session, null]; }
          if (!data || typeof data !== "object" || !data.userId) return [session, null];
          const userRow = await readRow(userPrefix + String(data.userId));
          return [session, userRow ? userRow.value : null];
        }
        const now = nowSec();
        const result = await db.batch([
          db.prepare("DELETE FROM kv WHERE key=? AND expires_at IS NOT NULL AND expires_at<=?").bind(sessionKey, now),
          db.prepare(`SELECT s.value AS session, u.value AS user
            FROM kv AS s
            LEFT JOIN kv AS u
              ON u.key = ? || CASE
                WHEN json_valid(s.value) AND json_extract(s.value,'$.userId') IS NOT NULL
                THEN CAST(json_extract(s.value,'$.userId') AS TEXT)
                ELSE NULL
              END
              AND (u.expires_at IS NULL OR u.expires_at > ?)
            WHERE s.key=? AND (s.expires_at IS NULL OR s.expires_at > ?)
            LIMIT 1`).bind(userPrefix, now, sessionKey, now),
        ]);
        const row = result?.[1]?.results?.[0] || null;
        if (!row) return [null, null];
        const session = row.session;
        let data;
        try { data = JSON.parse(session); } catch { return [session, null]; }
        if (!data || typeof data !== "object" || !data.userId) return [session, null];
        const userKey = userPrefix + String(data.userId);
        if (pending.has(userKey)) {
          const userRow = await readRow(userKey);
          return [session, userRow ? userRow.value : null];
        }
        return [session, row.user ?? null];
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
        const ttl = Math.floor(Number(ttlSeconds));
        // 常规已落库键走单次 D1 batch：先清理已过期同名键，再对仍有效的键更新 TTL。
        // 旧路径是 SELECT + 写入 batch（两次 D1 查询）；滑动会话续期属于高频路径，
        // 直接批量 UPDATE 可减少为一次 D1 batch。若键在当前事务 overlay 中，仍走原逻辑，
        // 保证 pipeline 内先 SET 再 EXPIRE 的读写可见性与顺序语义。
        if (!pending.has(key) && Number.isFinite(ttl) && ttl > 0) {
          const now = nowSec();
          const result = await db.batch([
            db.prepare("DELETE FROM kv WHERE key=? AND expires_at IS NOT NULL AND expires_at<=?").bind(key, now),
            db.prepare("UPDATE kv SET expires_at=? WHERE key=? AND (expires_at IS NULL OR expires_at>?)").bind(now + ttl, key, now),
          ]);
          const changed = result?.[1]?.meta?.changes ?? result?.[1]?.changes ?? 0;
          return Number(changed) > 0 ? 1 : 0;
        }
        const row = await readRow(key);
        if (!row) return 0;
        const expires_at = ttl > 0 ? nowSec() + ttl : null;
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
        // overlay 优先，其余键走 IN 查询。D1 单查询绑定参数上限 100 → 按 90 分块。
        const rest = [];
        const map = new Map();
        for (const k of keys) {
          const p = pending.get(k);
          if (p) map.set(k, p.op === "del" ? null : p.value);
          else rest.push(k);
        }
        const CHUNK = 90;
        for (let i = 0; i < rest.length; i += CHUNK) {
          const chunk = rest.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => "?").join(",");
          const rows = await db.prepare(`SELECT key,value,type,expires_at FROM kv WHERE key IN (${placeholders})`).bind(...chunk).all();
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
        // 注意：D1 的 LIKE 模式上限 50 字节，而本项目键前缀（zp:route:<uuid>:waybills:*）
        // 普遍 58+ 字节——不能用 LIKE。改「最长无通配前缀」做范围扫描（key >= prefix AND key < next），
        // 再用 JS likeTest 按完整 glob 过滤；游标基于过滤前行数，对 "prefix*" 类模式（本项目全部场景）
        // 过滤是恒等变换，分页语义精确。
        let star = 0;
        while (star < pattern.length && pattern[star] !== "*" && pattern[star] !== "?") star++;
        const prefix = pattern.slice(0, star);
        const offset = Math.max(0, parseInt(cursor, 10) || 0);
        let rows;
        if (prefix) {
          const last = prefix.charCodeAt(prefix.length - 1);
          const hi = prefix.slice(0, -1) + String.fromCharCode(last + 1);
          rows = await db
            .prepare("SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ? OFFSET ?")
            .bind(prefix, hi, Number(count) + 1, offset)
            .all();
        } else {
          rows = await db
            .prepare("SELECT key FROM kv ORDER BY key LIMIT ? OFFSET ?")
            .bind(Number(count) + 1, offset)
            .all();
        }
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
        // 非 "prefix*" 模式（含内部通配）在 SQL 层只按前缀截取，这里按完整 glob 精确过滤
        const result = pattern === prefix + "*" || prefix === pattern ? filtered : filtered.filter((k) => likeTest(k, pattern));
        return [nextCursor, result];
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

  /**
   * pipeline：多条命令按序执行，全部写经 batch 原子提交，返回逐条结果数组。
   * D1 适配：每条 SQL 查询都计入 Worker 的查询配额（免费版 50/调用），而业务侧
   * 存在「pipeline 90+ 条 SMEMBERS」的合法用法（历史概览）——逐条执行必然超限。
   * 因此把**连续同类的单键读命令**合并为一次 db.batch()（配额按 1 计），
   * 其余命令仍逐条走 execCommand（写命令的写仍经 overlay 在结束时一次 batch 落库）。
   */
  async pipeline(commands) {
    return this.tx(async (ctx) => {
      const out = new Array(commands.length);
      const READ_SQL = "SELECT key,value,type,expires_at FROM kv WHERE key=? AND (expires_at IS NULL OR expires_at>?)";
      // 连续同类单键读的分组定义：命令名 → 行结果映射
      const GROUPS = {
        GET: (row) => (row ? row.value : null),
        TYPE: (row) => (row ? row.type : "none"),
        EXISTS: (row) => (row ? 1 : 0),
        TTL: (row) => {
          if (!row) return -2;
          if (row.expires_at == null) return -1;
          return Math.max(0, Number(row.expires_at) - nowSec());
        },
        SMEMBERS: (row) => {
          if (!row || row.type !== T_SET) return [];
          try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : []; } catch { return []; }
        },
        SCARD: (row) => {
          if (!row || row.type !== T_SET) return 0;
          try { return JSON.parse(row.value).length; } catch { return 0; }
        },
        HGETALL: (row) => {
          if (!row || row.type !== T_HASH) return [];
          try {
            const obj = JSON.parse(row.value); const flat = [];
            for (const k of Object.keys(obj)) flat.push(k, obj[k]);
            return flat;
          } catch { return []; }
        },
        HLEN: (row) => {
          if (!row || row.type !== T_HASH) return 0;
          try { return Object.keys(JSON.parse(row.value)).length; } catch { return 0; }
        },
        LLEN: (row) => {
          if (!row || row.type !== T_LIST) return 0;
          try { return JSON.parse(row.value).length; } catch { return 0; }
        },
      };
      let i = 0;
      while (i < commands.length) {
        const cmd = String(commands[i][0] || "").toUpperCase();
        // 同类单键读连续段：先看 overlay（段内有缓冲写的键必须逐条回退 execCommand 语义）
        if (GROUPS[cmd] && commands[i].length === 2) {
          let j = i;
          while (j < commands.length && String(commands[j][0] || "").toUpperCase() === cmd && commands[j].length === 2 && !ctx.__pending.has(commands[j][1])) j++;
          if (j === i) { // 段首键在 overlay（本 pipeline 先写后读）：回退逐条语义，保证 i 前进
            out[i] = await this.execCommand(ctx, commands[i], cmd);
            i++;
            continue;
          }
          const keys = commands.slice(i, j).map((c) => String(c[1]));
          const now = nowSec();
          // overlay 命中的键单独取；其余键进一次 batch（配额 1）
          const results = new Array(keys.length);
          const need = [];
          for (let k = 0; k < keys.length; k++) {
            const p = ctx.__pending.get(keys[k]);
            if (p) results[k] = p.op === "del" ? GROUPS[cmd](null) : GROUPS[cmd]({ key: keys[k], value: p.value, type: p.type, expires_at: p.expires_at });
            else need.push(k);
          }
          if (need.length) {
            const stmts = need.map((k) => this.db.prepare(READ_SQL).bind(keys[k], now));
            const resp = await this.db.batch(stmts);
            for (let n = 0; n < need.length; n++) {
              const rows = resp[n]?.results || [];
              results[need[n]] = GROUPS[cmd](rows[0] || null);
            }
          }
          for (let k = 0; k < keys.length; k++) out[i + k] = results[k];
          i = j;
          continue;
        }
        const c = String(commands[i][0] || "").toUpperCase();
        out[i] = await this.execCommand(ctx, commands[i], c);
        i++;
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
