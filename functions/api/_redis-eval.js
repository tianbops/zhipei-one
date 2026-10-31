/**
 * 智配One · EVAL（Lua 原子事务）的 D1 等价实现注册表
 * ------------------------------------------------------------------
 * Redis 原实现把多键原子读写写进 Lua 脚本（EVAL）。D1（SQLite）没有 Lua，
 * 故把每个 DISTINCT 的 Lua 脚本逐一移植为 JavaScript 处理器，在事务上下文 ctx 内
 * 完成「读 → 判定 → 写」，原子性由 D1 的 BEGIN IMMEDIATE … COMMIT 保证。
 *
 * 注册键 = 脚本归一化文本（见 _redis-norm.js）。运行时 _db.js 用同一归一化函数
 * 计算调用方传入脚本的键并查表；查不到抛 UNIMPLEMENTED_EVAL（携带归一化文本，
 * 便于补表）。因此本文件必须覆盖全部被实际调用的 EVAL 脚本。
 *
 * 处理器签名：(ctx, keys, args) => number | array
 *   - 返回 number：原脚本返回整数状态码（调用方 Number() 解析）
 *   - 返回 array：原脚本返回 Lua table（如 {session,user}、{"OK",version}、
 *     {"NEW",id}、[n1,ttl1,...]），按 Redis 扁平数组语义原样返回
 */

import { normalizeLua } from "./_redis-norm.js";

// JSON 解析助手：返回 [ok, value]，与 Lua pcall(cjson.decode) 语义对齐。
function parseJSON(v) {
  if (v == null) return [false, null];
  if (typeof v === "object") return [true, v];
  try {
    return [true, JSON.parse(v)];
  } catch {
    return [false, null];
  }
}

const HANDLERS = new Map();

function reg(script, handler) {
  HANDLERS.set(normalizeLua(script), handler);
}

export function lookupEval(norm) {
  return HANDLERS.get(norm) || null;
}

// ============ 1. CAS-DEL 释放分布式锁（多处复用，同一文本） ============
reg(
  `if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end`,
  async (ctx, keys, args) => {
    const cur = await ctx.get(keys[0]);
    if (cur === args[0]) {
      await ctx.del(keys[0]);
      return 1;
    }
    return 0;
  }
);

// ============ 运单删除：主记录与反向去重键原子清理 ============
reg(
  `for i=2,#KEYS do if redis.call("GET",KEYS[i])==ARGV[1] then redis.call("DEL",KEYS[i]) end end; redis.call("DEL",KEYS[1]); return 1`,
  async (ctx, keys, args) => {
    for (const key of keys.slice(1)) {
      if (await ctx.get(key) === args[0]) await ctx.del(key);
    }
    await ctx.del(keys[0]);
    return 1;
  }
);

// ============ 2. AUTH_READ：原子读取 session + user ============
reg(
  `local session = redis.call('GET', KEYS[1])
if not session then return {false, false} end
local ok, data = pcall(cjson.decode, session)
if not ok or type(data) ~= 'table' or not data.userId then
  return {session, false}
end
local user = redis.call('GET', ARGV[1] .. data.userId)
return {session, user or false}`,
  async (ctx, keys, args) => {
    if (typeof ctx.authRead === "function") return ctx.authRead(keys[0], args[0]);
    const session = await ctx.get(keys[0]);
    if (!session) return [null, null];
    const [ok, data] = parseJSON(session);
    if (!ok || typeof data !== "object" || !data.userId) return [session, null];
    const user = await ctx.get(args[0] + data.userId);
    return [session, user || null];
  }
);

// ============ 3. _migrations 遗留角色归一化 ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.role=='system_admin' then u.role='admin'; redis.call('SET',KEYS[1],cjson.encode(u)); return 1 end; return 0`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 0;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object") return 0;
    if (u.role === "system_admin") {
      u.role = "admin";
      await ctx.set(keys[0], JSON.stringify(u));
      return 1;
    }
    return 0;
  }
);

// ============ 4. 全局学习 meta 版本同步（ensureMeta） ============
reg(
  `local v=tonumber(redis.call("GET",KEYS[1]) or "0") or 0; local t=tonumber(ARGV[1]) or 1; if v<t then redis.call("SET",KEYS[1],t); return t end; return v`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    const v = Number(raw) || 0;
    const t = Number(args[0]) || 1;
    if (v < t) {
      await ctx.set(keys[0], String(t));
      return t;
    }
    return v;
  }
);

// ============ 5. 全局学习 learnGlobal ============
reg(
  `local eventKey=ARGV[1]
if eventKey~="__none__" and redis.call("GET",eventKey) then return {"DUPLICATE"} end
redis.call("HSET",KEYS[1],ARGV[2],ARGV[3])
local n=5
for i=1,tonumber(ARGV[4]) do local k=ARGV[n];local v=ARGV[n+1];redis.call("HSET",KEYS[2],k,v);n=n+2 end
redis.call("RPUSH",KEYS[3],ARGV[n]);redis.call("LTRIM",KEYS[3],"-5000","-1")
local version=redis.call("INCR",KEYS[4])
redis.call("SET",KEYS[5],cjson.encode({schemaVersion="2",version=version}))
if eventKey~="__none__" then redis.call("SET",eventKey,ARGV[n+2]) end
return {"OK",tostring(version)}`,
  async (ctx, keys, args) => {
    const eventKey = args[0];
    if (eventKey !== "__none__") {
      const existingEvent = await ctx.get(eventKey);
      if (existingEvent) return ["DUPLICATE"];
    }
    await ctx.hset(keys[0], [[args[1], args[2]]]);
    const aliasCount = Number(args[3]) || 0;
    let n = 4;
    const aliasEntries = [];
    for (let i = 0; i < aliasCount; i++) {
      aliasEntries.push([args[n], args[n + 1]]);
      n += 2;
    }
    await ctx.hset(keys[1], aliasEntries);
    await ctx.rpush(keys[2], [args[n]]);
    await ctx.ltrim(keys[2], "-5000", "-1");
    const version = await ctx.incr(keys[3]);
    await ctx.set(keys[4], JSON.stringify({ schemaVersion: "2", version }));
    if (eventKey !== "__none__") await ctx.set(eventKey, args[n + 2]);
    return ["OK", String(version)];
  }
);

// ============ 6. 全局学习 resolveGlobalConflict（含 HSCAN 循环） ============
reg(
  `local cursor="0"
repeat
 local scan=redis.call("HSCAN",KEYS[2],cursor,"COUNT","200")
 cursor=scan[1]
 local vals=scan[2]
 for i=1,#vals,2 do
  local key=vals[i]
  local ok,parsed=pcall(cjson.decode,vals[i+1])
  if ok and type(parsed)=="table" then
   local next={}
   for _,id in ipairs(parsed) do if id~=ARGV[1] then table.insert(next,id) end end
   if #next==0 then redis.call("HDEL",KEYS[2],key) else redis.call("HSET",KEYS[2],key,cjson.encode(next)) end
  end
 end
until cursor=="0"
redis.call("HSET",KEYS[1],ARGV[1],ARGV[2])
redis.call("HSET",KEYS[2],ARGV[3],ARGV[4])
redis.call("RPUSH",KEYS[3],ARGV[5])
redis.call("LTRIM",KEYS[3],"-5000","-1")
local version=redis.call("INCR",KEYS[4])
redis.call("SET",KEYS[5],cjson.encode({schemaVersion="2",version=version}))
return tostring(version)`,
  async (ctx, keys, args) => {
    const aliasFlat = await ctx.hgetall(keys[1]);
    for (let i = 0; i + 1 < aliasFlat.length; i += 2) {
      const k = aliasFlat[i];
      const v = aliasFlat[i + 1];
      const [ok, parsed] = parseJSON(v);
      if (ok && Array.isArray(parsed)) {
        const next = parsed.filter((id) => id !== args[0]);
        if (next.length === 0) await ctx.hdel(keys[1], [k]);
        else await ctx.hset(keys[1], [[k, JSON.stringify(next)]]);
      }
    }
    await ctx.hset(keys[0], [[args[0], args[1]]]);
    await ctx.hset(keys[1], [[args[2], args[3]]]);
    await ctx.rpush(keys[2], [args[4]]);
    await ctx.ltrim(keys[2], "-5000", "-1");
    const version = await ctx.incr(keys[3]);
    await ctx.set(keys[4], JSON.stringify({ schemaVersion: "2", version }));
    return String(version);
  }
);

// ============ 7. 全局学习 isolate / restore ============
reg(
  `local v=tonumber(redis.call("INCR",KEYS[2])) or 0; redis.call("HSET",KEYS[1],ARGV[1],ARGV[2]); redis.call("RPUSH",KEYS[3],ARGV[3]); redis.call("LTRIM",KEYS[3],"-5000","-1"); redis.call("SET",KEYS[4],cjson.encode({schemaVersion="2",version=v})); return v`,
  async (ctx, keys, args) => {
    const version = await ctx.incr(keys[1]);
    await ctx.hset(keys[0], [[args[0], args[1]]]);
    await ctx.rpush(keys[2], [args[2]]);
    await ctx.ltrim(keys[2], "-5000", "-1");
    await ctx.set(keys[3], JSON.stringify({ schemaVersion: "2", version }));
    return version;
  }
);

