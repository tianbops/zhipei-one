// 1.1 可靠性护栏：一致性巡检的**子请求预算**回归（Error 1101 专项）
// ------------------------------------------------------------------
// 背景（2026-10-07 生产事故）：管理员打开 ?check=consistency 得到 Cloudflare
// 「Error 1101 · Worker threw exception」（Ray ID a467df851c6b163f）。
// 根因是这一条路径没跟上诊断列表的改造，仍在做：
//     SCAN zp:waybill:*   （全键空间，稀疏匹配 → 多次往返）
//   + 每个主记录/去重键/指纹键 × GET   ← O(N)
//   + 每个索引键           × SMEMBERS  ← O(N)
// 每条 Redis 调用在生产上都是 1 个子请求，Workers 免费版每请求上限约 50，
// 数据量一上来就爆 —— 而本地测试从来看不见，因为旧版测试替身（MiniRedis）的 SCAN
// 是「一次返回全部」，把成本模型抹平了。本用例做三件事：
//   1. 用**真实游标分页**的 MiniRedis 复现大键空间；
//   2. 对照运行「改造前算法」的等价实现，证明它在同一数据规模下必然爆预算；
//   3. 断言新实现在预算内完成，且预算不足时**显式声明结论不完整**，
//      绝不沉默地返回一个「什么问题都没有」的假绿灯。
// 运行：node tests/integration-consistency-budget.cjs
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

const PLATFORM_LIMIT = 50;      // Workers 免费版每请求子请求上限
const MODULE_LIMIT = 40;        // _consistency.js 自设预算（留 10 给鉴权/日志/响应）

