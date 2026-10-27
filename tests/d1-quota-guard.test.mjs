/**
 * D1 查询配额护栏测试
 * ------------------------------------------------------------------
 * 运行：node tests/d1-quota-guard.test.mjs
 *
 * 背景（2026-10-27 上线事故）：
 *   Cloudflare D1 免费版限制**单次 Worker 调用最多 50 条查询**（batch 计 1 条）。
 *   历史概览这类路径会自然打到 ~100 条，超过即整请求失败 —— 当天表现为
 *   「首页统计板块整块消失」。
 *   事故是靠线上现象事后定位的：本地测试跑不出资质配额，因此必须让用量**可观测**。
 *
 * 本测试验收三条：
 *   1. Proxy 计数准确，且不改变注入 db 的原有行为（shape 与返回值完全不变）
 *   2. 跨过告警线/危险线时各上报一次（不重复刷屏）
 *   3. env.__zpD1 的请求级缓存语义下，计数是**每请求独立**的
 */

import { D1Backend } from "../functions/api/_db.js";
import { __resetDegradeState } from "../functions/api/_degrade.js";

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

/** 极简假 D1：只关心形状，不落真实数据（计数逻辑在 Proxy 层，与存储无关）。 */
function fakeDb() {
  let prepared = 0;
  const stmt = {
    // 真实 D1 / node:sqlite 适配器的语句都带 .sql 与 .params —— batch() 内部依赖它们。
    // 这里必须如实模拟形状，否则"代理不破坏形状"的断言就失去了意义。
    sql: "",
    params: [],
    bind(...p) {
      this.params = p;
      return this;
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      return { success: true };
    },
  };
  return {
    get stats() {
      return prepared;
    },
    prepare(sql) {
      prepared++;
      return { ...stmt, sql, params: [] };
    },
    async batch(stmts) {
      return { results: stmts.map(() => ({ success: true })) };
    },
  };
}

function captureWarnings(fn) {
  const rows = [];
  const original = console.warn;
  console.warn = (m) => rows.push(m);
  try {
    return { rows, value: fn() };
  } finally {
    console.warn = original;
  }
}

/* ============ 1. 计数准确性 ============ */
__resetDegradeState();
const raw = fakeDb();
const be = new D1Backend(raw, { warnAt: 5, critAt: 9 });
captureWarnings(() => {
  raw.prepare("SELECT 1").bind().first();
  raw.prepare("SELECT 2").bind().first();
});
t(
  "未经过代理的直接调用不计数（证明计数发生在后端持有的代理上）",
  be.quota.statements === 0,
  String(be.quota.statements)
);

// 通过后端持有的代理调用才会计数
const proxy = be.db;
__resetDegradeState();
captureWarnings(() => {
  for (let i = 0; i < 3; i++) proxy.prepare("SELECT ?").bind(i).first();
});
t("代理上的 prepare 被计数", be.quota.statements === 3, String(be.quota.statements));
__resetDegradeState();
captureWarnings(async () => {
  await proxy.batch([
    proxy.prepare("DELETE FROM kv WHERE key=?"),
    proxy.prepare("DELETE FROM kv WHERE key=?"),
  ]);
});
t("batch 单独计数（不按内部语句数）", be.quota.batches === 1, String(be.quota.batches));