// ============ 8. 管理员初始化 bootstrap ============
reg(
  `local idsRaw=redis.call('GET',KEYS[1]); local ids={}; if idsRaw then local ok,v=pcall(cjson.decode,idsRaw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,uid in ipairs(ids) do local raw=redis.call('GET','zp:user:'..uid); if not raw then return 5 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 5 end; if u.role=='admin' then return 2 end end; if redis.call('GET',KEYS[2]) then return 3 end; redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); table.insert(ids,ARGV[3]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1`,
  async (ctx, keys, args) => {
    const idsRaw = await ctx.get(keys[0]);
    let ids = [];
    if (idsRaw) {
      const [ok, v] = parseJSON(idsRaw);
      if (!ok || !Array.isArray(v)) return 4;
      ids = v;
    }
    for (const uid of ids) {
      const raw = await ctx.get("zp:user:" + uid);
      if (!raw) return 5;
      const [ok, u] = parseJSON(raw);
      if (!ok || typeof u !== "object") return 5;
      if (u.role === "admin") return 2;
    }
    if (await ctx.get(keys[1])) return 3;
    await ctx.set(keys[2], args[0]);
    await ctx.set(keys[1], args[1]);
    ids.push(args[2]);
    await ctx.set(keys[0], JSON.stringify(ids));
    return 1;
  }
);

// ============ 9. 管理员改名（manage rename） ============
reg(
  `local raw=redis.call('GET',KEYS[3]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or (u.role~='admin' and u.role~='system_admin') then return 3 end; local existing=redis.call('GET',KEYS[2]); if existing and existing~=ARGV[2] then return 4 end; local old=redis.call('GET',KEYS[1]); if old and old~=ARGV[2] then return 5 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.name=ARGV[1]; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[2]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object" || u.id !== args[1] || (u.role !== "admin" && u.role !== "system_admin")) return 3;
    const existing = await ctx.get(keys[1]);
    if (existing && existing !== args[1]) return 4;
    const old = await ctx.get(keys[0]);
    if (old && old !== args[1]) return 5;
    await ctx.del(keys[0]);
    u.username = args[0];
    u.name = args[0];
    await ctx.set(keys[2], JSON.stringify(u));
    await ctx.set(keys[1], args[1]);
    return 1;
  }
);

// ============ 10. 管理员改密码（manage password） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] or (u.role~='admin' and u.role~='system_admin') then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object" || u.id !== args[1] || (u.role !== "admin" && u.role !== "system_admin")) return 3;
    u.passwordHash = args[0];
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 11. 邀请码创建 ============
reg(
  `local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,x in ipairs(ids) do if x==ARGV[1] then return 2 end end; if redis.call('GET',KEYS[3]) then return 3 end; redis.call('SET',KEYS[2],ARGV[2]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[1]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    let ids = [];
    if (raw) {
      const [ok, v] = parseJSON(raw);
      if (!ok || !Array.isArray(v)) return 4;
      ids = v;
    }
    if (ids.includes(args[0])) return 2;
    if (await ctx.get(keys[2])) return 3;
    await ctx.set(keys[1], args[1]);
    await ctx.set(keys[2], args[2]);
    ids.push(args[0]);
    await ctx.set(keys[0], JSON.stringify(ids));
    return 1;
  }
);

// ============ 12. 邀请码移除 ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,ids=pcall(cjson.decode,raw); if not ok or type(ids)~='table' then return 3 end; local found=false; local next={}; for _,x in ipairs(ids) do if x==ARGV[1] then found=true else table.insert(next,x) end end; if not found then return 4 end; local main=redis.call('GET',KEYS[2]); local code=redis.call('GET',KEYS[3]); if not main or not code then return 5 end; local okm,m=pcall(cjson.decode,main); local okc,c=pcall(cjson.decode,code); if not okm or type(m)~='table' or not okc or type(c)~='table' then return 6 end; if m.id~=ARGV[1] or c.id~=ARGV[1] or m.code~=c.code or m.code~=ARGV[2] then return 7 end; m.enabled=false; m.removedAt=ARGV[3]; c.enabled=false; c.removedAt=ARGV[3]; redis.call('SET',KEYS[2],cjson.encode(m)); redis.call('SET',KEYS[3],cjson.encode(c)); redis.call('SET',KEYS[1],cjson.encode(next)); return 1`,  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, ids] = parseJSON(raw);
    if (!ok || !Array.isArray(ids)) return 3;
    if (!ids.includes(args[0])) return 4;
    const main = await ctx.get(keys[1]);
    const code = await ctx.get(keys[2]);
    if (!main || !code) return 5;
    const [okm, m] = parseJSON(main);
    const [okc, c] = parseJSON(code);
    if (!okm || typeof m !== "object" || !okc || typeof c !== "object") return 6;
    if (m.id !== args[0] || c.id !== args[0] || m.code !== c.code || m.code !== args[1]) return 7;
    m.enabled = false;
    m.removedAt = args[2];
    c.enabled = false;
    c.removedAt = args[2];
    await ctx.set(keys[1], JSON.stringify(m));
    await ctx.set(keys[2], JSON.stringify(c));
    const next = ids.filter((x) => x !== args[0]);
    await ctx.set(keys[0], JSON.stringify(next));
    return 1;
  }
);

// ============ 13. 邀请码启用/停用 ============
reg(
  `local a=redis.call('GET',KEYS[1]); local b=redis.call('GET',KEYS[2]); if not a or not b then return 2 end; local okA,c=pcall(cjson.decode,a); local okB,d=pcall(cjson.decode,b); if not okA or type(c)~='table' or not okB or type(d)~='table' then return 4 end; if c.id~=ARGV[2] or d.id~=ARGV[2] or c.code~=d.code then return 5 end; c.enabled=ARGV[1]=='1'; d.enabled=c.enabled; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET',KEYS[2],cjson.encode(d)); return 1`,
  async (ctx, keys, args) => {
    const a = await ctx.get(keys[0]);
    const b = await ctx.get(keys[1]);
    if (!a || !b) return 2;
    const [okA, c] = parseJSON(a);
    const [okB, d] = parseJSON(b);
    if (!okA || typeof c !== "object" || !okB || typeof d !== "object") return 4;
    if (c.id !== args[1] || d.id !== args[1] || c.code !== d.code) return 5;
    c.enabled = args[0] === "1";
    d.enabled = c.enabled;
    await ctx.set(keys[0], JSON.stringify(c));
    await ctx.set(keys[1], JSON.stringify(d));
    return 1;
  }
);

// ============ 14. 邀请码消费 ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,c=pcall(cjson.decode,raw); if not ok or type(c)~='table' or type(c.id)~='string' or type(c.code)~='string' then return 0 end; if c.code~=string.upper(ARGV[1]) then return 0 end; local main=redis.call('GET','zp:invite-code:'..c.id); if not main then return 0 end; local okm,m=pcall(cjson.decode,main); if not okm or type(m)~='table' or m.id~=c.id or m.code~=c.code then return 0 end; if c.enabled==false or m.enabled==false then return 0 end; if c.expiresAt and c.expiresAt~='' then local exp=string.sub(c.expiresAt,1,19); local now=os.date('!%Y-%m-%dT%H:%M:%S'); if exp<=now then return 0 end end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return 0 end; local next=used+1; c.usedCount=next; m.usedCount=next; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET','zp:invite-code:'..c.id,cjson.encode(m)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 0;
    const [ok, c] = parseJSON(raw);
    if (!ok || typeof c !== "object" || typeof c.id !== "string" || typeof c.code !== "string") return 0;
    if (c.code !== String(args[0]).toUpperCase()) return 0;
    const main = await ctx.get("zp:invite-code:" + c.id);
    if (!main) return 0;
    const [okm, m] = parseJSON(main);
    if (!okm || typeof m !== "object" || m.id !== c.id || m.code !== c.code) return 0;
    if (c.enabled === false || m.enabled === false) return 0;
    if (c.expiresAt && c.expiresAt !== "") {
      const exp = String(c.expiresAt).slice(0, 19);
      const now = new Date().toISOString().slice(0, 19);
      if (exp <= now) return 0;
    }
    const used = Number(c.usedCount) || 0;
    const max = Number(c.maxUses) || 0;
    if (max > 0 && used >= max) return 0;
    const next = used + 1;
    c.usedCount = next;
    m.usedCount = next;
    await ctx.set(keys[0], JSON.stringify(c));
    await ctx.set("zp:invite-code:" + c.id, JSON.stringify(m));
    return 1;
  }
);

// ============ 15. 绑定 atomicBind ============
reg(
  `local r=cjson.decode(ARGV[1]); local u=cjson.decode(ARGV[2]); local cr=redis.call('GET',KEYS[1]); local cu=redis.call('GET',KEYS[2]); if not cr or not cu then return 2 end; local rr=cjson.decode(cr); local uu=cjson.decode(cu); if rr.id~=r.id then return 6 end; if uu.id~=u.id or uu.boundRouteId then return 3 end; local slot=ARGV[3]; if slot=='driver' then if rr.deliveryUserId~=r.deliveryUserId then return 6 end; if rr.driverUserId and rr.driverUserId~=uu.id then return 4 end; elseif slot=='delivery' then if rr.driverUserId~=r.driverUserId then return 6 end; if rr.deliveryUserId and rr.deliveryUserId~=uu.id then return 5 end; else return 6 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1`,
  async (ctx, keys, args) => {
    const [okr, r] = parseJSON(args[0]);
    const [oku, u] = parseJSON(args[1]);
    if (!okr || !oku || typeof r !== "object" || typeof u !== "object") return 2;
    const cr = await ctx.get(keys[0]);
    const cu = await ctx.get(keys[1]);
    if (!cr || !cu) return 2;
    const [okcr, rr] = parseJSON(cr);
    const [okcu, uu] = parseJSON(cu);
    if (!okcr || typeof rr !== "object" || !okcu || typeof uu !== "object") return 2;
    if (rr.id !== r.id) return 6;
    if (uu.id !== u.id || uu.boundRouteId) return 3;
    const slot = args[2];
    if (slot === "driver") {
      if (rr.deliveryUserId !== r.deliveryUserId) return 6;
      if (rr.driverUserId && rr.driverUserId !== uu.id) return 4;
    } else if (slot === "delivery") {
      if (rr.driverUserId !== r.driverUserId) return 6;
      if (rr.deliveryUserId && rr.deliveryUserId !== uu.id) return 5;
    } else return 6;
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[1], args[1]);
    return 1;
  }
);

