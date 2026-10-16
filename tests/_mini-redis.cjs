// 内存版 Redis + fengari Lua 执行引擎，用于在 Node 中真实运行智配One 的
// Cloudflare Pages Functions（process/confirm/latest/history 等），
// 通过拦截 global.fetch 的 Upstash REST 协议接管 _redis.js。
// 仅用于本地全链路回归，不接触任何线上资源。
const path = require("path");
const fengari = require("fengari");
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

// ---------- Lua <-> JS 值转换 ----------
function pushLuaValue(L, val) {
  if (val === null || val === undefined) { lua.lua_pushnil(L); return; }
  if (typeof val === "string") { lua.lua_pushstring(L, to_luastring(val)); return; }
  if (typeof val === "number") { lua.lua_pushnumber(L, val); return; }
  if (typeof val === "boolean") { lua.lua_pushboolean(L, val ? 1 : 0); return; }
  if (Array.isArray(val)) {
    lua.lua_createtable(L, val.length, 0);
    for (let i = 0; i < val.length; i++) { pushLuaValue(L, val[i]); lua.lua_rawseti(L, -2, i + 1); }
    return;
  }
  if (typeof val === "object") {
    const keys = Object.keys(val);
    lua.lua_createtable(L, 0, keys.length);
    for (const k of keys) { pushLuaValue(L, val[k]); lua.lua_setfield(L, -2, to_luastring(String(k))); }
    return;
  }
  lua.lua_pushnil(L);
}

function toJsValue(L, idx, seen) {
  const t = lua.lua_type(L, idx);
  if (t === lua.LUA_TNIL) return null;
  if (t === lua.LUA_TBOOLEAN) return !!lua.lua_toboolean(L, idx);
  if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, idx));
  if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
  if (t === lua.LUA_TTABLE) {
    seen = seen || new Set();
    if (seen.has(idx)) return null;
    seen.add(idx);
    // 先探测是否为连续数组（1..n）
    const arr = [];
    let i = 1;
    while (true) {
      lua.lua_rawgeti(L, idx, i);
      const tt = lua.lua_type(L, -1);
      if (tt === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
      arr.push(toJsValue(L, -1, seen));
      lua.lua_pop(L, 1);
      i++;
    }
    if (arr.length > 0) return arr;
    // 否则作为对象（字符串键）
    const obj = {};
    lua.lua_pushnil(L);
    while (lua.lua_next(L, idx)) {
      const k = to_jsstring(lua.lua_tostring(L, -2));
      obj[k] = toJsValue(L, -1, seen);
      lua.lua_pop(L, 1);
    }
    return obj;
  }
  return null;
}

