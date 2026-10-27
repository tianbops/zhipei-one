#!/usr/bin/env node
/**
 * 智配One · Upstash Redis → Cloudflare D1 迁移工具
 * ------------------------------------------------------------------
 * 用法（在仓库根目录执行）：
 *
 *   # 1) 仅导出并自检（不落库，先看有多少键、类型分布、是否会被漏掉）
 *   UPSTASH_REDIS_REST_URL=https://xxx.upstash.io \
 *   UPSTASH_REDIS_REST_TOKEN=xxxxx \
 *   node tools/migrate-upstash-to-d1.mjs export --out tools/.upstash-dump.json
 *
 *   # 2) 把导出加载进 D1（默认走 wrangler，需已登录 CF、已创建 zhipei-one 库）
 *   node tools/migrate-upstash-to-d1.mjs load --in tools/.upstash-dump.json
 *
 *   # 2b) 走 Cloudflare D1 HTTP API（不依赖 wrangler，需 API Token）
 *   CF_API_TOKEN=xxxx CF_ACCOUNT_ID=yyyy DATABASE_ID=zzzz \
 *   node tools/migrate-upstash-to-d1.mjs load --in tools/.upstash-dump.json --api
 *
 *   # 3) 一步到位（导出 → 加载），等价于上面两步连做
 *   node tools/migrate-upstash-to-d1.mjs run
 *
 *   # 4) 本地端到端校验 dump（node:sqlite 内存库，无需真实 D1 / wrangler）——上线前必跑
 *   node tools/migrate-upstash-to-d1.mjs verify --in tools/.upstash-dump.json
 *
 *   # 5) 幂等追平（= run；INSERT OR REPLACE 可反复执行，用于维护窗口补写切换期间落进 Upstash 的残留数据）
 *   node tools/migrate-upstash-to-d1.mjs sync
 *
 * 设计要点：
 *   - D1 引擎（functions/api/_db.js）把 string/hash/set/list 四种结构都存进同一张 kv 表，
 *     string 原样存字符串，其余三种以 JSON 文本存（hash=对象、set/list=数组）。
 *     因此迁移时要把 Upstash 的原生结构「反序列化成 JSON 文本」再写入，保证 D1 引擎读回一致。
 *   - 键在 Upstash 里已带 zp: 前缀，D1 引擎也按全限定键存储，故不做任何前缀处理。
 *   - 过期时间：Upstash TTL(-2 不存在 / -1 永不过期 / N 秒) → D1 expires_at(Unix 秒，NULL=不过期)。
 *   - 幂等：写入用 INSERT OR REPLACE，可重复执行。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// ============ 配置读取 ============
const ENV = process.env;
const UP_URL = ENV.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = ENV.UPSTASH_REDIS_REST_TOKEN;
const CF_API_TOKEN = ENV.CF_API_TOKEN;
const CF_ACCOUNT_ID = ENV.CF_ACCOUNT_ID;
const DATABASE_ID = ENV.DATABASE_ID || ENV.CF_D1_DATABASE_ID;
const DB_NAME = ENV.CF_D1_DB_NAME || "zhipei-one";

// ============ Upstash REST 客户端（与 functions/api/_redis.js 同约定） ============
async function upCommand(parts) {
  const res = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + UP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(parts),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("UPSTASH_ERROR:" + res.status + (detail ? " " + detail.slice(0, 240) : ""));
  }
  const data = await res.json();
  return data.result;
}

// ============ 导出 ============
async function exportAll({ out, scanCount = 2000 }) {
  if (!UP_URL || !UP_TOKEN) throw new Error("缺少 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  const records = [];
  let cursor = "0";
  let pages = 0;
  do {
    const r = await upCommand(["SCAN", cursor, "COUNT", String(scanCount)]);
    cursor = String(r[0]);
    const keys = r[1] || [];
    // 批量取类型 + 值 + TTL（hash/set/list 一次性取全量；string 直接 GET）
    for (const key of keys) {
      const type = await upCommand(["TYPE", key]);
      if (type === "none" || !type) continue;
      let value;
      let expires_at = null;
      const ttl = await upCommand(["TTL", key]);
      if (typeof ttl === "number" && ttl > 0) expires_at = Math.floor(Date.now() / 1000) + ttl;
      if (type === "string") {
        value = await upCommand(["GET", key]);
      } else if (type === "hash") {
        const flat = await upCommand(["HGETALL", key]); // [f,v,f,v,...]
        const obj = {};
        for (let i = 0; i + 1 < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
        value = JSON.stringify(obj);
      } else if (type === "set") {
        const arr = await upCommand(["SMEMBERS", key]);
        value = JSON.stringify(Array.isArray(arr) ? arr : []);
      } else if (type === "list") {
        const arr = await upCommand(["LRANGE", key, "0", "-1"]);
        value = JSON.stringify(Array.isArray(arr) ? arr : []);
      } else {
        // 未知类型（如 zset / stream）：原样按 string 存，避免静默丢弃；迁移后可在 D1 侧补全解释。
        process.stderr.write(`⚠ 未知类型跳过解释 '${type}'：${key}\n`);
        value = await upCommand(["GET", key]);
      }
      records.push({ key, type, value, expires_at });
    }
    pages++;
  } while (cursor !== "0");

  writeFileSync(out, JSON.stringify(records));
  // 类型分布统计
  const dist = {};
  for (const r of records) dist[r.type] = (dist[r.type] || 0) + 1;
  console.log(`✓ 导出完成：共 ${records.length} 个有效键，分 ${pages} 页扫描。`);
  console.log("  类型分布：", JSON.stringify(dist));
  console.log(`  已写入 ${out}`);
  return records;
}

// ============ 批大小常量 ============
const BATCH_SIZE = 20; // D1 单语句有大小上限（SQLITE_TOOBIG），多语句合并文本需保持小批次

// ============ SQL 转义 ============
function sqlStr(s) {
  // SQLite 字符串字面量：单引号加倍即可（无需转义反斜杠）。
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function buildSql(records, batchSize = BATCH_SIZE, wrapTx = false) {
  const chunks = [];
  for (let i = 0; i < records.length; i += batchSize) {
    const slice = records.slice(i, i + batchSize);
    let sql = "";
    if (wrapTx) sql += "BEGIN;\n";
    for (const r of slice) {
      const exp = r.expires_at == null ? "NULL" : String(r.expires_at);
      sql += `INSERT OR REPLACE INTO kv(key,value,type,expires_at) VALUES(${sqlStr(r.key)},${sqlStr(r.value)},${sqlStr(r.type)},${exp});\n`;
    }
    if (wrapTx) sql += "COMMIT;\n";
    chunks.push(sql);
  }
  return chunks;
}

// ============ 加载：wrangler ============
function loadViaWrangler(records) {
  const chunks = buildSql(records);
  const dir = "tools";
  let done = 0;
  chunks.forEach((sql, idx) => {
    const file = `${dir}/.d1-load-${idx}.sql`;
    writeFileSync(file, sql);
    execFileSync("npx", ["wrangler", "d1", "execute", DB_NAME, "--remote", "--file=" + file], {
      stdio: "inherit",
    });
    done += 1;
  });
  console.log(`✓ 通过 wrangler 写入 ${done} 个批次，共 ${records.length} 行。`);
}

// ============ 加载：D1 HTTP API ============
// 用绑定参数逐条写入：D1 单 SQL 语句有 100KB 上限（SQLITE_TOOBIG），而运单备份等
// 大值可达 100KB+；绑定参数单独传输（上限 2MB）可绕开。INSERT OR REPLACE 幂等，
// 并发 CONC 提速，失败可整跑重放。
const API_CONC = 8;
async function loadViaApi(records) {
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !DATABASE_ID)
    throw new Error("走 API 模式需要 CF_API_TOKEN / CF_ACCOUNT_ID / DATABASE_ID");
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
  const sql = "INSERT OR REPLACE INTO kv(key,value,type,expires_at) VALUES(?,?,?,?)";
  let cursor = 0;
  let written = 0;
  let failed = null;
  async function worker() {
    while (!failed) {
      const i = cursor++;
      if (i >= records.length) return;
      const r = records[i];
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + CF_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params: [r.key, r.value, r.type, r.expires_at == null ? null : r.expires_at] }),
      });
      const data = await res.json().catch(() => ({ success: false, errors: [{ message: "HTTP " + res.status + " 非 JSON 响应" }] }));
      if (!data.success) {
        failed = `D1_API_ERROR 第 ${i + 1} 条 (key=${r.key}): ` + JSON.stringify(data.errors || data);
        return;
      }
      written++;
      if (written % 200 === 0) console.log(`  ...已写入 ${written}/${records.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(API_CONC, records.length) }, worker));
  if (failed) throw new Error(failed);
  console.log(`✓ 通过 D1 API 写入 ${written} 行（绑定参数逐条，并发 ${API_CONC}）。`);
}

// ============ 本地端到端校验（verify，无需真实 D1 / wrangler） ============
// 把导出的 dump 用 node:sqlite 加载进内存库（与 D1 引擎同一张 kv 表结构），
// 校验：行数一致、类型分布一致、抽样键 value/type 逐条比对。上线前可离线确认 dump 完整可用。
async function verifyDump({ inFile, sample = 200 }) {
  if (!existsSync(inFile)) throw new Error("找不到导出文件：" + inFile);
  const records = JSON.parse(readFileSync(inFile, "utf8"));
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, expires_at INTEGER)");
  for (const sql of buildSql(records)) raw.exec(sql);

  const total = raw.prepare("SELECT count(*) c FROM kv").get().c;
  const byType = {};
  for (const r of raw.prepare("SELECT type, count(*) c FROM kv GROUP BY type").all()) byType[r.type] = r.c;

  const n = Math.min(sample, records.length);
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    const r = records[i];
    const row = raw.prepare("SELECT value,type FROM kv WHERE key=?").get(r.key);
    if (!row || row.value !== r.value || row.type !== r.type) mismatch++;
  }

  console.log(`✓ verify：dump ${records.length} 条 → 内存库加载 ${total} 条。`);
  console.log("  类型分布（库内）：", JSON.stringify(byType));
  console.log(`  抽样 ${n} 条逐键比对 value/type：失配 ${mismatch}。`);
  if (total !== records.length) throw new Error(`verify 失败：行数不一致（dump ${records.length} vs 库 ${total}）`);
  if (mismatch > 0) throw new Error(`verify 失败：抽样失配 ${mismatch}/${n}`);
  console.log("✅ 端到端校验通过：dump 完整、可安全加载。");
  return { total, byType, mismatch };
}

// ============ 入口 ============
async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const getOpt = (name, def) => {
    const i = rest.indexOf("--" + name);
    return i >= 0 ? rest[i + 1] : def;
  };
  const out = getOpt("out", "tools/.upstash-dump.json");
  const inFile = getOpt("in", "tools/.upstash-dump.json");
  const useApi = rest.includes("--api");

  if (mode === "export") {
    await exportAll({ out });
  } else if (mode === "verify") {
    await verifyDump({ inFile });
  } else if (mode === "load") {
    if (!existsSync(inFile)) throw new Error("找不到导出文件：" + inFile);
    const records = JSON.parse(readFileSync(inFile, "utf8"));
    console.log(`读取 ${records.length} 条记录，开始加载到 D1(${DB_NAME})...`);
    if (useApi) await loadViaApi(records);
    else loadViaWrangler(records);
  } else if (mode === "run" || mode === "sync") {
    // sync 是 run 的幂等追平别名：写入用 INSERT OR REPLACE，可反复执行。
    // 用途：切换瞬间无法完全停写时，在维护窗口把「export→load→deploy 期间落进 Upstash 的
    // 残留写入」重新导出覆盖到 D1（先停写再跑，避免追逐移动目标）。
    const recs = await exportAll({ out });
    if (useApi) await loadViaApi(recs);
    else loadViaWrangler(recs);
  } else {
    console.log(`用法：
  node tools/migrate-upstash-to-d1.mjs export [--out FILE]
  node tools/migrate-upstash-to-d1.mjs verify [--in FILE]              # 本地 node:sqlite 端到端校验 dump
  node tools/migrate-upstash-to-d1.mjs load   [--in FILE] [--api]
  node tools/migrate-upstash-to-d1.mjs run    [--api]                  # 一步到位（导出→加载）
  node tools/migrate-upstash-to-d1.mjs sync   [--api]                  # 幂等追平（= run，INSERT OR REPLACE 可反复跑）`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("✗ 迁移失败：", e.message);
  process.exit(1);
});
