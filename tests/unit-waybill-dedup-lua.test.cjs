/**
 * 运单当日去重（同线路+同日期+同车牌）单元测试
 * ------------------------------------------------------------------
 * 直接加载 process.js 中真实的 Lua 保存脚本（saveScript），用 fengari 在内存里
 * 跑一个 Redis 模拟器，验证「原子去重」语义：
 *   1. 同线路+同日期+同车牌 → 只落一条（无论内容是否因 OCR 抖动/确认而不同）。
 *   2. 车牌不同 / 日期不同 → 各自落一条。
 *   3. 并发双传同车牌 → 后者被复用，不产生第二条。
 *
 * 运行：node tests/unit-waybill-dedup-lua.test.cjs
 * 依赖：fengari（npm i fengari，已 no-save 安装）
 */
const fs = require("fs");
const path = require("path");
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

// 在 fengari 中执行一次 EVAL 语义：准备 KEYS/ARGV 全局，运行脚本，取返回表。
function evalSave(store, keys, argv) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // 注册全局 redis.call
  lua.lua_pushjsfunction(L, makeRedisCall(store));
  lua.lua_setglobal(L, to_luastring("redis_call"));
  // 用 Lua 代码把 redis_call 包成 redis.call
  lauxlib.luaL_dostring(L, to_luastring('redis = { call = redis_call }'));
  // KEYS / ARGV 全局
  const keysLua = "KEYS = {" + keys.map(k => `"${String(k).replace(/"/g, '\\"')}"`).join(",") + "}";
  const argvLua = "ARGV = {" + argv.map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(",") + "}";
  const chunk = `${keysLua}\n${argvLua}\nlocal function __run()\n${SAVE_SCRIPT}\nend\nreturn __run()`;
  const status = lauxlib.luaL_dostring(L, to_luastring(chunk));
  if (status !== lua.LUA_OK) {
    const msg = to_jsstring(lua.lua_tostring(L, -1));
    throw new Error("Lua 执行失败: " + msg);
  }
  // r 是栈顶返回值（表或字符串）
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

// ---- 测试脚手架 ----
const ROUTE = "r-1001";
const DATE = "2026-10-05";
const VEH_A = "京A12345";
const VEH_B = "京B67890";
const FP = "zp:waybill:fingerprint:fp-x";
const BASE = "zp:waybill:";

function keysFor(vehicle, fp) {
  const dedupe = vehicle
    ? `zp:waybill:dedupe:${ROUTE}:${DATE}:${vehicle}`
    : "zp:waybills:noop:" + (fp || FP);
  return [fp || FP, BASE + "${ID}", `zp:route:${ROUTE}:waybills:${DATE}`, dedupe];
}
function buildOrder(id, vehicle, weight) {
  return JSON.stringify({
    id, routeId: ROUTE, date: DATE, vehicle,
    totalWeight: weight, stores: [{ name: "门店A", routeOrder: 1, storeId: "JM001" }],
  });
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ " + label); }
}