// ============ 16. 绑定 atomicUnbind ============
reg(
  `local cr=redis.call('GET',KEYS[1]); local cu=redis.call('GET',KEYS[2]); if not cr or not cu then return 2 end; local rr=cjson.decode(cr); local uu=cjson.decode(cu); local expectedDuty=ARGV[4]; local expectedSlot=expectedDuty=='driver' and 'driverUserId' or 'deliveryUserId'; if rr.id~=ARGV[5] or rr[expectedSlot]~=uu.id then return 5 end; if uu.id~=ARGV[6] or uu.boundRouteId~=ARGV[3] then return 3 end; if uu.routeDuty~=expectedDuty then return 4 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); return 1`,
  async (ctx, keys, args) => {
    const cr = await ctx.get(keys[0]);
    const cu = await ctx.get(keys[1]);
    if (!cr || !cu) return 2;
    const [okr, rr] = parseJSON(cr);
    const [oku, uu] = parseJSON(cu);
    if (!okr || typeof rr !== "object" || !oku || typeof uu !== "object") return 5;
    const expectedDuty = args[3];
    const expectedSlot = expectedDuty === "driver" ? "driverUserId" : "deliveryUserId";
    if (rr.id !== args[4] || rr[expectedSlot] !== uu.id) return 5;
    if (uu.id !== args[5] || uu.boundRouteId !== args[2]) return 3;
    if (uu.routeDuty !== expectedDuty) return 4;
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[1], args[1]);
    return 1;
  }
);

// ============ 17. 解绑（用户自助 route-binding unbind） ============
reg(
  `local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); if not cu or not cr then return 2 end; local oku,u=pcall(cjson.decode,cu); local okr,r=pcall(cjson.decode,cr); if not oku or type(u)~='table' or not okr or type(r)~='table' then return 10 end; if u.id~=ARGV[1] or u.boundRouteId~=r.id or (u.routeDuty~='driver' and u.routeDuty~='delivery') then return 3 end; if u.routeDuty=='driver' then if r.driverUserId~=u.id then return 4 end; r.driverUserId=nil else if r.deliveryUserId~=u.id then return 5 end; r.deliveryUserId=nil end; u.boundRouteId=nil; u.routeDuty=nil; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); redis.call('SET',KEYS[2],cjson.encode(r)); return 1`,
  async (ctx, keys, args) => {
    const cu = await ctx.get(keys[0]);
    const cr = await ctx.get(keys[1]);
    if (!cu || !cr) return 2;
    const [oku, u] = parseJSON(cu);
    const [okr, r] = parseJSON(cr);
    if (!oku || typeof u !== "object" || !okr || typeof r !== "object") return 10;
    if (u.id !== args[0] || u.boundRouteId !== r.id || (u.routeDuty !== "driver" && u.routeDuty !== "delivery")) return 3;
    if (u.routeDuty === "driver") {
      if (r.driverUserId !== u.id) return 4;
      r.driverUserId = null;
    } else {
      if (r.deliveryUserId !== u.id) return 5;
      r.deliveryUserId = null;
    }
    u.boundRouteId = null;
    u.routeDuty = null;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(u));
    await ctx.set(keys[1], JSON.stringify(r));
    return 1;
  }
);

// ============ 18. 线路申请提交 route-requests submit ============
reg(
  `local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); if not cu or not cr then return 2 end; local oku,u=pcall(cjson.decode,cu); local okr,r=pcall(cjson.decode,cr); if not oku or type(u)~='table' or not okr or type(r)~='table' then return 10 end; if u.disabled then return 7 end; if u.boundRouteId then return 4 end; if u.routeDuty then return 11 end; if r.status~='active' then return 8 end; if r.driverUserId==u.id or r.deliveryUserId==u.id then return 12 end; if ARGV[2]=='driver' and r.driverUserId then return 5 end; if ARGV[2]=='delivery' and r.deliveryUserId then return 6 end; local raw=redis.call('GET',KEYS[4]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 9 end; ids=v end; for _,rid in ipairs(ids) do local rqraw=redis.call('GET','zp:route-request:'..rid); if rqraw then local ok,q=pcall(cjson.decode,rqraw); if ok and type(q)=='table' and q.userId==u.id and q.routeId==r.id and q.duty==ARGV[2] then if q.status=='pending' then return 3 end; if q.status=='approved' then return 13 end end end end; local q={id=ARGV[1],userId=u.id,routeId=r.id,duty=ARGV[2],status='pending',createdAt=ARGV[3]}; if ARGV[4]~='' then q.applicantName=ARGV[4] end; if ARGV[5]~='' then q.applicantPhone=ARGV[5] end; redis.call('SET',KEYS[3],cjson.encode(q)); table.insert(ids,ARGV[1]); redis.call('SET',KEYS[4],cjson.encode(ids)); return 1`,
  async (ctx, keys, args) => {
    const cu = await ctx.get(keys[0]);
    const cr = await ctx.get(keys[1]);
    if (!cu || !cr) return 2;
    const [oku, u] = parseJSON(cu);
    const [okr, r] = parseJSON(cr);
    if (!oku || typeof u !== "object" || !okr || typeof r !== "object") return 10;
    if (u.disabled) return 7;
    if (u.boundRouteId) return 4;
    if (u.routeDuty) return 11;
    if (r.status !== "active") return 8;
    if (r.driverUserId === u.id || r.deliveryUserId === u.id) return 12;
    if (args[1] === "driver" && r.driverUserId) return 5;
    if (args[1] === "delivery" && r.deliveryUserId) return 6;
    const raw = await ctx.get(keys[3]);
    let ids = [];
    if (raw) {
      const [ok, v] = parseJSON(raw);
      if (!ok || !Array.isArray(v)) return 9;
      ids = v;
    }
    for (const rid of ids) {
      const rqraw = await ctx.get("zp:route-request:" + rid);
      if (!rqraw) continue;
      const [qok, q] = parseJSON(rqraw);
      if (qok && q && typeof q === "object" && q.userId === u.id && q.routeId === r.id && q.duty === args[1]) {
        if (q.status === "pending") return 3;
        if (q.status === "approved") return 13;
      }
    }
    const q = { id: args[0], userId: u.id, routeId: r.id, duty: args[1], status: "pending", createdAt: args[2] };
    // 可选申请人姓名 / 手机号：空串不写字段，与 Redis 侧 Lua 的 `if ARGV[n]~=''` 同义。
    // 写入顺序与 Lua 一致（name 在前），保证 D1 落库 JSON 的键序与 Redis 相同。
    if (args[3] !== "" && args[3] != null) q.applicantName = args[3];
    if (args[4] !== "" && args[4] != null) q.applicantPhone = args[4];
    await ctx.set(keys[2], JSON.stringify(q));
    ids.push(args[0]);
    await ctx.set(keys[3], JSON.stringify(ids));
    return 1;
  }
);

// ============ 19. 线路申请驳回（admin/route-requests reject） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,q=pcall(cjson.decode,raw); if not ok or type(q)~='table' then return 4 end; if q.status~='pending' then return 3 end; q.status='rejected'; q.reviewedAt=ARGV[1]; q.reviewedBy=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(q)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, q] = parseJSON(raw);
    if (!ok || typeof q !== "object") return 4;
    if (q.status !== "pending") return 3;
    q.status = "rejected";
    q.reviewedAt = args[0];
    q.reviewedBy = args[1];
    await ctx.set(keys[0], JSON.stringify(q));
    return 1;
  }
);

// ============ 20. 线路申请批准（admin/route-requests approve） ============
reg(
  `local cu=redis.call('GET',KEYS[1]); local cr=redis.call('GET',KEYS[2]); local cq=redis.call('GET',KEYS[3]); if not cu or not cr or not cq then return 2 end; local oku,u=pcall(cjson.decode,cu); local okr,r=pcall(cjson.decode,cr); local okq,q=pcall(cjson.decode,cq); if not oku or type(u)~='table' or not okr or type(r)~='table' or not okq or type(q)~='table' then return 11 end; if q.status~='pending' then return 3 end; if u.disabled==true then return 7 end; if u.boundRouteId then return 4 end; if u.routeDuty then return 12 end; if r.status~='active' then return 8 end; if q.userId~=u.id or q.routeId~=r.id then return 9 end; if q.duty~=ARGV[1] then return 10 end; if r.driverUserId==u.id or r.deliveryUserId==u.id then return 13 end; if ARGV[1]=='driver' and r.driverUserId then return 5 end; if ARGV[1]=='delivery' and r.deliveryUserId then return 6 end; if ARGV[1]=='driver' then r.driverUserId=u.id else r.deliveryUserId=u.id end; u.boundRouteId=r.id; u.routeDuty=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; q.status='approved'; q.reviewedAt=ARGV[2]; q.reviewedBy=ARGV[3]; redis.call('SET',KEYS[1],cjson.encode(u)); redis.call('SET',KEYS[2],cjson.encode(r)); redis.call('SET',KEYS[3],cjson.encode(q)); return 1`,
  async (ctx, keys, args) => {
    const cu = await ctx.get(keys[0]);
    const cr = await ctx.get(keys[1]);
    const cq = await ctx.get(keys[2]);
    if (!cu || !cr || !cq) return 2;
    const [oku, u] = parseJSON(cu);
    const [okr, r] = parseJSON(cr);
    const [okq, q] = parseJSON(cq);
    if (!oku || typeof u !== "object" || !okr || typeof r !== "object" || !okq || typeof q !== "object") return 11;
    if (q.status !== "pending") return 3;
    if (u.disabled === true) return 7;
    if (u.boundRouteId) return 4;
    if (u.routeDuty) return 12;
    if (r.status !== "active") return 8;
    if (q.userId !== u.id || q.routeId !== r.id) return 9;
    if (q.duty !== args[0]) return 10;
    if (r.driverUserId === u.id || r.deliveryUserId === u.id) return 13;
    if (args[0] === "driver" && r.driverUserId) return 5;
    if (args[0] === "delivery" && r.deliveryUserId) return 6;
    if (args[0] === "driver") r.driverUserId = u.id;
    else r.deliveryUserId = u.id;
    u.boundRouteId = r.id;
    u.routeDuty = args[0];
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    q.status = "approved";
    q.reviewedAt = args[1];
    q.reviewedBy = args[2];
    await ctx.set(keys[0], JSON.stringify(u));
    await ctx.set(keys[1], JSON.stringify(r));
    await ctx.set(keys[2], JSON.stringify(q));
    return 1;
  }
);

