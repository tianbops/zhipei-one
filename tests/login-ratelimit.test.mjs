/**
 * 登录限流守门测试（P0-7）
 * ------------------------------------------------------------------
 * 被测问题：登录与注册此前**没有任何失败次数限制**。
 * 于是口令可以无限次猜、邀请码可以无限次枚举（邀请码是唯一注册入口）。
 *
 * 这里用 tests/_mini-redis.cjs（带真 Lua 解释器）跑**真实登录流程**，
 * 而不是只测限流函数：限流装没装上、阈值对不对、成功会不会清计数，
 * 只有在完整链路里才测得出来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MiniRedis, makeUpstash } from "./_mini-redis.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const imp = p => import(pathToFileURL(path.join(root, p)).href);

const redis = new MiniRedis();
makeUpstash(redis);

const { hashPassword, legacyHash } = await imp("functions/api/_password.js");
const { peek, bump, clear, firstExceeded, scopePart, clientIp } = await imp("functions/api/_ratelimit.js");
const login = await imp("functions/api/login.js");

const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "test" };
const req = (username, password, ip = "203.0.113.9") => ({
  json: async () => ({ username, password }),
  headers: { get: n => (n.toLowerCase() === "cf-connecting-ip" ? ip : null) },
});

async function seedUser(username, password, { legacy = false } = {}) {
  const id = "u-" + username;
  const passwordHash = legacy ? await legacyHash(password) : await hashPassword(password, env);
  redis.command(["SET", "zp:user:index:" + username.toLowerCase(), id]);
  redis.command(["SET", "zp:user:" + id, JSON.stringify({
    id, username, name: username, role: "user", disabled: false,
    boundRouteId: null, routeDuty: null, dispatchRouteId: null,
    sessionVersion: 1, passwordHash, createdAt: new Date().toISOString(),
  })]);
  return id;
}

test("限流原语：peek/bump/clear 与 TTL", async () => {
  const scopes = ["test:a", "test:b"];
  const p0 = await peek(env, scopes);
  assert.equal(p0.length, 2, "两个桶一次往返读完");
  assert.deepEqual(p0.map(s => s.count), [0, 0]);

  const b1 = await bump(env, scopes, 900);
  assert.deepEqual(b1.map(s => s.count), [1, 1], "两个桶一次往返各自增一次");
  assert.ok(b1[0].retryAfter > 0 && b1[0].retryAfter <= 900, "首次自增即设 TTL");

  await bump(env, scopes, 900);
  assert.deepEqual((await peek(env, scopes)).map(s => s.count), [2, 2]);

  await clear(env, scopes);
  assert.deepEqual((await peek(env, scopes)).map(s => s.count), [0, 0], "clear 后计数归零");
});

test("限流原语：阈值判定与失败放行", async () => {
  // 每个桶各按自己的阈值判定（账号桶 10、IP 桶 40），不能张冠李戴
  assert.equal(firstExceeded([{ count: 9 }, { count: 39 }], [10, 40]), -1, "两个桶都没到阈值 → 放行");
  assert.equal(firstExceeded([{ count: 10 }, { count: 0 }], [10, 40]), 0, "账号桶满 10 次 → 拦（返回桶下标）");
  assert.equal(firstExceeded([{ count: 0 }, { count: 40 }], [10, 40]), 1, "IP 桶满 40 次 → 拦");
  assert.equal(firstExceeded([{ count: 9 }, { count: 40 }], [10, 40]), 1, "一个超限即拦，返回最先超限的那个");

  // Redis 不可用（fetch 抛错）时必须放行，限流不该成为新的故障源
  const saved = global.fetch;
  global.fetch = async () => { throw new Error("REDIS_DOWN"); };
  try {
    const r = await peek(env, ["x"]);
    assert.equal(r[0].count, 0, "Redis 挂了不拦人（fail-open）");
    assert.equal(r[0].degraded, true);
  } finally { global.fetch = saved; }
});

test("限流原语：键片段必须被消毒（用户名不能破坏键结构）", () => {
  // trim 先去掉首尾空白，再把空格/换行等危险字符压成下划线，避免用户名把 $ 或换行塞进键名
  assert.equal(scopePart("Cs 1234\n"), "cs_1234");
  assert.equal(scopePart(""), "unknown");
  assert.equal(scopePart(null), "unknown");
  assert.equal(clientIp({ headers: { get: n => n === "cf-connecting-ip" ? " 1.2.3.4 " : null } }), "1.2.3.4");
  assert.equal(clientIp({ headers: { get: () => null } }), "unknown");
});

test("登录：连续失败到第 11 次被限流（单账号上限 10）", async () => {
  await seedUser("rl-user", "correct-pw");
  for (let i = 1; i <= 10; i++) {
    const res = await login.onRequestPost({ request: req("rl-user", "wrong-pw"), env });
    assert.equal(res.status, 401, `第 ${i} 次错误密码应仍是 401（还没到上限）`);
  }
  const blocked = await login.onRequestPost({ request: req("rl-user", "wrong-pw"), env });
  assert.equal(blocked.status, 429, "第 11 次必须被限流");
  const body = await blocked.json();
  assert.equal(body.success, false);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0, "429 必须带 Retry-After，客户端才知道等多久");
});

test("登录：正确密码不受限流影响，且成功后清零失败计数", async () => {
  await seedUser("rl-user2", "correct-pw");
  // 制造 3 次失败
  for (let i = 0; i < 3; i++) {
    await login.onRequestPost({ request: req("rl-user2", "nope"), env });
  }
  assert.equal((await peek(env, ["login:u:rl-user2"]))[0].count, 3);

  const ok = await login.onRequestPost({ request: req("rl-user2", "correct-pw"), env });
  assert.equal(ok.status, 200, "正确密码不该被限流牵连");
  const body = await ok.json();
  assert.equal(body.success, true);
  assert.equal((await peek(env, ["login:u:rl-user2"]))[0].count, 0, "登录成功后失败计数应清零");
});

test("登录：限流按账号隔离，一个账号被锁不影响其他账号", async () => {
  await seedUser("rl-a", "pw-a");
  await seedUser("rl-b", "pw-b");
  for (let i = 0; i < 10; i++) await login.onRequestPost({ request: req("rl-a", "wrong"), env });
  assert.equal((await login.onRequestPost({ request: req("rl-a", "wrong"), env })).status, 429);
  // rl-b 同一个 IP，但走的是自己的账号桶
  const res = await login.onRequestPost({ request: req("rl-b", "wrong"), env });
  assert.equal(res.status, 401, "rl-b 未被连带锁定");
});

test("登录：旧格式哈希能登录，且登录成功即被升级为新格式", async () => {
  const id = await seedUser("rl-legacy", "old-pw", { legacy: true });
  const ok = await login.onRequestPost({ request: req("rl-legacy", "old-pw"), env });
  assert.equal(ok.status, 200, "存量裸 SHA-256 账号必须仍能登录");

  const after = JSON.parse(redis.command(["GET", "zp:user:" + id]));
  assert.ok(after.passwordHash.startsWith("pbkdf2$"), "登录成功后哈希应已就地升级为 PBKDF2");
  // 升级后依然能用同一密码登录
  const again = await login.onRequestPost({ request: req("rl-legacy", "old-pw"), env });
  assert.equal(again.status, 200, "升级后原密码继续可用（用户无感）");
});

test("登录：IP 桶独立于账号桶（换账号撞库也会撞到 IP 上限）", async () => {
  for (let i = 0; i < 12; i++) await seedUser("rl-ip" + i, "pw" + i);
  // 同一 IP、不同账号各错一次：账号桶远没满，IP 桶在累积
  for (let i = 0; i < 40; i++) {
    const res = await login.onRequestPost({ request: req("rl-ip" + (i % 12), "wrong", "198.51.100.7"), env });
    assert.equal(res.status, 401, `第 ${i + 1} 次（IP 桶未满）应仍为 401`);
  }
  const res = await login.onRequestPost({ request: req("rl-ip0", "wrong", "198.51.100.7"), env });
  assert.equal(res.status, 429, "IP 桶到 40 次后必须拦住（挡撞库与用户名枚举）");
});

test("登录：账号不存在也计入失败（防用户名枚举）", async () => {
  const saved = (await peek(env, ["login:u:rl-ghost"]))[0].count;
  await login.onRequestPost({ request: req("rl-ghost", "whatever"), env });
  const now = (await peek(env, ["login:u:rl-ghost"]))[0].count;
  assert.equal(now, saved + 1, "不存在的账号也计数，否则可无限枚举用户名");
});
