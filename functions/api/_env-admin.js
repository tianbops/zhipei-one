// 环境变量管理员：把管理员做成"环境常量"，数据库清空也清不掉。
//
// 背景（2026-10-18 事故）：Redis 迁库时数据没搬就删了旧库，新库为空，
// 于是"没有管理员 → 不能建邀请码 → 不能注册任何用户"死锁，系统彻底进不去。
// 管理员以前只存在数据库里，库没了人就没了。
//
// 约定：CF Pages 环境变量 ADMIN_USERNAME + ADMIN_PASSWORD_HASH。
// 哈希两种格式都认（与 _password.js 对齐）：
//   旧：64 位 hex 裸 SHA-256（tools/gen-admin-hash.mjs 的历史产物）
//   新：pbkdf2$<iter>$<salt>$<hash>（推荐，用新的 gen-admin-hash 生成）
// 登录时用这两个值"播种"：库里没有就把管理员补回库里，哈希不一致则以环境变量为准
// ——所以改环境变量就能重置管理员密码，清库后也能照常登录。
import {get, command} from "./_redis.js";
import {isPbkdf2Hash} from "./_password.js";

const ENV_ADMIN_ID = "env-admin";
// 旧格式是 hex，大小写不敏感；新格式是 base64url，**大小写敏感**，所以不能整体 toLowerCase
const HEX64 = /^[0-9a-f]{64}$/i;

export function envAdminId(){ return ENV_ADMIN_ID; }

// 返回 null 表示"未配置环境变量管理员"。哈希格式不对就当没配，绝不带病工作。
export function envAdminCredentials(env){
  const username = String(env?.ADMIN_USERNAME ?? "").trim();
  let passwordHash = String(env?.ADMIN_PASSWORD_HASH ?? "").trim();
  if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) return null;
  if (HEX64.test(passwordHash)) passwordHash = passwordHash.toLowerCase();   // 旧格式：统一成小写 hex
  else if (!isPbkdf2Hash(passwordHash)) return null;                        // 新格式：pbkdf2$...，原样保留
  return {username, passwordHash};
}

// Lua 只负责"原子地把 JS 造好的 user JSON 落库"，不在 Lua 里拼对象：
// 测试用的 MiniRedis 只有 cjson.decode/encode，没有 cjson.null。
const SEED_SCRIPT = `
local idsRaw = redis.call('GET', KEYS[3])
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
return 1
`;

/**
 * 「已拿到管理员记录」版本的播种判断（P2-12 登录并行化）
 * ------------------------------------------------------------------
 * 与 ensureEnvAdmin 的唯一区别是**不自己读库**：记录由调用方在并行批里顺手读回来，
 * 这里只负责「要不要播种」。这样登录路径能把「读管理员」和「读用户名索引」合成一轮，
 * 省下一次跨境往返（Workers→Upstash 中位 186ms）。
 *
 * @returns {string|null} 播种后写库的用户 JSON 字符串；已就绪返回 null
 */
export async function ensureEnvAdminFromRecord(env, cred, raw){
  const id = ENV_ADMIN_ID;
  let current = null;
  try { current = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null; } catch { current = null; }
  if (
    current && current.role === "admin" &&
    String(current.username ?? "").toLowerCase() === cred.username.toLowerCase() &&
    current.passwordHash === cred.passwordHash
  ) return null;   // 已就绪，不写库

  const createdAt = (current && current.createdAt) ? current.createdAt : new Date().toISOString();
  const user = {
    id,
    username: cred.username,
    name: "系统管理员",
    role: "admin",
    disabled: false,
    boundRouteId: null,
    routeDuty: null,
    dispatchRouteId: null,
    sessionVersion: 1,
    passwordHash: cred.passwordHash,
    createdAt,
  };
  await command(env, [
    "EVAL", SEED_SCRIPT, "3",
    "zp:user:" + id,
    "zp:user:index:" + cred.username.toLowerCase(),
    "zp:users:index",
    JSON.stringify(user),
    id,
  ]);
  return JSON.stringify(user);
}

// 登录路径调用：用户名命中环境变量管理员时，确保库里的管理员记录存在且密码哈希与环境变量一致。
// 已就绪就一个字都不写（避免每次登录都浪费一次写往返）。
export async function ensureEnvAdmin(env, username){
  const cred = envAdminCredentials(env);
  if (!cred) return null;
  if (String(username ?? "").trim().toLowerCase() !== cred.username.toLowerCase()) return null;
  const raw = await get(env, "user:" + ENV_ADMIN_ID);
  const written = await ensureEnvAdminFromRecord(env, cred, raw);
  return written ? ENV_ADMIN_ID : null;
}