// ============ 21. 管理员停用用户（无绑定线路） — users.js disable 无 route ============
reg(
  `local rawIds=redis.call('GET',KEYS[2]); local ids={}; if rawIds then local okIds,v=pcall(cjson.decode,rawIds); if not okIds or type(v)~='table' then return 8 end; ids=v; for _,rid in ipairs(ids) do if type(rid)~='string' or rid=='' then return 8 end end end; local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok or type(x)~='table' then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.disabled==true then return 5 end; if x.boundRouteId then return 6 end; if x.routeDuty then return 7 end; x.disabled=true; x.sessionVersion=(x.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(x)); for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local rq=redis.call('GET',k); if rq then local qok,q=pcall(cjson.decode,rq); if qok and type(q)=='table' and q.userId==x.id and q.status=='pending' then q.status='rejected'; q.reviewedAt=ARGV[4]; q.reviewedBy=ARGV[3]; redis.call('SET',k,cjson.encode(q)); end end end; return 1`,
  async (ctx, keys, args) => {
    const rawIds = await ctx.get(keys[1]);
    let ids = [];
    if (rawIds) {
      const [okIds, v] = parseJSON(rawIds);
      if (!okIds || !Array.isArray(v)) return 8;
      ids = v;
      for (const rid of ids) if (typeof rid !== "string" || rid === "") return 8;
    }
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, x] = parseJSON(raw);
    if (!ok || typeof x !== "object") return 3;
    if (x.id !== args[1]) return 4;
    if (x.disabled === true) return 5;
    if (x.boundRouteId) return 6;
    if (x.routeDuty) return 7;
    x.disabled = true;
    x.sessionVersion = (Number(x.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(x));
    for (const rid of ids) {
      const k = "zp:route-request:" + rid;
      const rq = await ctx.get(k);
      if (!rq) continue;
      const [qok, q] = parseJSON(rq);
      if (qok && q && typeof q === "object" && q.userId === x.id && q.status === "pending") {
        q.status = "rejected";
        q.reviewedAt = args[3];
        q.reviewedBy = args[2];
        await ctx.set(k, JSON.stringify(q));
      }
    }
    return 1;
  }
);

// ============ 22. 管理员停用用户（含绑定线路） — users.js disable 有 route ============
reg(
  `local rr=redis.call('GET',KEYS[1]); local uu=redis.call('GET',KEYS[2]); if not rr or not uu then return 2 end; local r=cjson.decode(rr); local old=cjson.decode(uu); if old.disabled==true then return 3 end; if old.boundRouteId~=ARGV[3] or old.routeDuty~=ARGV[4] then return 4 end; local ids=cjson.decode(ARGV[5]); if type(ids)~='table' then return 5 end; for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local raw=redis.call('GET',k); if not raw then return 6 end; local ok,q=pcall(cjson.decode,raw); if not ok or type(q)~='table' then return 6 end; if q.id~=rid then return 7 end end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[2]); for _,rid in ipairs(ids) do local k='zp:route-request:'..rid; local raw=redis.call('GET',k); if raw then local q=cjson.decode(raw); if q.userId==old.id and q.status=='pending' then q.status='rejected'; q.reviewedAt=ARGV[6]; q.reviewedBy=ARGV[7]; redis.call('SET',k,cjson.encode(q)) end end end; return 1`,
  async (ctx, keys, args) => {
    const rr = await ctx.get(keys[0]);
    const uu = await ctx.get(keys[1]);
    if (!rr || !uu) return 2;
    const [okr, r] = parseJSON(rr);
    const [oku, old] = parseJSON(uu);
    if (!okr || typeof r !== "object" || !oku || typeof old !== "object") return 3;    if (old.disabled === true) return 3;
    if (old.boundRouteId !== args[2] || old.routeDuty !== args[3]) return 4;
    const [okIds, ids] = parseJSON(args[4]);
    if (!Array.isArray(ids)) return 5;
    for (const rid of ids) {
      const raw = await ctx.get("zp:route-request:" + rid);
      if (!raw) return 6;
      const [qok, q] = parseJSON(raw);
      if (!qok || typeof q !== "object") return 6;
      if (q.id !== rid) return 7;
    }
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[1], args[1]);
    for (const rid of ids) {
      const raw = await ctx.get("zp:route-request:" + rid);
      if (!raw) continue;
      const q = parseJSON(raw)[1];
      if (q && q.userId === old.id && q.status === "pending") {
        q.status = "rejected";
        q.reviewedAt = args[5];
        q.reviewedBy = args[6];
        await ctx.set("zp:route-request:" + rid, JSON.stringify(q));
      }
    }
    return 1;
  }
);

// ============ 23. 管理员删除用户（含绑定线路） — users.js delete 有 routeKey ============
reg(
  `local rr=redis.call('GET',KEYS[1]); local uu=redis.call('GET',KEYS[2]); if not rr or not uu then return 2 end; local r=cjson.decode(rr); local u=cjson.decode(uu); if u.id~=ARGV[2] then return 3 end; if u.boundRouteId~=r.id or u.routeDuty~=ARGV[4] then return 4 end; local slot=ARGV[4]=='driver' and 'driverUserId' or 'deliveryUserId'; if r[slot]~=u.id then return 5 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); redis.call('DEL',KEYS[2]); return 1`,
  async (ctx, keys, args) => {
    const rr = await ctx.get(keys[0]);
    const uu = await ctx.get(keys[1]);
    if (!rr || !uu) return 2;
    const [okr, r] = parseJSON(rr);
    const [oku, u] = parseJSON(uu);
    if (!oku || typeof u !== "object") return 3;
    if (u.id !== args[1]) return 3;
    if (r && typeof r === "object" && (u.boundRouteId !== r.id || u.routeDuty !== args[3])) return 4;
    const slot = args[3] === "driver" ? "driverUserId" : "deliveryUserId";
    if (r && typeof r === "object" && r[slot] !== u.id) return 5;
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[2], args[2]);
    await ctx.del(keys[1]);
    return 1;
  }
);

// ============ 24. 管理员删除用户（无绑定线路） — users.js delete 无 routeKey ============
reg(
  `local uu=redis.call('GET',KEYS[1]); if not uu then return 2 end; local u=cjson.decode(uu); if u.id~=ARGV[1] then return 3 end; redis.call('SET',KEYS[2],ARGV[2]); redis.call('DEL',KEYS[1]); return 1`,
  async (ctx, keys, args) => {
    const uu = await ctx.get(keys[0]);
    if (!uu) return 2;
    const [oku, u] = parseJSON(uu);
    if (!oku || typeof u !== "object") return 3;
    if (u.id !== args[0]) return 3;
    await ctx.set(keys[1], args[1]);
    await ctx.del(keys[0]);
    return 1;
  }
);

// ============ 25. 管理员/账户 改名（users rename / 账户 rename 复用同一校验） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.role=='admin' then return 5 end; x.name=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(x)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, x] = parseJSON(raw);
    if (!ok || typeof x !== "object") return 3;
    if (x.id !== args[1]) return 4;
    if (x.role === "admin") return 5;
    x.name = args[0];
    await ctx.set(keys[0], JSON.stringify(x));
    return 1;
  }
);

// ============ 26. 清理用户申请 CAS（users.js cleanupUserRequests） ============
reg(
  `if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[1],ARGV[2]); return 1 end; return 0`,
  async (ctx, keys, args) => {
    const cur = await ctx.get(keys[0]);
    if (cur === args[0]) {
      await ctx.set(keys[0], args[1]);
      return 1;
    }
    return 0;
  }
);

// ============ 27. 账户设置改名（account-settings rename） ============
reg(
  `local idx=redis.call('GET',KEYS[1]); if not idx then return 2 end; if idx~=ARGV[2] then return 3 end; local raw=redis.call('GET',KEYS[3]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; if redis.call('GET',KEYS[2]) then return 4 end; redis.call('DEL',KEYS[1]); u.username=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[3],cjson.encode(u)); redis.call('SET',KEYS[2],ARGV[2]); return 1`,
  async (ctx, keys, args) => {
    const idx = await ctx.get(keys[0]);
    if (!idx) return 2;
    if (idx !== args[1]) return 3;
    const raw = await ctx.get(keys[2]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object" || u.id !== args[1]) return 3;
    if (await ctx.get(keys[1])) return 4;
    await ctx.del(keys[0]);
    u.username = args[0];
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[2], JSON.stringify(u));
    await ctx.set(keys[1], args[1]);
    return 1;
  }
);

