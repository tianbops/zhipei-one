// 生成环境变量管理员的密码哈希，格式与 functions/api/login.js 的 hash() 严格一致
// （SHA-256 明文密码 → 64 位小写 hex）。
//
// 用法（密码只在你自己机器上出现，别贴给别人）：
//   node tools/gen-admin-hash.mjs '你的管理员密码'
// 输出的那串 64 位 hex 填进 Cloudflare Pages 环境变量 ADMIN_PASSWORD_HASH，
// 账号名填 ADMIN_USERNAME。两个变量是一对，改哈希就等于改管理员密码。
const password = process.argv[2];
if (!password) {
  console.error("用法: node tools/gen-admin-hash.mjs <管理员密码>");
  process.exit(1);
}
if (password.length < 6) {
  console.error("密码至少 6 位（与注册接口的校验一致）");
  process.exit(1);
}
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
console.log(hex);
console.error(
  "\n把上面这串填到 Cloudflare Pages 环境变量 ADMIN_PASSWORD_HASH，\n" +
  "并把账号名填到 ADMIN_USERNAME，然后重新部署一次（环境变量靠部署生效）。"
);
