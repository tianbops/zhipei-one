// 生成环境变量管理员的密码哈希（ADMIN_PASSWORD_HASH）。
//
// 默认输出**新格式** pbkdf2$<iterations>$<salt>$<hash>（与 functions/api/_password.js 同算法）：
//   node tools/gen-admin-hash.mjs '你的管理员密码'
// 仍要旧格式（64 位小写 hex 裸 SHA-256）时加 --legacy：
//   node tools/gen-admin-hash.mjs '密码' --legacy
//
// 为什么推荐新格式：旧格式**无盐**，同一个密码在任何地方都得到同一个哈希，能直接查彩虹表。
// 两种格式服务端都认（_env-admin.js / _password.js），可平滑替换：
//   换哈希 = 改管理员密码，改完重新部署一次（环境变量靠部署生效）。
//
// 密码只在你自己机器上出现，别贴给别人。
const args = process.argv.slice(2);
const legacy = args.includes("--legacy");
const password = args.find(a => !a.startsWith("--"));
if (!password) {
  console.error("用法: node tools/gen-admin-hash.mjs <管理员密码> [--legacy]");
  process.exit(1);
}
if (password.length < 8) {
  console.error("密码至少 8 位（与注册接口的校验一致）");
  process.exit(1);
}

const ITERATIONS = 10000;   // 与 _password.js 的 DEFAULT_ITERATIONS 保持一致
const SALT_BYTES = 16;
const KEY_BITS = 256;

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let out;
if (legacy) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  out = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
} else {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, KEY_BITS
  ));
  out = ["pbkdf2", ITERATIONS, b64url(salt), b64url(bits)].join("$");
}

console.log(out);
console.error(
  "\n把上面这串填到 Cloudflare Pages 环境变量 ADMIN_PASSWORD_HASH，\n" +
  "并把账号名填到 ADMIN_USERNAME，然后重新部署一次（环境变量靠部署生效）。\n" +
  (legacy ? "（注意：本次生成的是**旧格式**无盐哈希，仅在兼容老环境时使用。）" : "")
);