// ============ 28. 账户设置改密码（account-settings password） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[2] then return 3 end; u.passwordHash=ARGV[1]; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object" || u.id !== args[1]) return 3;
    u.passwordHash = args[0];
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 29. 账户注销（account-settings delete） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' or u.id~=ARGV[1] then return 3 end; if u.role=='admin' or u.role=='system_admin' then return 7 end; local routeKey=KEYS[4]; if routeKey~='' and u.boundRouteId then local rr=redis.call('GET',routeKey); if not rr then return 4 end; local okr,r=pcall(cjson.decode,rr); if not okr or type(r)~='table' or r.id~=u.boundRouteId then return 5 end; if u.routeDuty=='driver' then if r.driverUserId~=u.id then return 6 end; r.driverUserId=nil elseif u.routeDuty=='delivery' then if r.deliveryUserId~=u.id then return 6 end; r.deliveryUserId=nil else return 6 end; redis.call('SET',routeKey,cjson.encode(r)) end; local idx=redis.call('GET',KEYS[3]); if idx then local okIds,ids=pcall(cjson.decode,idx); if not okIds or type(ids)~='table' then return 8 end; local keep={}; for _,id in ipairs(ids) do if id~=u.id then table.insert(keep,id) end end; redis.call('SET',KEYS[3],cjson.encode(keep)) end; local reqRaw=redis.call('GET',KEYS[5]); if reqRaw then local okReq,reqIds=pcall(cjson.decode,reqRaw); if not okReq or type(reqIds)~='table' then return 9 end; local keepReq={}; for _,rid in ipairs(reqIds) do local rk='zp:route-request:'..rid; local qraw=redis.call('GET',rk); if qraw then local okq,q=pcall(cjson.decode,qraw); if okq and type(q)=='table' and q.userId==u.id then redis.call('DEL',rk) else table.insert(keepReq,rid) end else table.insert(keepReq,rid) end end; redis.call('SET',KEYS[5],cjson.encode(keepReq)) end; redis.call('DEL',KEYS[2]); redis.call('DEL',KEYS[1]); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object" || u.id !== args[0]) return 3;
    if (u.role === "admin" || u.role === "system_admin") return 7;
    const routeKey = keys[3];
    if (routeKey && routeKey !== "" && u.boundRouteId) {
      const rr = await ctx.get(routeKey);
      if (!rr) return 4;
      const [okr, r] = parseJSON(rr);
      if (!okr || typeof r !== "object" || r.id !== u.boundRouteId) return 5;
      if (u.routeDuty === "driver") {
        if (r.driverUserId !== u.id) return 6;
        r.driverUserId = null;
      } else if (u.routeDuty === "delivery") {
        if (r.deliveryUserId !== u.id) return 6;
        r.deliveryUserId = null;
      } else return 6;
      await ctx.set(routeKey, JSON.stringify(r));
    }
    const idx = await ctx.get(keys[2]);
    if (idx) {
      const [okIds, ids] = parseJSON(idx);
      if (!okIds || !Array.isArray(ids)) return 8;
      const keep = ids.filter((id) => id !== u.id);
      await ctx.set(keys[2], JSON.stringify(keep));
    }
    const reqRaw = await ctx.get(keys[4]);
    if (reqRaw) {
      const [okReq, reqIds] = parseJSON(reqRaw);
      if (!okReq || !Array.isArray(reqIds)) return 9;
      const keepReq = [];
      for (const rid of reqIds) {
        const rk = "zp:route-request:" + rid;
        const qraw = await ctx.get(rk);
        if (qraw) {
          const [okq, q] = parseJSON(qraw);
          if (okq && q && typeof q === "object" && q.userId === u.id) await ctx.del(rk);
          else keepReq.push(rid);
        } else keepReq.push(rid);
      }
      await ctx.set(keys[4], JSON.stringify(keepReq));
    }
    await ctx.del(keys[1]);
    await ctx.del(keys[0]);
    return 1;
  }
);

// ============ 30. 环境管理员播种（_env-admin SEED_SCRIPT） ============
reg(
  `local idsRaw = redis.call('GET', KEYS[3])
local ids = {}
if idsRaw then
  local ok, v = pcall(cjson.decode, idsRaw)
  if ok and type(v) == 'table' then ids = v end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
local found = false
for _, x in ipairs(ids) do if x == ARGV[2] then found = true end end
if not found then
  table.insert(ids, ARGV[2])
  redis.call('SET', KEYS[3], cjson.encode(ids))
end
return 1`,
  async (ctx, keys, args) => {
    const idsRaw = await ctx.get(keys[2]);
    let ids = [];
    if (idsRaw) {
      const [ok, v] = parseJSON(idsRaw);
      if (ok && Array.isArray(v)) ids = v;
    }
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[1], args[1]);
    if (!ids.includes(args[1])) {
      ids.push(args[1]);
      await ctx.set(keys[2], JSON.stringify(ids));
    }
    return 1;
  }
);

// ============ 31. 限流 PEEK ============
reg(
  `local out = {}
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  out[#out + 1] = n
  out[#out + 1] = redis.call('TTL', KEYS[i])
end
return out`,
  async (ctx, keys, args) => {
    const out = [];
    for (const k of keys) {
      const n = Number(await ctx.get(k)) || 0;
      out.push(n);
      out.push(await ctx.ttl(k));
    }
    return out;
  }
);

// ============ 32. 限流 BUMP ============
reg(
  `local out = {}
for i = 1, #KEYS do
  local n = redis.call('INCR', KEYS[i])
  if n == 1 then redis.call('EXPIRE', KEYS[i], ARGV[1]) end
  out[#out + 1] = n
  out[#out + 1] = redis.call('TTL', KEYS[i])
end
return out`,
  async (ctx, keys, args) => {
    const out = [];
    for (const k of keys) {
      const n = await ctx.incr(k);
      if (n === 1) await ctx.expire(k, args[0]);
      out.push(n);
      out.push(await ctx.ttl(k));
    }
    return out;
  }
);

// ============ 33. 运单去重修复（process repairScript） ============
reg(
  `local current=redis.call("GET",KEYS[1]); if current and current~="" then local raw=redis.call("GET","zp:waybill:"..current); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.dailyDedupeKey==ARGV[2] then redis.call("SADD",KEYS[2],current); return current end; redis.call("DEL",KEYS[1]) else redis.call("DEL",KEYS[1]) end; end; redis.call("SADD",KEYS[2],ARGV[1]); redis.call("SET",KEYS[1],ARGV[1]); return ARGV[1]`,
  async (ctx, keys, args) => {
    const current = await ctx.get(keys[0]);
    if (current && current !== "") {
      const raw = await ctx.get("zp:waybill:" + current);
      if (raw) {
        const [ok, existing] = parseJSON(raw);
        if (ok && existing && typeof existing === "object" && existing.dailyDedupeKey === args[1]) {
          await ctx.sadd(keys[1], [current]);
          return current;
        }
        await ctx.del(keys[0]);
      } else {
        await ctx.del(keys[0]);
      }
    }
    await ctx.sadd(keys[1], [args[0]]);
    await ctx.set(keys[0], args[0]);
    return args[0];
  }
);

// ============ 34. 运单保存（process saveScript） ============
reg(
  `local fpKey=KEYS[1]; local wbKey=KEYS[2]; local idxKey=KEYS[3]; local dedupeKey=KEYS[4]; local sigId=redis.call("GET",dedupeKey); if sigId and sigId~="" then local raw=redis.call("GET","zp:waybill:"..sigId); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.dailyDedupeKey==ARGV[3] then redis.call("SADD",idxKey,sigId); return {"DAILY",sigId} end; if not ok or type(existing)~="table" or not existing.dailyDedupeKey then return {"VERIFY_DAILY",sigId} end; redis.call("DEL",dedupeKey) end; redis.call("DEL",dedupeKey) end; local fpId=redis.call("GET",fpKey); if fpId and fpId~=ARGV[1] then local raw=redis.call("GET","zp:waybill:"..fpId); if raw then local ok,existing=pcall(cjson.decode,raw); if ok and type(existing)=="table" and existing.businessFingerprint==ARGV[4] then redis.call("SADD",idxKey,fpId); return {"FINGERPRINT",fpId} end; if not ok or type(existing)~="table" or not existing.businessFingerprint then return {"VERIFY_FINGERPRINT",fpId} end; redis.call("DEL",fpKey) end; redis.call("DEL",fpKey) end; redis.call("SET",fpKey,ARGV[1]); redis.call("SET",wbKey,ARGV[2]); redis.call("SADD",idxKey,ARGV[1]); redis.call("SET",dedupeKey,ARGV[1]); return {"NEW",ARGV[1]}`,
  async (ctx, keys, args) => {
    const dedupeKey = keys[3];
    const sigId = await ctx.get(dedupeKey);
    if (sigId && sigId !== "") {
      const raw = await ctx.get("zp:waybill:" + sigId);
      if (raw) {
        const [ok, existing] = parseJSON(raw);
        if (ok && existing && typeof existing === "object" && existing.dailyDedupeKey === args[2]) {
          await ctx.sadd(keys[2], [sigId]);
          return ["DAILY", sigId];
        }
        if (!ok || typeof existing !== "object" || !existing.dailyDedupeKey) return ["VERIFY_DAILY", sigId];
        await ctx.del(dedupeKey);
      }
      await ctx.del(dedupeKey);    }
    const fpKey = keys[0];
    const fpId = await ctx.get(fpKey);
    if (fpId && fpId !== args[0]) {
      const raw = await ctx.get("zp:waybill:" + fpId);
      if (raw) {
        const [ok, existing] = parseJSON(raw);
        if (ok && existing && typeof existing === "object" && existing.businessFingerprint === args[3]) {
          await ctx.sadd(keys[2], [fpId]);
          return ["FINGERPRINT", fpId];
        }
        if (!ok || typeof existing !== "object" || !existing.businessFingerprint) return ["VERIFY_FINGERPRINT", fpId];
        await ctx.del(fpKey);
      }
      await ctx.del(fpKey);
    }
    await ctx.set(fpKey, args[0]);
    await ctx.set(keys[1], args[1]);
    await ctx.sadd(keys[2], [args[0]]);
    await ctx.set(dedupeKey, args[0]);
    return ["NEW", args[0]];
  }
);

