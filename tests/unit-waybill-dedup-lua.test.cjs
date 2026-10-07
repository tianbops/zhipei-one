/**
 * 运单当日去重（同线路+同日期+同车辆+门店名称+门店数量+重量）单元测试
 * ------------------------------------------------------------------
 * 直接加载 process.js 中真实的 Lua 保存脚本（saveScript），用 fengari 在内存里
 * 跑一个 Redis 模拟器，验证「原子去重」语义（按业务签名，而非仅车牌）：
 *   业务签名 = 线路 + 日期 + 车辆 + 重量 + 门店名称(归一化排序) + 门店数量
 *   1. 上述维度全部一致（含 PLANNED→CONFIRMED 的易变字段变化）→ 复用，只落一条。
 *   2. 同车辆但门店/重量/数量任一不同 → 视为不同运单（同一车辆可多次出车），各落一条。
 *   3. 不同车辆 / 不同日期 → 各落一条。
 *   4. 并发双传同签名 → 后者被复用，不产生第二条。
 *   5. 历史运单指纹命中（无业务签名键）→ 走 FINGERPRINT 兜底复用。
 *
 * 运行：node tests/unit-waybill-dedup-lua.test.cjs
 * 依赖：fengari（npm i fengari，已 no-save 安装）
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fengari = require("fengari");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const PROCESS_JS = path.join(__dirname, "..", "functions", "api", "waybills", "process.js");
const processSrc = fs.readFileSync(PROCESS_JS, "utf8");
const m = processSrc.match(/const saveScript='([\s\S]*?)';/);
if (!m) {
  console.error("✗ 未能从 process.js 提取 saveScript");
  process.exit(1);
}
const SAVE_SCRIPT = m[1];

// ---- 内存 Redis 模拟器 ----
class MemStore {
  constructor() { this.m = new Map(); }
  call(cmd, args) {
    if (!Array.isArray(args)) args = Array.prototype.slice.call(arguments, 1);
    cmd = String(cmd).toUpperCase();
    if (cmd === "GET") {
      const v = this.m.get(args[0]);
      return v === undefined ? null : v;
    }
    if (cmd === "SET") { this.m.set(args[0], args[1]); return "OK"; }
    if (cmd === "DEL") { for (const k of args) this.m.delete(k); return args.length; }
    if (cmd === "SADD") {
      const key = args[0];
      const cur = this.m.get(key);
      const set = new Set(cur ? JSON.parse(cur) : []);
      let added = 0;
      for (let i = 1; i < args.length; i++) {
        if (!set.has(args[i])) { set.add(args[i]); added++; }
      }
      this.m.set(key, JSON.stringify([...set]));
      return added;
    }
    throw new Error("MemStore 不支持命令: " + cmd);
  }
  smembers(key) {
    const cur = this.m.get(key);
    return cur ? JSON.parse(cur) : [];
  }
}

function makeRedisCall(store) {
  return function (L) {
    const n = lua.lua_gettop(L);
    const args = [];
    for (let i = 1; i <= n; i++) {
      const t = lua.lua_type(L, i);
      if (t === lua.LUA_TSTRING) args.push(to_jsstring(lua.lua_tostring(L, i)));
      else if (t === lua.LUA_TNUMBER) args.push(lua.lua_tonumber(L, i));
      else args.push(undefined);
    }
    const res = store.call(args[0], args.slice(1));
    if (res === null || res === undefined) lua.lua_pushnil(L);
    else if (Array.isArray(res)) {
      lua.lua_createtable(L, res.length, 0);
      res.forEach((v, i) => { lua.lua_pushstring(L, to_luastring(String(v))); lua.lua_rawseti(L, -2, i + 1); });
    } else if (typeof res === "number") lua.lua_pushnumber(L, res);
    else lua.lua_pushstring(L, to_luastring(String(res)));
    return 1;
  };
}

function evalSave(store, keys, argv) {
  // 与生产 saveWaybill 对齐：新主记录固化 dailyDedupeKey / businessFingerprint，
  // 让 Lua 能验证反向键身份；测试调用仍保持 [id, json] 简洁形式。
  let order = JSON.parse(argv[1]);
  order.dailyDedupeKey = String(keys[3]).replace(/^zp:waybill:dedupe:/, "");
  order.businessFingerprint = String(keys[0]).replace(/^zp:waybill:fingerprint:/, "").replace(/^zp:waybill:fingerprint:/, "");
  argv = [argv[0], JSON.stringify(order), order.dailyDedupeKey, order.businessFingerprint];
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_pushjsfunction(L, makeRedisCall(store));
  lua.lua_setglobal(L, to_luastring("redis_call"));
  lauxlib.luaL_dostring(L, to_luastring('redis = { call = redis_call }'));
  // fengari 不内置 Redis 的 cjson；生产 Redis Lua 环境提供 cjson.decode。
  // 这里为真实 saveScript 提供等价的最小字段解码能力，保持测试运行时与生产脚本一致。
  const cjsonShim = 'cjson = { decode = function(s) ' +
    'local d = s:match(\'"dailyDedupeKey"%s*:%s*"([^"]*)"\'); ' +
    'local f = s:match(\'"businessFingerprint"%s*:%s*"([^"]*)"\'); ' +
    'if not d and not f then error("invalid test json") end; ' +
    'return { dailyDedupeKey = d, businessFingerprint = f } end }';
  lauxlib.luaL_dostring(L, to_luastring(cjsonShim));
  const keysLua = "KEYS = {" + keys.map(k => `"${String(k).replace(/"/g, '\\"')}"`).join(",") + "}";
  const argvLua = "ARGV = {" + argv.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(",") + "}";
  const chunk = `${keysLua}\n${argvLua}\nlocal function __run()\n${SAVE_SCRIPT}\nend\nreturn __run()`;
  const status = lauxlib.luaL_dostring(L, to_luastring(chunk));
  if (status !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error("Lua 执行失败: " + msg);
  }
  const t = lua.lua_type(L, -1);
  if (t === lua.LUA_TTABLE) {
    const out = [];
    let i = 1;
    while (true) {
      lua.lua_rawgeti(L, -1, i);
      const tt = lua.lua_type(L, -1);
      if (tt === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
      out.push(to_jsstring(lua.lua_tostring(L, -1)));
      lua.lua_pop(L, 1);
      i++;
    }
    return out;
  }
  if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, -1));
  if (t === lua.LUA_TNIL) return null;
  return undefined;
}

// ---- 业务签名（镜像 _waybill-identity.js 的 dailySignature + sha256）----
const ROUTE = "r-1001";
const DATE = "2026-10-05";
const VEH_A = "京A12345";
const VEH_B = "京B67890";
const BASE = "zp:waybill:";

function sigString(order) {
  const stores = Array.isArray(order.stores) ? order.stores : [];
  const names = stores.map(s => String(s.name ?? "").trim()).filter(Boolean).sort();
  return JSON.stringify({
    routeId: String(order.routeId ?? "").trim(),
    date: String(order.date ?? "").trim(),
    vehicle: String(order.vehicle ?? "").trim(),
    totalWeight: order.totalWeight == null ? null : Number(order.totalWeight),
    storeCount: names.length,
    storeNames: names,
  });
}
function sigKey(order) {
  return "zp:waybill:dedupe:" + crypto.createHash("sha256").update(sigString(order)).digest("hex");
}
// 内容指纹键（镜像 _waybill-identity.js 的 businessFingerprint / canonicalWaybill）
function fpKey(order) {
  const stores = (Array.isArray(order.stores) ? order.stores : []).map(s => ({
    storeId: String(s.storeId ?? "").trim() || null,
    name: String(s.name ?? "").trim(),
    routeOrder: Number.isFinite(Number(s.routeOrder)) ? Number(s.routeOrder) : null,
    pending: !!s.pending,
  }));
  const canonical = JSON.stringify({
    routeId: String(order.routeId ?? "").trim(),
    date: String(order.date ?? "").trim(),
    vehicle: String(order.vehicle ?? "").trim(),
    totalWeight: order.totalWeight == null ? null : Number(order.totalWeight),
    stores,
  });
  return "zp:waybill:fingerprint:" + crypto.createHash("sha256").update(canonical).digest("hex");
}
function keysFor(order) {
  return [fpKey(order), BASE + order.id, `zp:route:${ROUTE}:waybills:${order.date}`, sigKey(order)];
}
function buildOrder(id, opt) {
  return {
    id, routeId: ROUTE, date: DATE,
    vehicle: opt.vehicle ?? "",
    totalWeight: opt.weight,
    stores: opt.stores.map(s => ({ name: s.name, storeId: s.storeId ?? null, pending: !!s.pending })),
  };
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ " + label); }
}

function run() {
  // 场景1：全维度一致（逐字节一致）→ 复用 DAILY
  console.log("场景1：线路+日期+车辆+门店+数量+重量 完全一致");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    const k = keysFor(o1);
    const r1 = evalSave(store, k, [o1.id, JSON.stringify(o1)]);
    assert(JSON.stringify(r1) === JSON.stringify(["NEW", o1.id]), "首次上传落新单 NEW");
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "DAILY", "同签名命中复用 DAILY（" + r2[0] + "）");
    assert(r2[1] === "id-1", "复用首单 id-1，不产生 id-2");
    assert(store.smembers(`zp:route:${ROUTE}:waybills:${DATE}`).length === 1, "当日索引只有 1 条");
  }

  // 场景2：同车辆+同门店+同数量+同重量，但 PLANNED→CONFIRMED（易变字段变化）→ 仍复用
  console.log("场景2：同一趟 PLANNED→CONFIRMED（storeId/pending 变化，业务签名不变）");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A", pending: true }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A", storeId: "JM001", pending: false }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "DAILY" && r2[1] === "id-1", "忽略易变字段，复用首单（同一趟）");
    assert(store.smembers(`zp:route:${ROUTE}:waybills:${DATE}`).length === 1, "索引仍仅 1 条");
  }

  // 场景3：同车辆，门店名不同 → 不同运单（另一趟）
  console.log("场景3：同车辆，门店名不同 → 不同运单");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店B" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "NEW", "门店不同 → 落新单 NEW（同车多趟）");
    assert(store.smembers(`zp:route:${ROUTE}:waybills:${DATE}`).length === 2, "索引含 2 条");
  }

  // 场景4：同车辆，重量不同 → 不同运单
  console.log("场景4：同车辆，重量不同 → 不同运单");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.5, stores: [{ name: "门店A" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "NEW", "重量不同 → 落新单 NEW");
  }

  // 场景5：同车辆，门店数量不同 → 不同运单
  console.log("场景5：同车辆，门店数量不同 → 不同运单");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }, { name: "门店B" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "NEW", "门店数量不同 → 落新单 NEW");
  }

  // 场景6：不同车辆，其余相同 → 不同运单
  console.log("场景6：不同车辆，其余相同 → 不同运单");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_B, weight: 1.2, stores: [{ name: "门店A" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "NEW", "不同车辆 → 落新单 NEW");
  }

  // 场景7：不同日期，其余相同 → 不同运单
  console.log("场景7：不同日期，其余相同 → 不同运单");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    o2.date = "2026-10-04";
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "NEW", "不同日期 → 落新单 NEW");
  }

  // 场景8：并发双传同签名 → 后者被复用
  console.log("场景8：并发双传同签名（无指纹键干扰）");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    const r1 = evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r1[0] === "NEW", "第一次 NEW");
    assert(r2[0] === "DAILY" && r2[1] === "id-1", "并发被业务签名去重复用首单");
    assert(store.smembers(`zp:route:${ROUTE}:waybills:${DATE}`).length === 1, "并发后索引仅 1 条");
  }

  // 场景9：无车牌，同门店+同重量 → 仍按内容签名复用（不互相覆盖不同内容）
  console.log("场景9：无车牌，按门店+重量签名去重");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: "", weight: 1.2, stores: [{ name: "门店A" }] });
    evalSave(store, keysFor(o1), [o1.id, JSON.stringify(o1)]);
    const o2 = buildOrder("id-2", { vehicle: "", weight: 1.2, stores: [{ name: "门店A" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "DAILY" && r2[1] === "id-1", "无车牌同内容 → 复用");
    const o3 = buildOrder("id-3", { vehicle: "", weight: 2.0, stores: [{ name: "门店A" }] });
    const r3 = evalSave(store, keysFor(o3), [o3.id, JSON.stringify(o3)]);
    assert(r3[0] === "NEW", "无车牌但重量不同 → 落新单（不聚合）");
  }

  // 场景10：历史运单仅命中内容指纹（无业务签名键）→ FINGERPRINT 兜底复用
  console.log("场景10：历史仅指纹命中 → FINGERPRINT 兜底");
  {
    const store = new MemStore();
    const o1 = buildOrder("id-1", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    // 预置指纹键（历史行为）+ 运单主记录，但不写业务签名键
    store.call("SET", fpKey(o1), "id-1");
    store.call("SET", BASE + "id-1", JSON.stringify(o1));
    store.call("SADD", `zp:route:${ROUTE}:waybills:${DATE}`, "id-1");
    const o2 = buildOrder("id-2", { vehicle: VEH_A, weight: 1.2, stores: [{ name: "门店A" }] });
    const r2 = evalSave(store, keysFor(o2), [o2.id, JSON.stringify(o2)]);
    assert(r2[0] === "FINGERPRINT" && r2[1] === "id-1", "无签名键时走指纹兜底复用");
  }
}

try {
  run();
} catch (e) {
  failed++;
  console.error("运行异常:", e);
}
console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
