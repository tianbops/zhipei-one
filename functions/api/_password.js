/**
 * 智配One · 口令哈希（P0-6）
 * ------------------------------------------------------------------
 * 背景：旧实现是 `SHA-256(password)` 的裸哈希（login.js 内的 hash()），**无盐**。
 * 后果：同一个密码在任何账号上得到同一个哈希——任何人拿到库都能直接查彩虹表反查明文，
 * 且能一眼看出「哪些账号用了同一个密码」。这在共享 Redis 里等同于明文泄露。
 *
 * 现在改为 PBKDF2-HMAC-SHA256 + 每账号随机 16 字节盐：
 *   pbkdf2$<iterations>$<salt(base64url)>$<hash(base64url)>
 *
 * 【迭代次数为什么写进字符串里】
 * 迭代数存在哈希值内部，因此未来调高迭代数**不需要迁移**：
 * 老哈希按自己记录的迭代数校验，新写入的用新默认值。这是唯一能平滑演进的做法。
 *
 * 【迭代次数为什么默认 10000 而不是 OWASP 的 600000】
 * 这是 Cloudflare Workers 的 CPU 预算决定的，不是偷懒。实测（Node/OpenSSL，与 Workers
 * 的 BoringSSL 同量级）：1k=0.6ms / 5k=2.3ms / 10k=5.2ms / 20k=12ms / 50k=36ms / 100k=46ms。
 * Workers 免费版每请求 CPU 约 10ms，登录还要跑 1~3 次 Redis 往返，
 * 10k（≈5ms）是当前平台上「不触发 CPU 超限」的安全上限。
 * 真要更强请设环境变量 PASSWORD_PBKDF2_ITERATIONS（1000~200000，越界回退默认值）。
 *
 * 【兼容性】verifyPassword 同时接受新旧两种格式：
 *   - 旧：64 位 hex（裸 SHA-256）——存量账号、以及环境变量管理员 ADMIN_PASSWORD_HASH
 *   - 新：pbkdf2$... ——注册 / 改密 / 重置 时写入
 * 因此本改动**不需要**一次性重置全库密码；存量账号在下次登录成功时被机会性升级（见 login.js）。
 *
 * 【不做的事】不要把旧哈希「自动降级」成新格式的判断交给调用方：
 * 校验一律走 verifyPassword，比较一律不要在调用方写 `!==`。
 */
const PREFIX = "pbkdf2";
const DEFAULT_ITERATIONS = 10000;
const MIN_ITERATIONS = 1000;      // 环境变量下限，防手滑配成 1
const MAX_ITERATIONS = 200000;    // 环境变量上限，防把自己 CPU 打爆
const SALT_BYTES = 16;
const KEY_BITS = 256;
const LEGACY_HEX64 = /^[0-9a-f]{64}$/;

/** base64url 编码（无填充）：Redis 里存的是字符串，$ 是分隔符，= 和 +/ 都要避开 */
function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 恒定时间比较：长度也纳入结果，避免用「比较提前返回」的耗时侧信道逐字节猜哈希 */
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

function iterationsFromEnv(env) {
  const raw = Number(env?.PASSWORD_PBKDF2_ITERATIONS);
  if (!Number.isFinite(raw) || raw < MIN_ITERATIONS || raw > MAX_ITERATIONS) return DEFAULT_ITERATIONS;
  return Math.floor(raw);
}

async function pbkdf2Bits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(password ?? "")), "PBKDF2", false, ["deriveBits"]
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, KEY_BITS
  ));
}

/** 生成新格式哈希。env 可省略（此时用默认迭代数）。 */
export async function hashPassword(password, env) {
  const iterations = iterationsFromEnv(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await pbkdf2Bits(password, salt, iterations);
  return PREFIX + "$" + iterations + "$" + b64urlEncode(salt) + "$" + b64urlEncode(bits);
}

/** 旧格式裸 SHA-256（64 位 hex）。仅用于校验存量数据，不要再用于写入。 */
export async function legacyHash(password) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(password ?? "")));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export function isPbkdf2Hash(stored) {
  return typeof stored === "string" && stored.startsWith(PREFIX + "$");
}
/** 旧格式（裸 SHA-256 hex）：存量账号与环境变量管理员都可能是这种 */
export function isLegacyHash(stored) {
  return typeof stored === "string" && LEGACY_HEX64.test(String(stored).trim().toLowerCase());
}
/** 是否是「需要升级」的旧格式——给 login 的机会性升级用 */
export function needsUpgrade(stored) { return isLegacyHash(stored); }

/**
 * 校验口令。新旧格式通吃；格式不认识一律 false（绝不因为「看不懂」就放行）。
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const s = String(stored ?? "").trim();
  if (isPbkdf2Hash(s)) {
    const parts = s.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1000000) return false;
    let salt, expected;
    try {
      salt = b64urlDecode(parts[2]);
      expected = b64urlDecode(parts[3]);
    } catch { return false; }
    if (!salt.length || !expected.length) return false;
    const bits = await pbkdf2Bits(password, salt, iterations);
    return timingSafeEqual(bits, expected);
  }
  if (isLegacyHash(s)) {
    return timingSafeEqual(
      new TextEncoder().encode(await legacyHash(password)),
      new TextEncoder().encode(s.toLowerCase())
    );
  }
  return false;
}

export default { hashPassword, verifyPassword, legacyHash, isPbkdf2Hash, isLegacyHash, needsUpgrade };