// ============ 35. 运单去重校验修复 CAS-SADD（process VERIFY repair） ============
reg(
  `if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SADD",KEYS[2],ARGV[1]); return 1 end; return 0`,
  async (ctx, keys, args) => {
    const cur = await ctx.get(keys[0]);
    if (cur === args[0]) {
      await ctx.sadd(keys[1], [args[0]]);
      return 1;
    }
    return 0;
  }
);

// ============ 36. 运单确认提交（confirm commitScript） ============
reg(
  `local okOrder,order=pcall(cjson.decode,ARGV[1]); if not okOrder or type(order)~="table" then return 2 end; local rawDone=redis.call("GET",KEYS[2]); if rawDone then return 3 end; local existingFingerprint=redis.call("GET",KEYS[6]); if existingFingerprint and existingFingerprint~=order.id then return 7 end; local existingDaily=redis.call("GET",KEYS[7]); if existingDaily and existingDaily~=order.id then return 8 end; local okItems,items=pcall(cjson.decode,ARGV[2]); if not okItems or type(items)~="table" then return 4 end; for _,item in ipairs(items) do if type(item)~="table" or type(item.field)~="string" or item.field=="" or type(item.value)~="string" or item.value=="" then return 6 end end; if ARGV[3]~="" then local okBase,base=pcall(cjson.decode,ARGV[3]); if not okBase or type(base)~="table" then return 5 end end; if ARGV[3]~="" then redis.call("SET",KEYS[4],ARGV[3]) end; redis.call("SET",KEYS[1],ARGV[1]); redis.call("SET",KEYS[2],"1"); redis.call("SET",KEYS[6],order.id); redis.call("SET",KEYS[7],order.id); for _,item in ipairs(items) do redis.call("HSET",KEYS[3],item.field,item.value) end; if ARGV[4]~="" then redis.call("SADD",KEYS[5],order.id) end; return 1`,
  async (ctx, keys, args) => {
    const [okOrder, order] = parseJSON(args[0]);
    if (!okOrder || typeof order !== "object") return 2;
    const rawDone = await ctx.get(keys[1]);
    if (rawDone) return 3;
    const existingFingerprint = await ctx.get(keys[5]);
    if (existingFingerprint && existingFingerprint !== order.id) return 7;
    const existingDaily = await ctx.get(keys[6]);
    if (existingDaily && existingDaily !== order.id) return 8;
    const [okItems, items] = parseJSON(args[1]);
    if (!okItems || !Array.isArray(items)) return 4;
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.field !== "string" || item.field === "" || typeof item.value !== "string" || item.value === "") return 6;
    }
    if (args[2] && args[2] !== "") {
      const [okBase, base] = parseJSON(args[2]);
      if (!okBase || typeof base !== "object") return 5;
    }
    if (args[2] && args[2] !== "") await ctx.set(keys[3], args[2]);
    await ctx.set(keys[0], args[0]);
    await ctx.set(keys[1], "1");
    await ctx.set(keys[5], order.id);
    await ctx.set(keys[6], order.id);
    const entries = items.map((it) => [it.field, it.value]);
    await ctx.hset(keys[2], entries);
    if (args[3] && args[3] !== "") await ctx.sadd(keys[4], [order.id]);
    return 1;
  }
);

// ============ 37. 同日同线路取代（supersede） ============
reg(
  `local raw = redis.call("GET", KEYS[1])
if not raw then redis.call("SREM", KEYS[2], ARGV[1]); return 0 end
local ok, w = pcall(cjson.decode, raw)
if not ok or type(w) ~= "table" then return 0 end
if w.historyStatus == "SUPERSEDED" then redis.call("SREM", KEYS[2], ARGV[1]); return 0 end
if w.stage ~= "PLANNED" and w.stage ~= "CONFIRMED" then return 0 end
w.historyStatus = "SUPERSEDED"
w.supersededBy = ARGV[2]
w.supersededAt = ARGV[3]
w.supersededReason = "REUPLOAD_SAME_DAY"
redis.call("SET", KEYS[1], cjson.encode(w))
redis.call("SREM", KEYS[2], ARGV[1])
if w.dailyDedupeKey and w.dailyDedupeKey ~= "" then
  local dk = "zp:waybill:dedupe:" .. w.dailyDedupeKey
  if redis.call("GET", dk) == ARGV[1] then redis.call("DEL", dk) end
end
if w.businessFingerprint and w.businessFingerprint ~= "" then
  local fk = "zp:waybill:fingerprint:" .. w.businessFingerprint
  if redis.call("GET", fk) == ARGV[1] then redis.call("DEL", fk) end
end
return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) {
      await ctx.srem(keys[1], [args[0]]);
      return 0;
    }
    const [ok, w] = parseJSON(raw);
    if (!ok || typeof w !== "object") return 0;
    if (w.historyStatus === "SUPERSEDED") {
      await ctx.srem(keys[1], [args[0]]);
      return 0;
    }
    if (w.stage !== "PLANNED" && w.stage !== "CONFIRMED") return 0;
    w.historyStatus = "SUPERSEDED";
    w.supersededBy = args[1];
    w.supersededAt = args[2];
    w.supersededReason = "REUPLOAD_SAME_DAY";
    await ctx.set(keys[0], JSON.stringify(w));
    await ctx.srem(keys[1], [args[0]]);
    if (w.dailyDedupeKey && w.dailyDedupeKey !== "") {
      const dk = "zp:waybill:dedupe:" + w.dailyDedupeKey;
      if (await ctx.get(dk) === args[0]) await ctx.del(dk);
    }
    if (w.businessFingerprint && w.businessFingerprint !== "") {
      const fk = "zp:waybill:fingerprint:" + w.businessFingerprint;
      if (await ctx.get(fk) === args[0]) await ctx.del(fk);
    }
    return 1;
  }
);

// ============ 38. 处理状态机 claimSave ============
reg(
  `local raw=redis.call("GET",KEYS[1]); if not raw then return 0 end; local ok,rec=pcall(cjson.decode,raw); if not ok or type(rec)~="table" then return 0 end; if rec.stage=="CANCELLED" or rec.stage=="DONE" then return 0 end; if rec.saveClaimedAt then return 1 end; rec.saveClaimedAt=ARGV[1]; rec.updatedAt=ARGV[1]; rec.updatedAtBeijing=ARGV[2]; redis.call("SET",KEYS[1],cjson.encode(rec),"EX",ARGV[3]); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 0;
    const [ok, rec] = parseJSON(raw);
    if (!ok || typeof rec !== "object") return 0;
    if (rec.stage === "CANCELLED" || rec.stage === "DONE") return 0;
    if (rec.saveClaimedAt) return 1;
    rec.saveClaimedAt = args[0];
    rec.updatedAt = args[0];
    rec.updatedAtBeijing = args[1];
    await ctx.set(keys[0], JSON.stringify(rec), args[2]);
    return 1;
  }
);

