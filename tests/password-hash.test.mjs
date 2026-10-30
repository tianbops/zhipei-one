/**
 * 口令哈希守门测试（P0-6）
 * ------------------------------------------------------------------
 * 被测问题：旧实现是 `SHA-256(password)` 的**裸哈希**，无盐。
 * 后果不是理论上的：同一个密码在任何账号上得到同一个哈希 → 彩虹表可反查，
 * 且能一眼看出哪些账号共用密码。
 *
 * 这里钉死三件事：
 *   1. 新哈希必须带随机盐（同密码两次结果不同）；
 *   2. 新旧格式都要能校验通过（存量账号不能因为升级而被锁在外面）；
 *   3. 看不懂的格式一律拒绝（绝不能因为"不认识"就放行）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const mod = await import(pathToFileURL(path.join(root, "functions/api/_password.js")).href);
const { hashPassword, verifyPassword, legacyHash, isPbkdf2Hash, isLegacyHash, needsUpgrade } = mod;

test("新格式：结构正确且带随机盐", async () => {
  const a = await hashPassword("123456");
  const b = await hashPassword("123456");
  assert.match(a, /^pbkdf2\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/, "哈希必须符合 pbkdf2$iter$salt$hash");
  assert.notEqual(a, b, "同一个密码两次哈希必须不同（否则说明盐没生效）");
  const iter = Number(a.split("$")[1]);
  assert.ok(iter >= 1000 && iter <= 200000, "迭代数必须落在平台可承受区间，实测 10k≈5ms");
  assert.ok(isPbkdf2Hash(a) && !isLegacyHash(a));
  assert.equal(needsUpgrade(a), false, "新格式不需要升级");
});

test("新格式：正确密码通过、错误密码拒绝", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("旧格式：裸 SHA-256 hex 仍然能登录（存量账号不被锁死）", async () => {
  const legacy = await legacyHash("123456");
  assert.equal(isLegacyHash(legacy), true);
  assert.equal(needsUpgrade(legacy), true, "旧格式应被标记为待升级");
  assert.equal(await verifyPassword("123456", legacy), true);
  assert.equal(await verifyPassword("123457", legacy), false);
});

test("未知/损坏格式一律拒绝，绝不因为看不懂就放行", async () => {
  for (const bad of ["", null, undefined, "garbage", "pbkdf2$", "pbkdf2$a$b$c", "pbkdf2$0$AAAA$BBBB"]) {
    assert.equal(await verifyPassword("123456", bad), false, `格式 ${JSON.stringify(bad)} 必须拒绝`);
  }
});

test("迭代数写进哈希串：记录多少就按多少校验（未来调高无需迁移）", async () => {
  const low = await hashPassword("pw", { PASSWORD_PBKDF2_ITERATIONS: 1000 });
  assert.equal(low.split("$")[1], "1000");
  assert.equal(await verifyPassword("pw", low), true, "按串内记录的迭代数校验，而非当前默认值");
  // 越界的迭代数回退默认值，不允许把自己 CPU 打爆
  const silly = await hashPassword("pw", { PASSWORD_PBKDF2_ITERATIONS: 99999999 });
  assert.equal(silly.split("$")[1], "10000");
  const tiny = await hashPassword("pw", { PASSWORD_PBKDF2_ITERATIONS: 1 });
  assert.equal(tiny.split("$")[1], "10000");
});

test("单次哈希成本可控（Workers CPU 预算）", async () => {
  // 决定 CPU 成本的是迭代数，不是墙钟。并行测试下用例互相抢 CPU，
  // 原本 40ms 的墙钟断言会随机假红（实测单跑 4~11ms，满载可超 40ms）。
  // 护栏改成「直接断言迭代数」——与环境负载无关，且正是要防的东西。
  const out = await hashPassword("123456");
  assert.equal(out.split("$")[1], "10000", "默认迭代数必须保持 10000");

  // 再留一条宽松的墙钟断言，只拦「把迭代数配成几十万、Workers 直接超时」这类灾难。
  const t0 = performance.now();
  await hashPassword("123456");
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `单次哈希 ${ms.toFixed(1)}ms 应在 200ms 内（迭代数护栏见上一条；此处只防灾难性配置）`);
});