function run() {
  // 场景1：同线路+同日期+同车牌，内容一致 → 复用（FINGERPRINT/VEHICLE）
  console.log("场景1：同线路+同日期+同车牌，逐字节一致");
  {
    const store = new MemStore();
    const id1 = "id-1";
    const k = keysFor(VEH_A);
    const r1 = evalSave(store, [k[0], BASE + id1, k[2], k[3]], [id1, buildOrder(id1, VEH_A, 1.2)]);
    assert(JSON.stringify(r1) === JSON.stringify(["NEW", id1]), "首次上传落新单 NEW");
    const r2 = evalSave(store, [k[0], BASE + "id-2", k[2], k[3]], ["id-2", buildOrder("id-2", VEH_A, 1.2)]);
    assert(r2[0] === "FINGERPRINT" || r2[0] === "VEHICLE", "二次上传命中幂等（" + r2[0] + "）");
    assert(r2[1] === id1, "复用首单 id-1，不产生 id-2");
    assert(store.smembers(k[2]).length === 1, "当日索引只有 1 条（无重复落库）");
  }

  // 场景2：同线路+同日期+同车牌，OCR 抖/确认导致内容不同 → 仍只落一条
  console.log("场景2：同线路+同日期+同车牌，内容变化（OCR 抖动/门店确认）");
  {
    const store = new MemStore();
    const id1 = "id-1";
    const k = keysFor(VEH_A);
    evalSave(store, [k[0], BASE + id1, k[2], k[3]], [id1, buildOrder(id1, VEH_A, 1.2)]);
    // 第二次：车牌相同，但重量不同、门店名因 OCR 微变、指纹键也换一个新的
    const fp2 = "zp:waybill:fingerprint:fp-y";
    const k2 = [fp2, BASE + "id-2", k[2], k[3]];
    const order2 = JSON.stringify({
      id: "id-2", routeId: ROUTE, date: DATE, vehicle: VEH_A,
      totalWeight: 1.5,
      stores: [{ name: "门店A(确认)", routeOrder: 1, storeId: "JM001" }],
    });
    const r2 = evalSave(store, k2, ["id-2", order2]);
    assert(r2[0] === "VEHICLE", "按车牌去重命中 VEHICLE（" + r2[0] + "）");
    assert(r2[1] === id1, "复用首单，不新增 id-2");
    assert(store.smembers(k[2]).length === 1, "当日索引仍只有 1 条");
  }

  // 场景3：车牌不同 → 各自落一条
  console.log("场景3：同线路+同日期，车牌不同");
  {
    const store = new MemStore();
    const id1 = "id-1";
    const kA = keysFor(VEH_A);
    evalSave(store, [kA[0], BASE + id1, kA[2], kA[3]], [id1, buildOrder(id1, VEH_A, 1.2)]);
    const id2 = "id-2";
    const kB = keysFor(VEH_B, "zp:waybill:fingerprint:fp-b");
    const r2 = evalSave(store, [kB[0], BASE + id2, kB[2], kB[3]], [id2, buildOrder(id2, VEH_B, 1.2)]);
    assert(r2[0] === "NEW", "不同车牌落新单 NEW");
    assert(store.smembers(kA[2]).length === 2, "当日索引含 2 条（A、B 各一）");
  }

  // 场景4：日期不同 → 各自落一条
  console.log("场景4：同线路+同车牌，日期不同");
  {
    const store = new MemStore();
    const id1 = "id-1";
    const k1 = ["zp:waybill:fingerprint:fp-1", BASE + id1, `zp:route:${ROUTE}:waybills:2026-10-04`, `zp:waybill:dedupe:${ROUTE}:2026-10-04:${VEH_A}`];
    evalSave(store, k1, [id1, buildOrder(id1, VEH_A, 1.2)]);
    const id2 = "id-2";
    const k2 = ["zp:waybill:fingerprint:fp-2", BASE + id2, `zp:route:${ROUTE}:waybills:2026-10-05`, `zp:waybill:dedupe:${ROUTE}:2026-10-05:${VEH_A}`];
    const r2 = evalSave(store, k2, [id2, buildOrder(id2, VEH_A, 1.2)]);
    assert(r2[0] === "NEW", "不同日期落新单 NEW");
  }

  // 场景5：并发双传同车牌（无内容指纹冲突）→ 后者被复用
  console.log("场景5：并发双传同车牌（无指纹键干扰）");
  {
    const store = new MemStore();
    const id1 = "id-1";
    const id2 = "id-2";
    const k1 = ["zp:waybill:fingerprint:fp-1", BASE + id1, `zp:route:${ROUTE}:waybills:${DATE}`, `zp:waybill:dedupe:${ROUTE}:${DATE}:${VEH_A}`];
    const k2 = ["zp:waybill:fingerprint:fp-2", BASE + id2, `zp:route:${ROUTE}:waybills:${DATE}`, `zp:waybill:dedupe:${ROUTE}:${DATE}:${VEH_A}`];
    const r1 = evalSave(store, k1, [id1, buildOrder(id1, VEH_A, 1.2)]);
    const r2 = evalSave(store, k2, [id2, buildOrder(id2, VEH_A, 1.3)]);
    assert(r1[0] === "NEW", "第一次 NEW");
    assert(r2[0] === "VEHICLE" && r2[1] === id1, "第二次并发被车牌去重复用首单");
    assert(store.smembers(`zp:route:${ROUTE}:waybills:${DATE}`).length === 1, "并发后索引仅 1 条");
  }

  // 场景6：车牌缺失 → 退化为指纹幂等，不做车牌聚合（不互相覆盖）
  console.log("场景6：车牌缺失时退化为指纹幂等，不聚合");
  {
    const store = new MemStore();
    const k1 = keysFor("", FP); // 无车牌：noop 键以指纹区分（真实代码以 order.id 区分，均为每单唯一）
    const id1 = "id-1";
    const r1 = evalSave(store, [k1[0], BASE + id1, k1[2], k1[3]], [id1, buildOrder(id1, "", 1.2)]);
    assert(r1[0] === "NEW", "无车牌首单 NEW");
    const id2 = "id-2";
    const fp2 = "zp:waybill:fingerprint:fp-z";
    const k2 = keysFor("", fp2); // 第二次上传使用不同 noop 键，互不聚合
    const r2 = evalSave(store, [k2[0], BASE + id2, k2[2], k2[3]], [id2, buildOrder(id2, "", 1.2)]);
    assert(r2[0] !== "VEHICLE", "无车牌不会被车牌去重聚合");
    assert(r2[0] === "NEW", "无车牌内容不同 → 落新单 NEW（不强行覆盖）");
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
