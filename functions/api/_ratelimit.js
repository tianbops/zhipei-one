/**
 * 智配One · 登录/注册限流（P0-7）
 * ------------------------------------------------------------------
 * 背景：登录与注册此前**完全没有失败次数限制**（实测：login.js / register.js 中
 * `attempt|throttle|tooMany|429|rateLimit` 命中数为 0）。后果有两层：
 *   1. 口令爆破：对同一个账号无限次猜密码，没有任何节流；
 *   2. 邀请码爆破：注册只校验邀请码是否正确，可被无限次枚举（邀请码是唯一注册入口）。
 *
 * 为什么用「先查后计」而不是「每次都自增再判断」：
 *   登录成功也要自增的话，就必须在成功后 DEL 一次把计数清掉，
 *   等于给每一次正常登录多加一次跨境写往返（Workers→Upstash 中位 186ms）。
 *   改成入口只读一次（peek）、失败才写（bump）、成功仅在有历史失败时才清（clear），
 *   正常登录的额外成本是 1 次只读往返，失败路径才是 1 读 + 1 写。
 *
 * 为什么多个桶要一次 Lua 打完：同上，一次往返 = 一次 186ms，两个桶（账号 + IP）
 * 合成一次请求，而不是两次。
 *
 * 【失败放行 fail-open】Redis 异常时一律返回 count=0（不拦人）。限流是防护不是鉴权，
 * 不该成为「Redis 抖一下全站登不进去」的新故障源；真到 Redis 挂了，登录本来也会在
 * 读用户那一步失败，所以放行并不会削弱安全性。
 *
 * 【键一定有 TTL】窗口到期自动消失，不留无界键空间（见过 zp:session:* 裸 SET 无界增长的教训）。
 */
import { command } from "./_redis.js";

// 一次往返读多个桶：返回 [count1, ttl1, count2, ttl2, ...]
const PEEK_SCRIPT = `
local out = {}
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0') or 0
  out[#out + 1] = n
  out[#out + 1] = redis.call('TTL', KEYS[i])
end
return out
`;

// 一次往返自增多个桶（首次自增时设过期）：返回同构数组
const BUMP_SCRIPT = `
local out = {}
for i = 1, #KEYS do
  local n = redis.call('INCR', KEYS[i])
  if n == 1 then redis.call('EXPIRE', KEYS[i], ARGV[1]) end
  out[#out + 1] = n
  out[#out + 1] = redis.call('TTL', KEYS[i])
end
return out
`;

// 键统一加 zp: 前缀（_redis.js 的 command() 收的是**全限定键**，与 get() 内部加前缀不同）
const KEY_PREFIX = "zp:rl:";
function keys(scopes) { return (Array.isArray(scopes) ? scopes : [scopes]).map(s => KEY_PREFIX + String(s)); }

function shape(raw, scopes) {
  const flat = Array.isArray(raw) ? raw : [];
  const n = Array.isArray(scopes) ? scopes.length : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const count = Number(flat[i * 2]);
    const ttl = Number(flat[i * 2 + 1]);
    out.push({
      count: Number.isFinite(count) ? count : 0,
      retryAfter: Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
      degraded: false,
    });
  }
  return out;
}
const DEGRADED_ONE = { count: 0, retryAfter: 0, degraded: true };
function degraded(scopes) {
  const n = Array.isArray(scopes) ? scopes.length : 1;
  return Array.from({ length: n }, () => ({ ...DEGRADED_ONE }));
}

/** 只读当前计数（不产生写操作）。Redis 不可用时返回 count=0（放行）。 */
export async function peek(env, scopes) {
  const ks = keys(scopes);
  if (!ks.length) return [];
  try { return shape(await command(env, ["EVAL", PEEK_SCRIPT, String(ks.length), ...ks]), scopes); }
  catch { return degraded(scopes); }
}

/** 失败一次：自增计数。窗口首次被触碰时自动设 TTL。 */
export async function bump(env, scopes, windowSeconds) {
  const ks = keys(scopes);
  if (!ks.length) return [];
  const win = Number(windowSeconds);
  if (!Number.isFinite(win) || win < 1) return degraded(scopes);
  try {
    return shape(await command(env, ["EVAL", BUMP_SCRIPT, String(ks.length), ...ks, String(Math.floor(win))]), scopes);
  } catch { return degraded(scopes); }
}

/** 清空计数（登录成功后调用，别让正常用户背着历史失败计数）。 */
export async function clear(env, scopes) {
  const ks = keys(scopes);
  if (!ks.length) return true;
  try { await command(env, ["DEL", ...ks]); return true; } catch { return false; }
}

/**
 * 客户端 IP。Cloudflare 下取 CF-Connecting-IP；其他网关退化为 x-forwarded-for 首段。
 * 取不到返回 "unknown"：此时所有未知来源共用同一个桶，比不限流好，但别把 limit 定太小。
 */
export function clientIp(request) {
  try {
    const cf = request?.headers?.get?.("cf-connecting-ip");
    if (cf && String(cf).trim()) return String(cf).trim();
    const xff = request?.headers?.get?.("x-forwarded-for");
    if (xff && String(xff).trim()) return String(xff).split(",")[0].trim();
  } catch {}
  return "unknown";
}

/** 把任意字符串压成安全的键片段（用户名/IP 都过这里，防止换行等字符破坏键结构） */
export function scopePart(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "_").slice(0, 64) || "unknown";
}

/**
 * 按「各桶各自的 limit」判断是否超限。
 * @returns {number} 超限的桶下标；-1 表示全部放行
 */
export function firstExceeded(states, limits) {
  for (let i = 0; i < states.length; i++) {
    const lim = Number(Array.isArray(limits) ? limits[i] : limits);
    if (Number.isFinite(lim) && states[i].count >= lim) return i;
  }
  return -1;
}

export default { peek, bump, clear, clientIp, scopePart, firstExceeded };