// ============ 39. 处理状态机 cancel ============
reg(
  `local raw=redis.call("GET",KEYS[1]); if not raw then return 0 end; local ok,rec=pcall(cjson.decode,raw); if not ok or type(rec)~="table" then return 0 end; if rec.stage=="DONE" or rec.saveClaimedAt then return 0 end; rec.stage="CANCELLED"; rec.recoverable=true; rec.action=ARGV[1]; rec.hint=ARGV[2]; rec.detail=ARGV[3]; rec.updatedAt=ARGV[4]; rec.updatedAtBeijing=ARGV[5]; redis.call("SET",KEYS[1],cjson.encode(rec),"EX",ARGV[6]); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 0;
    const [ok, rec] = parseJSON(raw);
    if (!ok || typeof rec !== "object") return 0;
    if (rec.stage === "DONE" || rec.saveClaimedAt) return 0;
    rec.stage = "CANCELLED";
    rec.recoverable = true;
    rec.action = args[0];
    rec.hint = args[1];
    rec.detail = args[2];
    rec.updatedAt = args[3];
    rec.updatedAtBeijing = args[4];
    await ctx.set(keys[0], JSON.stringify(rec), args[5]);
    return 1;
  }
);

// ============ 40. 线路基准持久化（store-learn persistScript） ============
reg(
  `local okBase=redis.call("SET",KEYS[1],ARGV[1]); if not okBase then return 0 end; redis.call("HSET",KEYS[2],ARGV[2],ARGV[3]); return 1`,
  async (ctx, keys, args) => {
    await ctx.set(keys[0], args[0]);
    await ctx.hset(keys[1], [[args[1], args[2]]]);
    return 1;
  }
);

// ============ 41. 一致性修复 SADD+SREM（_consistency-repair） ============
reg(
  `redis.call('SADD',KEYS[1],ARGV[1]); return redis.call('SREM',KEYS[2],ARGV[2])`,
  async (ctx, keys, args) => {
    await ctx.sadd(keys[0], [args[0]]);
    return ctx.srem(keys[1], [args[1]]);
  }
);

// ============ 42. 线路巡检：清理孤儿占用槽（routes.js clear_orphan_route_slot） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local r=cjson.decode(raw); if r.id~=ARGV[1] or r[ARGV[2]]~=ARGV[3] then return 3 end; r[ARGV[2]]=cjson.null; redis.call('SET',KEYS[1],cjson.encode(r)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, r] = parseJSON(raw);
    if (!ok || typeof r !== "object") return 3;
    if (r.id !== args[0] || r[args[1]] === undefined || r[args[1]] !== args[2]) return 3;
    r[args[1]] = null;
    await ctx.set(keys[0], JSON.stringify(r));
    return 1;
  }
);

// ============ 43. 线路巡检：清理用户无效/缺失绑定（clear_invalid_user_binding / clear_missing_route_binding） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local u=cjson.decode(raw); if u.id~=ARGV[1] then return 3 end; u.boundRouteId=cjson.null; u.routeDuty=cjson.null; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object") return 2;
    if (u.id !== args[0]) return 3;
    u.boundRouteId = null;
    u.routeDuty = null;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 44. 线路巡检：恢复占用槽（restore_route_slot） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local r=cjson.decode(raw); if r.id~=ARGV[1] or r[ARGV[2]]~=nil then return 3 end; r[ARGV[2]]=ARGV[3]; redis.call('SET',KEYS[1],cjson.encode(r)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, r] = parseJSON(raw);
    if (!ok || typeof r !== "object") return 2;
    if (r.id !== args[0] || r[args[1]] !== undefined) return 3;
    r[args[1]] = args[2];
    await ctx.set(keys[0], JSON.stringify(r));
    return 1;
  }
);

// ============ 45. 线路巡检：清理冲突用户的绑定（clear_conflicting_user_binding） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local u=cjson.decode(raw); if u.id~=ARGV[1] or u.boundRouteId~=ARGV[2] or u.routeDuty~=ARGV[3] then return 3 end; u.boundRouteId=cjson.null; u.routeDuty=cjson.null; u.sessionVersion=(u.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(u)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object") return 2;
    if (u.id !== args[0] || u.boundRouteId !== args[1] || u.routeDuty !== args[2]) return 3;
    u.boundRouteId = null;
    u.routeDuty = null;
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 46. 线路创建（name 唯一校验 + 写入，routes.js create_route） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); local ids={}; if raw then local ok,v=pcall(cjson.decode,raw); if not ok or type(v)~='table' then return 4 end; ids=v end; for _,rid in ipairs(ids) do local rr=redis.call('GET','zp:route:'..rid); if rr then local ok,r=pcall(cjson.decode,rr); if ok and string.lower(tostring(r.name or ''))==string.lower(ARGV[2]) then return 2 end end end; redis.call('SET',KEYS[2],ARGV[1]); redis.call('SET',KEYS[3],ARGV[3]); table.insert(ids,ARGV[4]); redis.call('SET',KEYS[1],cjson.encode(ids)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    let ids = [];
    if (raw) {
      const [ok, v] = parseJSON(raw);
      if (!ok || !Array.isArray(v)) return 4;
      ids = v;
    }
    for (const rid of ids) {
      const rr = await ctx.get("zp:route:" + rid);
      if (rr) {
        const [okr, r] = parseJSON(rr);
        if (okr && r && typeof r === "object" && String(r.name || "").toLowerCase() === String(args[1]).toLowerCase()) return 2;
      }
    }
    await ctx.set(keys[1], args[0]);
    await ctx.set(keys[2], args[2]);
    ids.push(args[3]);
    await ctx.set(keys[0], JSON.stringify(ids));
    return 1;
  }
);

// ============ 47. 线路删除（原子删除主记录 + 索引 + 解绑用户，routes.js delete_route） ============
// 注意：源端原先在 JS 侧按绑定用户数展开 for 循环拼出脚本，导致运行时文本随用户数变化而长度不一，
// 无法用固定归一化键匹配。这里改为「固定 Lua + 内部 for 循环」，文本恒定，D1 与 Upstash 双路一致。
reg(
  `local rid=ARGV[1]
local newIndex=ARGV[2]
local boundCount=#KEYS-3
local raw=redis.call('GET',KEYS[1])
local ri=redis.call('GET',KEYS[2])
if not raw or not ri then return 2 end
local r=cjson.decode(raw)
local ids=cjson.decode(ri)
if r.id~=rid or type(ids)~='table' then return 3 end
for i=0,boundCount-1 do
  local k=4+i
  local idArg=3+i
  local dutyArg=3+boundCount+i
  local uraw=redis.call('GET',KEYS[k])
  if not uraw then return 4 end
  local ok,u=pcall(cjson.decode,uraw)
  if not ok or type(u)~='table' or u.id~=ARGV[idArg] or u.boundRouteId~=rid or u.routeDuty~=ARGV[dutyArg] then return 5 end
end
redis.call('SET',KEYS[2],newIndex)
for i=0,boundCount-1 do
  local k=4+i
  local jsonArg=3+2*boundCount+i
  redis.call('SET',KEYS[k],ARGV[jsonArg])
end
redis.call('DEL',KEYS[1])
redis.call('DEL',KEYS[3])return 1`,
  async (ctx, keys, args) => {
    const rid = args[0];
    const newIndex = args[1];
    const boundCount = keys.length - 3;
    const raw = await ctx.get(keys[0]);
    const ri = await ctx.get(keys[1]);
    if (!raw || !ri) return 2;
    const [okr, r] = parseJSON(raw);
    const [okids, ids] = parseJSON(ri);
    if (!okr || typeof r !== "object" || !okids || !Array.isArray(ids)) return 3;
    if (r.id !== rid) return 3;
    for (let i = 0; i < boundCount; i++) {
      const uraw = await ctx.get(keys[3 + i]);
      if (!uraw) return 4;
      const [oku, u] = parseJSON(uraw);
      if (!oku || typeof u !== "object" || u.id !== args[2 + i] || u.boundRouteId !== rid || u.routeDuty !== args[2 + boundCount + i]) return 5;
    }
    await ctx.set(keys[1], newIndex);
    // 写入循环从用户键起点开始（keys[3] 是 baseKey，由下方 DEL 删除，不在此写入）。
    for (let i = 0; i < boundCount; i++) {
      await ctx.set(keys[3 + i], args[2 + 2 * boundCount + i]);
    }
    await ctx.del(keys[0]);
    await ctx.del(keys[2]);
    return 1;
  }
);

// ============ 48. 调度：分配临时线路（dispatch.js temp route assign） ============
reg(
  `local raw=redis.call("GET",KEYS[1]);if not raw then return -1 end;local ok,u=pcall(cjson.decode,raw);if not ok or type(u)~="table" then return -2 end;if u.id~=ARGV[1] or u.disabled==true or u.role=="admin" then return -3 end;u.dispatchRouteId=ARGV[2];redis.call("SET",KEYS[1],cjson.encode(u));return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return -1;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object") return -2;
    if (u.id !== args[0] || u.disabled === true || u.role === "admin") return -3;
    u.dispatchRouteId = args[1];
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 49. 登录：用户名 → 用户连读（login.js LOOKUP_SCRIPT） ============
reg(
  `local id = redis.call('GET', KEYS[1])
if not id then return {false, false} end
local raw = redis.call('GET', ARGV[1] .. tostring(id))
if not raw then return {id, false} end
return {id, raw}`,
  async (ctx, keys, args) => {
    const id = await ctx.get(keys[0]);
    if (!id) return [null, null];
    const raw = await ctx.get(args[0] + id);
    if (!raw) return [id, null];
    return [id, raw];
  }
);

// ============ 50. 登录：存量账号哈希机会性升级（login.js UPGRADE_SCRIPT） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.id~=ARGV[3] then return 0 end; if u.passwordHash~=ARGV[1] then return 0 end; u.passwordHash=ARGV[2]; redis.call('SET',KEYS[1],cjson.encode(u)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 0;
    const [ok, u] = parseJSON(raw);
    if (!ok || typeof u !== "object") return 0;
    if (u.id !== args[2]) return 0;
    if (u.passwordHash !== args[0]) return 0;
    u.passwordHash = args[1];
    await ctx.set(keys[0], JSON.stringify(u));
    return 1;
  }
);

// ============ 51. 管理员启用用户（users.js ENABLE，禁用状态取反） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return 2 end; local ok,x=pcall(cjson.decode,raw); if not ok then return 3 end; if x.id~=ARGV[2] then return 4 end; if x.disabled~=true then return 5 end; x.disabled=false; x.sessionVersion=(x.sessionVersion or 1)+1; redis.call('SET',KEYS[1],cjson.encode(x)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return 2;
    const [ok, x] = parseJSON(raw);
    if (!ok || typeof x !== "object") return 3;
    if (x.id !== args[1]) return 4;
    if (x.disabled !== true) return 5;
    x.disabled = false;
    x.sessionVersion = (Number(x.sessionVersion) || 1) + 1;
    await ctx.set(keys[0], JSON.stringify(x));
    return 1;
  }
);

