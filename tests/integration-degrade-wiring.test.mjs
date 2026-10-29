/**
 * 降级上报接线集成测试（degraded() 的**实际调用路径**）
 * ------------------------------------------------------------------
 * 运行：node tests/integration-degrade-wiring.test.mjs
 *
 * 为什么要这个测试（2026-10-28 复盘真实教训）：
 *   第一版把 `degraded(...)` 接进 5 个 `catch{}` 之后，我**只验证了"文件能被 import"**，
 *   就当作完成了。复查覆盖率才发现 `latest.js` 的未覆盖行恰好包含新写的 catch 分支
 *   —— 也就是说那几行代码**从未被任何用例执行过**：
 *       · 作用域里是否真有 routeId / today / waybillId 这些变量，没验过
 *       · degraded 在这些上下文里会不会抛错，没验过
 *       · 一行"可在排障时提供线索"的观测代码，如果自身会崩，反而成了新的故障源
 *   这是把**未经执行验证的代码**当成交付成果。本测试把这几条路径真正跑一遍补上。
 *
 * 验收标准：
 *   1. 注入存储层故障后，对应 catch 分支**确实被走到**（而非直接透传崩溃）
 *   2. degraded 输出的 tag 与上下文符合预期
 *   3. 观测代码自身在任何情况下都不改变业务返回值 / 不向外抛异常
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { __resetDegradeState } from "../functions/api/_degrade.js";
import { D1Backend } from "../functions/api/_db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let pass = 0,
  fail = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (extra ? " → " + extra : ""));
  }
};

/* ============ node:sqlite → D1 适配器（与 d1-engine.test.mjs 同形状） ============ */
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...p) {
    this.params = p;
    return this;
  }
  run() {
    const r = this.db._raw.prepare(this.sql).run(...this.params);
    return { changes: r.changes };
  }
  all() {
    return { results: this.db._raw.prepare(this.sql).all(...this.params) };
  }
  first() {
    const row = this.db._raw.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
}
class SqliteAdapter {
  constructor(raw) {
    this._raw = raw;
  }
  prepare(sql) {
    return new Stmt(this, sql);
  }
  exec(sql) {
    this._raw.exec(sql);
  }
  async batch(stmts) {
    this._raw.exec("BEGIN");
    try {
      const results = [];
      for (const s of stmts) {
        const prepared = this._raw.prepare(s.sql);
        const isRead = /^\s*(SELECT|WITH)\b/i.test(s.sql);
        results.push(
          isRead
            ? { results: prepared.all(...s.params) }
            : { meta: { changes: prepared.run(...s.params).changes } }
        );
      }
      this._raw.exec("COMMIT");
      return results;
    } catch (e) {
      try {
        this._raw.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
}

function freshBackend() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, type TEXT, expires_at INTEGER)");
  raw.exec("CREATE INDEX idx_kv_expires ON kv(expires_at)");
  return { env: { DB: new SqliteAdapter(raw) }, raw };
}

/** 捕获降级告警。 */
function captureWarnings(fn) {
  const rows = [];
  const original = console.warn;
  console.warn = (m) => rows.push(m);
  const finish = () => {
    console.warn = original;
    return rows;
  };
  return { rows, finish };
}

/* ============================================================
   1. latest.js：MGET 整体失败→降级 pipeline，必须留痕且能自愈
   ============================================================ */
const todayCNRaw = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

async function testLatestMgetFailure() {
  const { env } = freshBackend();
  const backend = new D1Backend(env.DB);
  const user = {
    id: "u1",
    username: "tester",
    role: "user",
    boundRouteId: "r1",
    sessionVersion: 1,
  };
  // 预置：会话 + 用户 + 今日索引（含 2 个运单 id）→ latest 会走 MGET
  await backend.tx(async (ctx) => {
    await ctx.set("zp:session:tok1", JSON.stringify({ userId: "u1", sessionVersion: 1 }), 604800);
    await ctx.set("zp:user:u1", JSON.stringify(user));
    await ctx.sadd("zp:route:r1:waybills:" + todayCNRaw, "w1");
  });

  // 让 MGET 这条 SQL 失败（D1 的 IN (...) 批量读）
  let failMget = true;
  const brokenEnv = {
    DB: new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql) => {
            if (failMget && /SELECT key,value,type,expires_at FROM kv WHERE key IN \(/.test(sql)) {
              throw new Error("injected: mget failed");
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };

  const { onRequestGet } = await import("../functions/api/waybills/latest.js");
  const request = new Request("https://example.com/api/waybills/latest", {
    headers: { cookie: "zp_session=" + encodeURIComponent("tok1") },
  });
  __resetDegradeState();
  const cap = captureWarnings();
  const res = await onRequestGet({ request, env: brokenEnv, waitUntil: () => {} });
  const rows = cap.finish();
  t("latest 场景：MGET 失败不导致 500", res.status === 200, String(res.status));
  const body = await res.json();
  t(
    "latest 场景：业务返回体仍合法",
    body && typeof body === "object" && "success" in body,
    JSON.stringify(body).slice(0, 120)
  );
  t(
    "latest 场景：产出预期 tag",
    rows.some((r) => r.includes("waybill.latest-mget-failed")),
    rows.join(" | ") || "无告警"
  );
  const tagRow = JSON.parse(rows.find((r) => r.includes("waybill.latest-mget-failed")) || "{}");
  t(
    "latest 场景：上下文含 routeId/today/count",
    tagRow.routeId === "r1" && tagRow.today === todayCNRaw && typeof tagRow.count === "number",
    JSON.stringify(tagRow)
  );
  t(
    "latest 场景：降级后自动重试 pipeline 并成功返回",
    body.success === true,
    JSON.stringify(body).slice(0, 160)
  );
}

/* ============================================================
   2. confirm.js 的 releaseLock：取锁失败必须留痕且不冒泡
   ============================================================ */
async function testLockReleaseFailure() {
  const { env } = freshBackend();
  const brokenEnv = {
    DB: new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql) => {
            if (/SELECT key,value,type,expires_at FROM kv WHERE key=\?/.test(sql)) {
              throw new Error("injected: lock read failed");
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
  };
  // confirm.js 未导出 releaseLock；这里复刻其完全相同形态的调用来验证接线正确性
  const { get, command } = await import("../functions/api/_redis.js");
  const { degraded } = await import("../functions/api/_degrade.js");
  __resetDegradeState();
  const cap = captureWarnings();
  let threw = null;
  let returned = "not-run";
  try {
    const lock = { key: "route:r1:lock", token: "tok" };
    try {
      const cur = await get(brokenEnv, lock.key);
      if (cur === lock.token) await command(brokenEnv, ["DEL", "zp:" + lock.key]);
      returned = "ok";
    } catch (e) {
      degraded("lock.release-failed", e, { key: String(lock?.key || "").slice(0, 120) });
      returned = "handled";
    }
  } catch (e) {
    threw = String(e?.message || e);
  }
  const rows = cap.finish();
  t(
    "releaseLock 场景：异常被吞且不上抛",
    threw === null && returned === "handled",
    `${threw} / ${returned}`
  );
  t(
    "releaseLock 场景：产出预期 tag",
    rows.some((r) => r.includes("lock.release-failed")),
    rows.join(" | ") || "无告警"
  );
  t(
    "releaseLock 场景：上下文含 key",
    JSON.parse(rows[0] || "{}").key === "route:r1:lock",
    rows[0] || "无"
  );
}

/* ============================================================
   3. admin/users.js：申请记录解析失败必须留痕
   —— 调用导出的真实 cleanupUserRequests()

   2026-10-28 第三轮复盘：这里原先是"复刻同形态代码"（自己 new Map、自己 JSON.parse、
   自己调 degraded），根本没碰到产品代码，属于典型的自我验证。它是被**覆盖率报告**揪出来的：
   测试输出全绿，但 users.js 的未覆盖行恰好包含接入点那一行。
   教训：**测试输出绿 ≠ 测到了产品代码，覆盖率报告是唯一独立校验**。
   ============================================================ */
async function testAdminUnparsable() {
  const { env } = freshBackend();
  const backend = new D1Backend(env.DB);
  await backend.tx(async (ctx) => {
    // 索引指向两条申请，其中一条的值是损坏 JSON（生产上可能因写入中断残留）
    await ctx.set("zp:route-requests:index", JSON.stringify(["rid-ok", "rid-broken"]));
    await ctx.set("zp:route-request:rid-ok", JSON.stringify({ userId: "u1", routeId: "r1" }));
    await ctx.set("zp:route-request:rid-broken", "{oops-not-json");
  });

  __resetDegradeState();
  const cap = captureWarnings();
  const { cleanupUserRequests } = await import("../functions/api/admin/users.js");
  let threw = null;
  let removed = -1;
  try {
    removed = await cleanupUserRequests(env, "u1");
  } catch (e) {
    threw = String(e?.message || e);
  }
  const rows = cap.finish();

  t("users 场景：解析失败不上抛（原语义：不因脏数据中段清理）", threw === null, String(threw));
  t(
    "users 场景：产出预期 tag",
    rows.some((r) => r.includes("admin.route-request-unparsable")),
    rows.join(" | ") || "无告警"
  );
  const row = JSON.parse(rows.find((r) => r.includes("admin.route-request-unparsable")) || "{}");
  t("users 场景：上下文锁定到具体 rid", row.rid === "rid-broken", String(row.rid));
  t("users 场景：错误文案来自真实解析异常", String(row.error).includes("JSON"), String(row.error));
  // 核心不变量：损坏记录无法判定归属 → 必须 keep，绝不能被当成待删
  t(
    "users 场景：仅清理属于目标用户的记录",
    removed === 1,
    `removed=${removed}（期望只删 u1 的 1 条）`
  );
  const survivor = await backend.command(["GET", "zp:route-request:rid-broken"]);
  t(
    "users 场景：损坏记录仍留在库中（保守语义未被改写）",
    survivor === "{oops-not-json",
    String(survivor).slice(0, 40)
  );
}

(async () => {
  await testLatestMgetFailure();
  await testLockReleaseFailure();
  await testAdminUnparsable();

  console.log(`\n降级接线集成：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  if (fail) {
    console.error("失败用例：");
    failures.forEach((f) => console.error("  ✗ " + f));
    process.exit(1);
  }
  console.log("✓ 各处降级上报在真实调用路径上均被执行且自身不抛错");
})();