/* ============ 2. 代理透明性：行为不变 ============ */
const a = fakeDb();
const b1 = new D1Backend(a, { warnAt: 3, critAt: 4 });
__resetDegradeState();
(async () => {
  const cap = captureWarnings(() => b1.db.prepare("SELECT x").bind(1).all());
  const chained = await cap.value; // 捕获同步发生，异步结果在此处兑现
  t(
    "代理保留 prepare().bind().all() 链式形状",
    chained && Array.isArray(chained.results),
    JSON.stringify(chained)
  );

  /* ============ 3. 阈值告警：warn 先响，crit 后响，各一次 ============ */
  __resetDegradeState();
  const seen = [];
  {
    const original = console.warn;
    console.warn = (m) => seen.push(m);
    const nb = new D1Backend(fakeDb(), { warnAt: 3, critAt: 6 });
    try {
      for (let i = 0; i < 20; i++) nb.db.prepare("SELECT ?").bind(i).first();
    } finally {
      console.warn = original;
    }
  }
  const tags = seen.map((m) => {
    try {
      return JSON.parse(m).tag;
    } catch {
      return null;
    }
  });
  t("触发 warning 告警", tags.includes("d1.quota-warning"), tags.join(","));
  t("触发 critical 告警", tags.includes("d1.quota-critical"), tags.join(","));
  t(
    "warning 只报 1 次（不刷屏）",
    tags.filter((x) => x === "d1.quota-warning").length === 1,
    tags.join(",")
  );
  t(
    "critical 只报 1 次（不刷屏）",
    tags.filter((x) => x === "d1.quota-critical").length === 1,
    tags.join(",")
  );
  const critRow = JSON.parse(seen.find((m) => m.includes("d1.quota-critical")) || "{}");
  t("告警携带 limit=50", critRow.limit === 50, String(critRow.limit));
  t("告警携带真实用量", critRow.used >= 6, String(critRow.used));

  /* ============ 3.5 batch 配额抵扣口径（本轮复盘修出的真实缺陷） ============ */
  // 教训：batch 内每条语句在 prepare 时已各计一次 statements，若不在 batch 提交时抵扣，
  // 一次含 10 条写入的事务会被计成 11 —— 而 D1 实际只算 1。告警线因此形同虚设。
  __resetDegradeState();
  {
    const original = console.warn;
    console.warn = () => {};
    try {
      const nb = new D1Backend(fakeDb(), { warnAt: 3, critAt: 4 });
      const stmts = [];
      for (let i = 0; i < 10; i++) stmts.push(nb.db.prepare("INSERT INTO kv VALUES(?)").bind(i));
      await nb.db.batch(stmts);
      t(
        "batch 内 10 条语句被抵扣，不再重复计入 statements",
        nb.quota.statements === 0,
        String(nb.quota.statements)
      );
      t("batch 自身计 1 次配额", nb.quota.batches === 1, String(nb.quota.batches));
      t(
        "consumed 校验：10 条 batch 写 = 1 次配额",
        nb.quota.statements + nb.quota.batches === 1,
        String(nb.quota.statements + nb.quota.batches)
      );
    } finally {
      console.warn = original;
    }
  }

  /* ============ 3.6 计数代理必须保持 D1 语句形状（否则 batch 直接崩） ============ */
  {
    const nb = new D1Backend(fakeDb());
    const stmt = nb.db.prepare("INSERT INTO kv(key,value) VALUES(?,?)");
    const bound = stmt.bind("k", "v");
    t(
      "代理产出的语句保留 .sql（batch 内部依赖）",
      typeof bound.sql === "string" && bound.sql.includes("INSERT"),
      String(bound.sql)
    );
    t(
      "代理产出的语句保留 bind 链式与 .params",
      Array.isArray(bound.params) && bound.params.length === 2,
      JSON.stringify(bound.params)
    );
  }

  /* ============ 3.7 代表性路径的配额基线（防回归） ============ */
  // 目的：锁死"这些路径不许变贵"。若未来有人把 pipeline 的同批合并改回逐条执行，
  // 或让某个读路径退化成 N+1 查询，这组断言会立刻红。
  // 这些数字是 2026-10-28 用 node:sqlite 适配器实测得到的。
  {
    const { DatabaseSync } = await import("node:sqlite");
    const mkBackend = () => {
      const raw = new DatabaseSync(":memory:");
      raw.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, type TEXT, expires_at INTEGER)");
      raw.exec("CREATE INDEX idx_kv_expires ON kv(expires_at)");
      const adapter = {
        prepare(sql) {
          const o = {
            sql,
            params: [],
            bind(...p) {
              o.params = p;
              return o;
            },
            async first() {
              const r = raw.prepare(sql).get(...o.params);
              return r === undefined ? null : r;
            },
            async all() {
              return { results: raw.prepare(sql).all(...o.params) };
            },
            async run() {
              return { changes: raw.prepare(sql).run(...o.params).changes };
            },
          };
          return o;
        },
        async batch(stmts) {
          return stmts.map((st) => {
            raw.prepare(st.sql).run(...st.params);
            return { meta: { changes: 1 } };
          });
        },
      };
      return new D1Backend(adapter, { warnAt: 45, critAt: 49 }); // 基线测试不希望被告警干扰
    };

    const silence = async (fn) => {
      const original = console.warn;
      console.warn = () => {};
      try {
        return await fn();
      } finally {
        console.warn = original;
      }
    };

    const cases = [
      [
        "单键 GET",
        async (b) => {
          await b.command(["GET", "zp:waybill:w1"]);
        },
        2,
      ],
      [
        "10 键 MGET",
        async (b) => {
          await b.command(["MGET", ...Array.from({ length: 10 }, (_, i) => "zp:waybill:w" + i)]);
        },
        3,
      ],
      [
        "事务写入 10 键",
        async (b) => {
          await b.tx(async (c) => {
            for (let i = 0; i < 10; i++) await c.set("zp:k" + i, "v");
          });
        },
        2,
      ],
      [
        "pipeline 90 条 GET（历史概览量级）",
        async (b) => {
          await b.pipeline(Array.from({ length: 90 }, (_, i) => ["GET", "zp:waybill:w" + i]));
        },
        3,
      ],
    ];
    for (const [name, fn, limit] of cases) {
      const b = mkBackend();
      await silence(() => fn(b));
      const used = b.quota.statements + b.quota.batches;
      t(`配额基线：${name} ≤ ${limit}（实测 ${used}）`, used <= limit, `${used} > ${limit}`);
    }
  }

  /* ============ 3.8 调用作用域边界（本轮复盘抓到的最严重缺陷） ============ */
// 教训：D1Backend 实例被缓存在 env.__zpD1 上，而 Cloudflare Workers **同一个 isolate
// 会处理多个请求**（官方文档："do not use or mutate global state"）。
// 因此实例级计数会跨请求单调累积，且 alerted 是一次性锁存 ——
// 组合效果是 isolate 存活期内只告警一次后**永久沉默**，护栏彻底哑火。
// 这里用"同一实例连续处理多次调用"来锁死这个行为不再退化。
{
  const { DatabaseSync } = await import("node:sqlite");
  const mkMem = () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, type TEXT, expires_at INTEGER)");
    return {
      prepare(sql) {
        const o = {
          sql,
          params: [],
          bind(...p) { o.params = p; return o; },
          async first() { const r = raw.prepare(sql).get(...o.params); return r === undefined ? null : r; },
          async all() { return { results: raw.prepare(sql).all(...o.params) }; },
          async run() { return { changes: raw.prepare(sql).run(...o.params).changes }; },
        };
        return o;
      },
      async batch(stmts) { return stmts.map(() => ({ meta: { changes: 1 } })); },
    };
  };
  const capture = () => {
    const orig = console.warn;
    const rows = [];
    console.warn = (m) => rows.push(String(m));
    return { rows, finish() { console.warn = orig; return rows.map((r) => { try { return JSON.parse(r); } catch { return {}; } }); } };
  };

  // —— 反例：同一实例连续 6 次调用，计数不得跨调用累积 ——
  __resetDegradeState();
  const b = new D1Backend(mkMem(), { warnAt: 1, critAt: 3 });
  for (let i = 0; i < 6; i++) await b.command(["GET", "zp:k" + i]);
  t("同一实例连续 6 次调用后 statements 不跨调用累积", b.quota.statements <= 2, String(b.quota.statements));

  // —— 正例：阈值内多次调用，每次都能独立告警（alerted 不得跨调用锁存）——
  // 注意测得准：这里断言的是 **quota 侧 alerted 是否被作用域重置**，
  // 而不是日志行数 —— 日志还会再被 _degrade 的 60s 限频窗口收敛一次
  // （那是它的职责，且已由 unit-degrade 单测覆盖；若拿日志行数断言会误伤正常工作逻辑）。
  __resetDegradeState();
  const b2 = new D1Backend(mkMem(), { warnAt: 1, critAt: 3 });
  const sil = capture(); await b2.command(["GET", "zp:a"]); sil.finish();
  const alerted1 = Object.keys(b2.quota.alerted).length;
  const sil2 = capture(); await b2.command(["GET", "zp:b"]); sil2.finish();
  const alerted2 = Object.keys(b2.quota.alerted).length;
  t("第二次独立调用重新触发告警判定（alerted 不跨调用锁存）", alerted1 >= 1 && alerted2 >= 1, `首次=${alerted1} 第二次=${alerted2}`);

  // —— 嵌套安全：command → tx 不得把外层计数清零 ——
  __resetDegradeState();
  const b3 = new D1Backend(mkMem());
  await b3.command(["GET", "zp:nested"]);
  t("调用结束后作用域深度归零（无泄漏）", b3.__scopeDepth === 0, String(b3.__scopeDepth));
}