// ============ 52. 注册：消费邀请码创建用户（register.js） ============
reg(
  `local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end; local ok,c=pcall(cjson.decode,raw); if not ok or type(c)~='table' or type(c.id)~='string' or type(c.code)~='string' then return -6 end; if string.upper(c.code)~=ARGV[5] then return -6 end; local main=redis.call('GET','zp:invite-code:'..c.id); if not main then return -6 end; local okm,m=pcall(cjson.decode,main); if not okm or type(m)~='table' or m.id~=c.id or m.code~=c.code then return -6 end; if c.enabled==false or m.enabled==false then return -2 end; if c.expiresAt and c.expiresAt~='' and ARGV[4] >= string.sub(c.expiresAt,1,19) then return -3 end; local used=tonumber(c.usedCount or 0) or 0; local max=tonumber(c.maxUses or 0) or 0; if max>0 and used>=max then return -4 end; if redis.call('GET',KEYS[2]) then return -5 end; local rawIds=redis.call('GET',KEYS[4]); local arr={}; if rawIds then local okIds,v=pcall(cjson.decode,rawIds); if not okIds or type(v)~='table' then return -7 end; arr=v; for _,uid in ipairs(arr) do if type(uid)~='string' or uid=='' then return -7 end end end; local next=used+1; c.usedCount=next; m.usedCount=next; redis.call('SET',KEYS[1],cjson.encode(c)); redis.call('SET','zp:invite-code:'..c.id,cjson.encode(m)); redis.call('SET',KEYS[3],ARGV[1]); redis.call('SET',KEYS[2],ARGV[3]); table.insert(arr,ARGV[3]); redis.call('SET',KEYS[4],cjson.encode(arr)); return 1`,
  async (ctx, keys, args) => {
    const raw = await ctx.get(keys[0]);
    if (!raw) return -1;
    const [ok, c] = parseJSON(raw);
    if (!ok || typeof c !== "object" || typeof c.id !== "string" || typeof c.code !== "string") return -6;
    if (String(c.code).toUpperCase() !== String(args[4])) return -6;
    const main = await ctx.get("zp:invite-code:" + c.id);
    if (!main) return -6;
    const [okm, m] = parseJSON(main);
    if (!okm || typeof m !== "object" || m.id !== c.id || m.code !== c.code) return -6;
    if (c.enabled === false || m.enabled === false) return -2;
    if (c.expiresAt && c.expiresAt !== "" && args[3] >= String(c.expiresAt).slice(0, 19)) return -3;
    const used = Number(c.usedCount) || 0;
    const max = Number(c.maxUses) || 0;
    if (max > 0 && used >= max) return -4;
    if (await ctx.get(keys[1])) return -5;
    const rawIds = await ctx.get(keys[3]);
    let arr = [];
    if (rawIds) {
      const [okIds, v] = parseJSON(rawIds);
      if (!okIds || !Array.isArray(v)) return -7;
      arr = v;
      for (const uid of arr) if (typeof uid !== "string" || uid === "") return -7;
    }
    const next = used + 1;
    c.usedCount = next;
    m.usedCount = next;
    await ctx.set(keys[0], JSON.stringify(c));
    await ctx.set("zp:invite-code:" + c.id, JSON.stringify(m));
    await ctx.set(keys[2], args[0]);
    await ctx.set(keys[1], args[2]);
    arr.push(args[2]);
    await ctx.set(keys[3], JSON.stringify(arr));
    return 1;
  }
);

// ============ 53. 性能遥测聚合（perf-event.js LUA，含 HINCRBY / HINCRBYFLOAT） ============
reg(
  `local rate = tonumber(redis.call("INCR", KEYS[2]))
if rate == 1 then redis.call("EXPIRE", KEYS[2], 3600) end
if rate > 3000 then return -1 end
for i=1,#ARGV,8 do
  local page=ARGV[i]
  local endpoint=ARGV[i+1]
  local status=ARGV[i+2]
  local duration=tonumber(ARGV[i+3])
  local server=tonumber(ARGV[i+4])
  local hasServer=tonumber(ARGV[i+5])
  local phasesRaw=ARGV[i+6]
  local codeRaw=ARGV[i+7]
  if page and endpoint and status and duration then
    local base=page.."|"..endpoint.."|"..status.."|"
    redis.call("HINCRBY",KEYS[1],base.."count",1)
    redis.call("HINCRBYFLOAT",KEYS[1],base.."sum",duration)
    local old=tonumber(redis.call("HGET",KEYS[1],base.."max") or "0")
    if duration>old then redis.call("HSET",KEYS[1],base.."max",duration) end
    if hasServer==1 and server then
      redis.call("HINCRBY",KEYS[1],base.."server_count",1)
      redis.call("HINCRBYFLOAT",KEYS[1],base.."server_sum",server)
      local so=tonumber(redis.call("HGET",KEYS[1],base.."server_max") or "0")
      if server>so then redis.call("HSET",KEYS[1],base.."server_max",server) end
    end
    if (status=="4xx" or status=="5xx") and codeRaw and codeRaw~="" then
      local cd=base.."code:"..codeRaw.."|"
      redis.call("HINCRBY",KEYS[1],cd.."count",1)
      redis.call("HINCRBYFLOAT",KEYS[1],cd.."sum",duration)
      local cm=tonumber(redis.call("HGET",KEYS[1],cd.."max") or "0")
      if duration>cm then redis.call("HSET",KEYS[1],cd.."max",duration) end
      if hasServer==1 and server then
        redis.call("HINCRBY",KEYS[1],cd.."server_count",1)
        redis.call("HINCRBYFLOAT",KEYS[1],cd.."server_sum",server)
        local csm=tonumber(redis.call("HGET",KEYS[1],cd.."server_max") or "0")
        if server>csm then redis.call("HSET",KEYS[1],cd.."server_max",server) end
      end
    end
    if phasesRaw and phasesRaw~="" then
      local ok,phases=pcall(cjson.decode,phasesRaw)
      if ok and type(phases)=="table" then
        for name,dur in pairs(phases) do
          if string.match(name,"^history%-[a-z%-]+$") then
            local value=tonumber(dur)
            if value and value>=0 and value<=120000 then
              local phaseBase=base.."phase:"..name..":"
              redis.call("HINCRBY",KEYS[1],phaseBase.."count",1)
              redis.call("HINCRBYFLOAT",KEYS[1],phaseBase.."sum",value)
              local phaseMax=tonumber(redis.call("HGET",KEYS[1],phaseBase.."max") or "0")
              if value>phaseMax then redis.call("HSET",KEYS[1],phaseBase.."max",value) end
            end
          end
        end
      end
    end
  end
end
redis.call("EXPIRE",KEYS[1],1209600)
return 1`,
  async (ctx, keys, args) => {
    const rate = await ctx.incr(keys[1]);
    if (rate === 1) await ctx.expire(keys[1], 3600);
    if (rate > 3000) return -1;
    for (let i = 0; i + 7 < args.length; i += 8) {
      const page = args[i], endpoint = args[i + 1], status = args[i + 2];
      const duration = Number(args[i + 3]);
      const server = Number(args[i + 4]);
      const hasServer = Number(args[i + 5]);
      const phasesRaw = args[i + 6];
      const codeRaw = args[i + 7];
      if (page && endpoint && status && duration) {
        const base = page + "|" + endpoint + "|" + status + "|";
        await ctx.hincrby(keys[0], base + "count", 1);
        await ctx.hincrbyfloat(keys[0], base + "sum", duration);
        const old = Number(await ctx.hget(keys[0], base + "max")) || 0;
        if (duration > old) await ctx.hset(keys[0], [[base + "max", String(duration)]]);
        if (hasServer === 1 && server) {
          await ctx.hincrby(keys[0], base + "server_count", 1);
          await ctx.hincrbyfloat(keys[0], base + "server_sum", server);
          const so = Number(await ctx.hget(keys[0], base + "server_max")) || 0;
          if (server > so) await ctx.hset(keys[0], [[base + "server_max", String(server)]]);
        }
        if ((status === "4xx" || status === "5xx") && codeRaw && codeRaw !== "") {
          const cd = base + "code:" + codeRaw + "|";
          await ctx.hincrby(keys[0], cd + "count", 1);
          await ctx.hincrbyfloat(keys[0], cd + "sum", duration);
          const cm = Number(await ctx.hget(keys[0], cd + "max")) || 0;
          if (duration > cm) await ctx.hset(keys[0], [[cd + "max", String(duration)]]);
          if (hasServer === 1 && server) {
            await ctx.hincrby(keys[0], cd + "server_count", 1);
            await ctx.hincrbyfloat(keys[0], cd + "server_sum", server);
            const csm = Number(await ctx.hget(keys[0], cd + "server_max")) || 0;
            if (server > csm) await ctx.hset(keys[0], [[cd + "server_max", String(server)]]);
          }
        }
        if (phasesRaw && phasesRaw !== "") {
          const [ok, phases] = parseJSON(phasesRaw);
          if (ok && phases && typeof phases === "object") {
            for (const name of Object.keys(phases)) {
              if (/^history-[a-z-]+$/.test(name)) {
                const value = Number(phases[name]);
                if (value != null && value >= 0 && value <= 120000) {
                  const phaseBase = base + "phase:" + name + ":";
                  await ctx.hincrby(keys[0], phaseBase + "count", 1);
                  await ctx.hincrbyfloat(keys[0], phaseBase + "sum", value);
                  const phaseMax = Number(await ctx.hget(keys[0], phaseBase + "max")) || 0;
                  if (value > phaseMax) await ctx.hset(keys[0], [[phaseBase + "max", String(value)]]);
                }
              }
            }
          }
        }
      }
    }
    await ctx.expire(keys[0], 1209600);
    return 1;
  }
);

// 注册表统计（便于自测/排障）
export const EVAL_HANDLER_COUNT = HANDLERS.size;
export { HANDLERS };
export default { lookupEval, EVAL_HANDLER_COUNT, HANDLERS };