// ---------- 内存 Redis ----------
class MiniRedis {
  constructor() {
    this.strings = new Map(); // key -> string
    this.sets = new Map();    // key -> Set<string>
    this.hashes = new Map();  // key -> Map<string,string>
    this.lists = new Map();   // key -> string[]
    this.expiries = new Map();// key -> 过期时间戳(ms)，P2-11 session TTL 用
    this.clockOffset = 0;     // 测试可推进的假时钟(ms)，避免真等
  }
  now() { return Date.now() + this.clockOffset; }
  advance(ms) { this.clockOffset += Number(ms) || 0; return this.now(); }
  _expireIfDue(k) {
    const e = this.expiries.get(k);
    if (e !== undefined && this.now() >= e) { this.expiries.delete(k); this.strings.delete(k); this.sets.delete(k); this.hashes.delete(k); this.lists.delete(k); }
  }
  /** 键是否「当前存在」：已过期视为不存在（真实 Redis 惰性过期后的观测结果） */
  _alive(k) { this._expireIfDue(k); return this.strings.has(k) || this.sets.has(k) || this.hashes.has(k) || this.lists.has(k); }
  _get(k) { return this.strings.has(k) ? this.strings.get(k) : null; }
  _set(k, v) { this.strings.set(k, String(v)); return "OK"; }
  _allKeys() {
    for (const k of [...this.expiries.keys()]) this._expireIfDue(k);
    const set = new Set([...this.strings.keys(), ...this.sets.keys(), ...this.hashes.keys(), ...this.lists.keys()]);
    return [...set].sort();
  }
  _scanKeys(pattern) {
    const out = [];
    const p = pattern.replace(/[-/\\^$+?.()|{}]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp("^" + p + "$");
    for (const k of this._allKeys()) { if (re.test(k)) out.push(k); }
    return out;
  }
  /**
   * 真实 Redis SCAN 语义：游标 + COUNT 分页。
   * 每次调用只在 keyspace 上前进 COUNT 个「槽位」，返回其中匹配 pattern 的键——
   * 因此「keyspace 大 + pattern 稀疏」时必然产生**多次往返**，每次往返在生产上就是 1 个子请求。
   * 旧实现（一次返回全部）掩盖了这类成本，导致 2026-10-07 的 Error 1101 在本地测试里完全测不出来。
   */
  _scan(cursor, pattern, count) {
    const p = String(pattern ?? "*").replace(/[-/\\^$+?.()|{}]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp("^" + p + "$");
    const all = this._allKeys();
    const step = Math.max(1, Number(count) || 10);
    let start = Number(cursor) || 0;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (start >= all.length) return ["0", []];       // 键可能已被删除，游标越过末尾即结束
    const end = Math.min(start + step, all.length);
    const matched = [];
    for (let i = start; i < end; i++) if (re.test(all[i])) matched.push(all[i]);
    return [end >= all.length ? "0" : String(end), matched];
  }
  /**
   * 真实 Redis HSCAN 语义：游标在**哈希 field 槽位**上前进，每次调用只前进 COUNT 个槽位。
   * 生产代码形如 HSCAN <key> <cursor> [MATCH pat] [COUNT n] —— 参数位置固定，
   * 旧实现把 a[2]（此处是 "COUNT"）当成 MATCH 模式、且一次返回全部，
   * 导致本地测试永远扫不出多轮往返，2026-10-07 的 HSCAN 无预算风险在本地完全不可见。
   */
  _hscan(key, cursor, args) {
    this._expireIfDue(key);
    const h = this.hashes.get(key);
    if (!h) return ["0", []];
    const fields = [...h.keys()];
    // MATCH / COUNT 均为可选且顺序不固定，需按 token 解析（生产代码只传 COUNT）
    let matchPat = "*", count = 10;
    for (let i = 0; i < args.length; i++) {
      const t = String(args[i]).toUpperCase();
      if (t === "MATCH") matchPat = args[++i];
      else if (t === "COUNT") count = args[++i];
    }
    const step = Math.max(1, Number(count) || 10);
    let start = Number(cursor) || 0;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (start >= fields.length) return ["0", []];
    const end = Math.min(start + step, fields.length);
    const p = String(matchPat).replace(/[-/\\^$+?.()|{}]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp("^" + p + "$");
    const flat = [];
    for (let i = start; i < end; i++) { const f = fields[i]; if (re.test(f)) flat.push(f, h.get(f)); }
    return [end >= fields.length ? "0" : String(end), flat];
  }
  command(parts) {
    const cmd = String(parts[0]).toUpperCase();
    const a = parts.slice(1);
    switch (cmd) {
      case "GET": { this._expireIfDue(a[0]); return this._get(a[0]); }
      case "SET": {
        // 真实语义：NX（仅当不存在）/ XX（仅当存在）/ KEEPTTL（保留原 TTL）/
        //            EX 秒 / PX 毫秒。NX 与 XX 同时给出是语法错误（ERR）。
        const hasNX = a.some(x => String(x).toUpperCase() === "NX");
        const hasXX = a.some(x => String(x).toUpperCase() === "XX");
        if (hasNX && hasXX) throw new Error("ERR syntax error");
        this._expireIfDue(a[0]);
        if (hasNX && this.strings.has(a[0])) return null;
        if (hasXX && !this.strings.has(a[0])) return null;      // 键不存在 → 不写入、不创建（此前错误地创建）
        const keepTTL = a.some(x => String(x).toUpperCase() === "KEEPTTL");
        const prevTTL = this.expiries.get(a[0]);
        const exIdx = a.findIndex(x => String(x).toUpperCase() === "EX");
        const pxIdx = a.findIndex(x => String(x).toUpperCase() === "PX");
        const ok = this._set(a[0], a[1]);
        if (exIdx > 0) this.expiries.set(a[0], this.now() + Math.floor(Number(a[exIdx + 1])) * 1000);
        else if (pxIdx > 0) this.expiries.set(a[0], this.now() + Number(a[pxIdx + 1]));   // PX 是毫秒
        else if (keepTTL && prevTTL !== undefined) this.expiries.set(a[0], prevTTL);
        else this.expiries.delete(a[0]);                        // 无 TTL 选项 → 清除旧 TTL
        return ok;
      }
      case "TTL": { this._expireIfDue(a[0]); const e = this.expiries.get(a[0]); if (e === undefined) return this.strings.has(a[0]) ? -1 : -2; return Math.max(0, Math.ceil((e - this.now()) / 1000)); }
      case "PTTL": { this._expireIfDue(a[0]); const e = this.expiries.get(a[0]); if (e === undefined) return this.strings.has(a[0]) ? -1 : -2; return Math.max(0, e - this.now()); }
      case "EXISTS": { let n = 0; for (const k of a) if (this._alive(k)) n++; return n; }   // 已过期计为不存在
      case "EXPIRE": { if (!this._alive(a[0])) return 0; this.expiries.set(a[0], this.now() + Number(a[1]) * 1000); return 1; }
      case "PERSIST": { if (!this._alive(a[0])) return 0; if (!this.expiries.has(a[0])) return 0; this.expiries.delete(a[0]); return 1; }
      case "DEL": { let n = 0; for (const k of a) { if (this.strings.delete(k)) n++; if (this.sets.delete(k)) n++; if (this.hashes.delete(k)) n++; if (this.lists.delete(k)) n++; this.expiries.delete(k); } return n; }
      case "RENAME": {
        const src = a[0], dst = a[1];
        this._expireIfDue(src);
        if (!this._alive(src)) return 0;
        const ex = this.expiries.get(src);
        if (this.strings.has(src)) { this.strings.set(dst, this.strings.get(src)); this.strings.delete(src); }
        else if (this.sets.has(src)) { this.sets.set(dst, new Set(this.sets.get(src))); this.sets.delete(src); }
        else if (this.hashes.has(src)) { this.hashes.set(dst, new Map(this.hashes.get(src))); this.hashes.delete(src); }
        else if (this.lists.has(src)) { this.lists.set(dst, [...this.lists.get(src)]); this.lists.delete(src); }
        if (ex !== undefined) this.expiries.set(dst, ex);
        this.expiries.delete(src);
        return 1;
      }
      case "SADD": {
        const key = a[0]; this._expireIfDue(key); let s = this.sets.get(key); if (!s) { s = new Set(); this.sets.set(key, s); }
        let n = 0; for (let i = 1; i < a.length; i++) { if (!s.has(a[i])) { s.add(a[i]); n++; } } return n;
      }
      case "SREM": { this._expireIfDue(a[0]); const s = this.sets.get(a[0]); if (!s) return 0; let n = 0; for (let i = 1; i < a.length; i++) if (s.delete(a[i])) n++; return n; }
      // 已过期的集合/哈希/列表必须返回空 —— 真实 Redis 惰性过期后观测为空。
      // 桩此前只清理 strings，导致「集合 TTL 到期后本地仍返回全量数据」，相关生产逻辑本地完全测不出。
      case "SMEMBERS": { this._expireIfDue(a[0]); return this.sets.has(a[0]) ? [...this.sets.get(a[0])] : []; }
      case "SISMEMBER": { this._expireIfDue(a[0]); return this.sets.has(a[0]) && this.sets.get(a[0]).has(a[1]) ? 1 : 0; }
      case "MGET": return a.map(k => { this._expireIfDue(k); return this._get(k); });
      case "SCAN": {
        const [cursor, items] = this._scan(a[0], a[2] || "*", a[4]);
        return [cursor, items];
      }
      case "HSET": {
        const key = a[0]; this._expireIfDue(key); let h = this.hashes.get(key); if (!h) { h = new Map(); this.hashes.set(key, h); }
        let n = 0; for (let i = 1; i + 1 < a.length; i += 2) { const f = a[i], v = a[i + 1]; if (!h.has(f)) n++; h.set(f, v); } return n;
      }
      case "HGET": { this._expireIfDue(a[0]); const h = this.hashes.get(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
      case "HGETALL": { this._expireIfDue(a[0]); const h = this.hashes.get(a[0]); if (!h) return []; const out = []; for (const [f, v] of h) { out.push(f, v); } return out; }
      case "HMGET": { this._expireIfDue(a[0]); const h = this.hashes.get(a[0]); return a.slice(1).map(f => (h && h.has(f)) ? h.get(f) : null); }
      case "HDEL": { this._expireIfDue(a[0]); const h = this.hashes.get(a[0]); if (!h) return 0; let n = 0; for (let i = 1; i < a.length; i++) if (h.delete(a[i])) n++; return n; }
      case "HLEN": { this._expireIfDue(a[0]); const h = this.hashes.get(a[0]); return h ? h.size : 0; }
      case "HSCAN": {
        const [cursor, flat] = this._hscan(a[0], a[1], a);
        return [cursor, flat];
      }
      case "RPUSH": { const key = a[0]; this._expireIfDue(key); let l = this.lists.get(key); if (!l) { l = []; this.lists.set(key, l); } for (let i = 1; i < a.length; i++) l.push(a[i]); return l.length; }
      case "LTRIM": { this._expireIfDue(a[0]); const l = this.lists.get(a[0]); if (!l) return "OK"; let start = Number(a[1]), stop = Number(a[2]); if (stop < 0) stop = l.length + stop; const nw = l.slice(start, stop + 1); this.lists.set(a[0], nw); return "OK"; }
      case "LRANGE": { this._expireIfDue(a[0]); const l = this.lists.get(a[0]); if (!l) return []; let start = Number(a[1]), stop = Number(a[2]); if (start < 0) start = l.length + start; if (stop < 0) stop = l.length + stop; return l.slice(start, stop + 1); }
      case "LLEN": { this._expireIfDue(a[0]); const l = this.lists.get(a[0]); return l ? l.length : 0; }
      case "INCR": {
        this._expireIfDue(a[0]);
        const cur = this.strings.has(a[0]) ? Number(this._get(a[0])) : 0;
        // 真实 Redis 对非整数字符串返回 ERR；桩此前算出 NaN 静默写入，会掩盖生产数据异常
        if (!Number.isFinite(cur)) throw new Error("ERR value is not an integer or out of range");
        const nv = cur + 1; this._set(a[0], nv); return nv;
      }
      case "EVAL": {
        const numkeys = Number(a[1]);
        const keys = a.slice(2, 2 + numkeys);
        const argv = a.slice(2 + numkeys);
        return this.evalLua(a[0], keys, argv);
      }
      default: throw new Error("MINIREDIS_UNSUPPORTED:" + cmd);
    }
  }
  pipeline(commands) { return commands.map(c => this.command(c)); }

  evalLua(script, keys, argv) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const luaArr = (arr) => "{" + (arr || []).map(v => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",") + "}";
    // redis.call
    const self = this;
    lua.lua_pushjsfunction(L, function (L2) {
      const n = lua.lua_gettop(L2);
      const args = [];
      for (let i = 1; i <= n; i++) {
        const t = lua.lua_type(L2, i);
        if (t === lua.LUA_TSTRING) args.push(to_jsstring(lua.lua_tostring(L2, i)));
        else if (t === lua.LUA_TNUMBER) args.push(String(lua.lua_tonumber(L2, i)));
        else if (t === lua.LUA_TBOOLEAN) args.push(lua.lua_toboolean(L2, i) ? "1" : "0");
        else if (t === lua.LUA_TNIL) args.push(null);
        else args.push(to_jsstring(lua.lua_tostring(L2, i)));
      }
      const res = self.command(args);
      pushLuaValue(L2, res);
      return 1;
    });
    lua.lua_setglobal(L, to_luastring("redis_call"));
    // cjson
    lua.lua_pushjsfunction(L, function (L2) {
      const s = to_jsstring(lua.lua_tostring(L2, 1));
      let v; try { v = JSON.parse(s); } catch (e) { lauxlib.luaL_error(L2, "cjson.decode error"); return 0; }
      pushLuaValue(L2, v);
      return 1;
    });
    lua.lua_setglobal(L, to_luastring("cjson_decode"));
    lua.lua_pushjsfunction(L, function (L2) {
      const v = toJsValue(L2, 1);
      lua.lua_pushstring(L2, to_luastring(JSON.stringify(v)));
      return 1;
    });
    lua.lua_setglobal(L, to_luastring("cjson_encode"));

    const chunk =
      `local KEYS=${luaArr(keys)};local ARGV=${luaArr(argv)};` +
      `redis={call=redis_call};cjson={decode=cjson_decode,encode=cjson_encode};\n` +
      script;
    const ok = lauxlib.luaL_dostring(L, to_luastring(chunk));
    if (ok !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      throw new Error("LUA_ERROR: " + msg);
    }
    const result = toJsValue(L, -1);
    return result;
  }
}

// ---------- Upstash REST 协议桥接 ----------
function makeUpstash(red) {
  global.fetch = async function (url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const u = String(url);
    if (u.endsWith("/pipeline")) {
      const results = red.pipeline(body).map(r => ({ result: r }));
      return new Response(JSON.stringify(results), { status: 200, headers: { "content-type": "application/json" } });
    }
    const result = red.command(body);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return red;
}

module.exports = { MiniRedis, makeUpstash };