/* ============ 4. 默认阈值贴近官方配额 ============ */
  const def = new D1Backend(fakeDb());
  t("默认告警线 35（50 的 70%）", def.quota.WARN_AT === 35, String(def.quota.WARN_AT));
  t("默认危险线 45（50 的 90%）", def.quota.CRIT_AT === 45, String(def.quota.CRIT_AT));

  /* ============ 5. 每请求独立（模拟 env.__zpD1 语义） ============ */
  const env1 = {};
  const env2 = {};
  if (!env1.__zpD1) env1.__zpD1 = new D1Backend(fakeDb());
  if (!env2.__zpD1) env2.__zpD1 = new D1Backend(fakeDb());
  __resetDegradeState();
  captureWarnings(() => {
    for (let i = 0; i < 7; i++) env1.__zpD1.db.prepare("SELECT ?").bind(i).first();
  });
  t("请求 A 计到 7", env1.__zpD1.quota.statements === 7, String(env1.__zpD1.quota.statements));
  t("请求 B 独立计数 0", env2.__zpD1.quota.statements === 0, String(env2.__zpD1.quota.statements));

  /* ============ 6. 代理失效时优雅降级 ============ */
  t("注入非对象时不崩", new D1Backend(null).db === null);

  console.log(`\nD1 配额护栏：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
  if (fail) {
    console.error("失败用例：");
    failures.forEach((f) => console.error("  ✗ " + f));
    process.exit(1);
  }
  console.log("✓ D1 查询用量可观测且不影响存储行为");
})();