// makeUpstash 已接管 global.fetch；再包一层计数，每个 fetch = 1 次子请求
let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const ROUTES = ["Ra", "Rb", "Rc", "Rd"];
const dayOffsetToDate = n => {
  const d = new Date(Date.UTC(2026, 6, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 造一个「生产形状」的大键空间：主记录 + 事件链 + 日索引 + 历史累积的去重/指纹键 */
function seedScale(waybillCount) {
  for (let r = 0; r < ROUTES.length; r++) {
    red.command(["SET", "zp:route:" + ROUTES[r], JSON.stringify({ id: ROUTES[r], name: "线路" + r, status: "active" })]);
  }
  for (let i = 1; i <= waybillCount; i++) {
    const route = ROUTES[i % ROUTES.length];
    const date = dayOffsetToDate(i % 90);
    const id = "WA" + String(i).padStart(5, "0");
    red.command(["SET", "zp:waybill:" + id, JSON.stringify({
      schemaVersion: "2", id, routeId: route, routeName: "线路", date, vehicle: "粤B" + String(i % 99999).padStart(5, "0"),
      totalWeight: 1.2, stores: [],
      summary: { original: 1, total: 1, matched: 1, pending: 0, correction: 0, merged: 0, newStores: 0 },
      stage: "CONFIRMED", pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
      createdBy: "u1", createdAt: date + "T08:00:00.000Z", businessFingerprint: "FP-" + id
    })]);
    red.command(["RPUSH", "zp:waybill:" + id + ":events", JSON.stringify({ t: date + "T08:00:00.000Z", event: "WAYBILL_CREATED" })]);
    red.command(["SADD", "zp:route:" + route + ":waybills:" + date, id]);
  }
  // 去重键 / 指纹键：每次上传留一份，长期 accumulates（这是 Keyspace 膨胀的主要来源）
  for (let i = 1; i <= 300; i++) {
    red.command(["SET", "zp:waybill:dedupe:sig" + i, "WA" + String(i).padStart(5, "0")]);
    red.command(["SET", "zp:waybill:fingerprint:fpx" + i, "WA" + String(i).padStart(5, "0")]);
  }
  for (let i = 1; i <= 8; i++) red.command(["SET", "zp:waybill:proc:req" + i, JSON.stringify({ stage: "DONE" })]);
  // 与运单无关的键：让 zp:waybill:* / zp:route:*:waybills:* 变成**稀疏模式**，还原真实 SCAN 迭代成本
  for (let i = 1; i <= 150; i++) {
    red.command(["SET", "zp:user:u" + i, JSON.stringify({ id: "u" + i, role: "user" })]);
    red.command(["SET", "zp:session:s" + i, JSON.stringify({ userId: "u" + i })]);
  }
}

/**
 * 改造前（2026-10-06 生产版）算法的等价复刻 —— 仅用于对照计量离职(env 相同)。
 * 全键 SCAN（COUNT 200）+ 逐键 GET + 逐键 SMEMBERS。
 */
async function legacyScanConsistency(env, command) {
  const collect = async pattern => {
    const out = []; let cursor = "0";
    do {
      const r = await command(env, ["SCAN", cursor, "MATCH", pattern, "COUNT", "200"]);
      cursor = String(r?.[0] ?? "0");
      for (const k of Array.isArray(r?.[1]) ? r[1] : []) out.push(String(k));
    } while (cursor !== "0");
    return out;
  };
  const wbKeys = await collect("zp:waybill:*");
  for (const key of wbKeys) await command(env, ["GET", key]);            // ← 逐键读：O(N)
  const indexKeys = await collect("zp:route:*" + ":waybills:*");
  for (const key of indexKeys) await command(env, ["SMEMBERS", key]);    // ← 逐键读：O(N)
  return { waybillKeys: wbKeys.length, indexKeys: indexKeys.length };
}

(async () => {
  const { pathToFileURL } = require("url");
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const redisMod = await import(baseDir + "_redis.js");
  const { scanConsistency } = await import(baseDir + "waybills/_consistency.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };

  const N1 = 400;
  seedScale(N1);
  const totalKeys = red._allKeys().length;
  console.log("【0】键空间：主记录 " + N1 + " 张 + 事件链/索引/去重/指纹/无关键 ≈ " + totalKeys + " 个键");

  console.log("【1】对照：改造前算法在同一规模下的子请求开销");
  subrequests = 0;
  const legacy = await legacyScanConsistency(env, redisMod.command);
  const legacyCost = subrequests;
  console.log("     改造前：SCAN 得到 " + legacy.waybillKeys + " 个运单键 / " + legacy.indexKeys + " 个索引键，" +
    "共 " + legacyCost + " 次子请求");
  check("改造前算法在平台上限内跑不完（必然触发 Error 1101）", legacyCost > PLATFORM_LIMIT,
    "subrequests=" + legacyCost + " > " + PLATFORM_LIMIT);

  console.log("【2】现状：预算受控的新实现");
  subrequests = 0;
  const rep = await scanConsistency(env, { routeId: ROUTES[0] });
  const newCost = subrequests;
  console.log("     新实现：scanned=" + JSON.stringify(rep.scanned) + "，issues=" + rep.summary.total +
    "，budget=" + JSON.stringify(rep.budget));
  check("巡检成功返回，未抛出（不再 1101）", !!rep && Array.isArray(rep.issues));
  check("子请求数 ≤ 模块自设预算 " + MODULE_LIMIT, newCost <= MODULE_LIMIT, "subrequests=" + newCost);
  check("子请求数远低于平台上限 " + PLATFORM_LIMIT, newCost < PLATFORM_LIMIT / 2, "subrequests=" + newCost);
  check("规模 " + N1 + " 张下扫描完整（未降级）", rep.degraded === false, "degraded=" + rep.degraded);
  check("健康数据无不一致误报（仅剩处理票据 info）",
    rep.summary.counts.PROC_TICKET_ORPHAN === 8 && rep.summary.manual === 8,
    JSON.stringify(rep.summary.counts));
  check("相比改造前至少省一个数量级", newCost * 10 <= legacyCost, newCost + " vs " + legacyCost);

  console.log("【3】规模翻倍到 " + (N1 * 2) + " 张：成本不得同比例增长，且如实标注完整性");
  seedScale(N1 * 2);
  subrequests = 0;
  const rep2 = await scanConsistency(env, { routeId: ROUTES[0] });
  const cost2 = subrequests;
  console.log("     键空间 ≈ " + red._allKeys().length + " 个键，issues=" + rep2.summary.total +
    "，budget=" + JSON.stringify(rep2.budget) + "，degraded=" + rep2.degraded);
  check("仍在模块预算内（不会触碰平台硬限）", cost2 <= MODULE_LIMIT, "subrequests=" + cost2);
  check("数据量翻倍，子请求增长 ≤ 2×", cost2 <= Math.max(newCost * 2, newCost + 4), newCost + " → " + cost2);
  check("完整性声明自洽：degraded=false ⟺ 无 SCAN_TRUNCATED 提示项",
    rep2.degraded === rep2.issues.some(i => i.type === "SCAN_TRUNCATED"),
    "degraded=" + rep2.degraded);
  check("无论是否截断，都必须给出结论而不是沉默绿灯",
    typeof rep2.degraded === "boolean" && !!rep2.budget && typeof rep2.budget.used === "number");

  console.log("【4】按线路收窄扫描确实更省（引导运维用 routeId 而非 all）");
  subrequests = 0;
  const repAll = await scanConsistency(env, { all: true });
  const costAll = subrequests;
  subrequests = 0;
  const repScoped = await scanConsistency(env, { routeId: ROUTES[0] });
  const costScoped = subrequests;
  check("限定线路 ≤ 全量扫描成本", costScoped <= costAll, costScoped + " vs " + costAll);
  check("全量扫描同样不超预算", costAll <= MODULE_LIMIT, "subrequests=" + costAll);

  console.log("【5】键空间膨胀到扫描必然截断：必须降级声明，且不得把「没扫到」误报成「数据坏了」");
  // 追加大量无关业务键，使 zp:waybill:* 落在游标分页的尾部、超出 w扫描迭代上限
  for (let i = 1; i <= 9000; i++) red.command(["SET", "zp:cache:k" + i, "v" + i]);
  subrequests = 0;
  const rep3 = await scanConsistency(env, { routeId: ROUTES[0] });
  const types3 = rep3.issues.map(i => i.type);
  console.log("     键空间 ≈ " + red._allKeys().length + " 个键，scanned=" + JSON.stringify(rep3.scanned) +
    "，budget=" + JSON.stringify(rep3.budget) + "，issues=" + JSON.stringify(rep3.summary.counts));
  check("预算耗尽仍在硬限内返回（不触发 Cloudflare Error 1101）", subrequests <= MODULE_LIMIT, "subrequests=" + subrequests);
  check("声明本次结论不完整 degraded=true", rep3.degraded === true, "degraded=" + rep3.degraded);
  check("报告中含 SCAN_TRUNCATED 提示项（运维可见）", types3.includes("SCAN_TRUNCATED"));
  check("未把扫不到的主记录误报为孤儿索引 ORPHAN_INDEX_ENTRY", !types3.includes("ORPHAN_INDEX_ENTRY"));
  check("未误报为缺失索引 MISSING_INDEX_ENTRY", !types3.includes("MISSING_INDEX_ENTRY"));
  check("未误报为孤儿事件链 ORPHAN_EVENT_LIST", !types3.includes("ORPHAN_EVENT_LIST"));
  check("未误报为孤儿去重/指纹键", !types3.includes("ORPHAN_DEDUPE_KEY") && !types3.includes("ORPHAN_FINGERPRINT_KEY"));

  console.log("\nCONSISTENCY_BUDGET 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
