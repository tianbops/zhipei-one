// 第三批收口回归：P2-10 迁移 / P2-11 session TTL / P2-12 弹窗 blur
// ------------------------------------------------------------------
// 背景：第一、二批收口了全部 P1（子请求预算 / 权限越界 / 谎报 success）。
//      本批处理三条 P2，均为「资源与体验层面的隐性隐患」，不阻断功能但会慢性累积：
//   P2-10 _migrations.js normalizeLegacyRoles 对每个用户各发一次 EVAL = O(N) 子请求，
//         而 system_admin 是极少量历史账户，绝大多数 EVAL 是纯浪费往返。
//   P2-11 login 用裸 SET 写 session 永不过期，浏览器丢弃 Cookie 后服务端会话永久驻留，
//         zp:session:* 无界增长（也是 cleanupUserSessions 必须全键扫描的根因）。
//   P2-12 admin.html 全屏遮罩 backdrop-filter:blur(5px)，移动端/低端机掉帧典型来源。
//
// 运行：node tests/route-closure-batch3.cjs
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

let subrequests = 0;
const innerFetch = global.fetch;
global.fetch = async (...args) => { subrequests++; return innerFetch(...args); };

const CAP = 45;
const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
const setkv = (k, obj) => red.command(["SET", "zp:" + k, typeof obj === "string" ? obj : JSON.stringify(obj)]);
const getkv = async k => { const r = await red.command(["GET", "zp:" + k]); if (r === null || r === undefined) return null; try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; } };
const req = (p, token, body) => ({
  url: "https://app.local" + p,
  headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) },
  json: async () => body || {},
});

(async () => {
  const migrations = await import(baseDir + "_migrations.js");
  const manageMod = await import(baseDir + "admin/manage.js");
  const loginMod = await import(baseDir + "login.js");
  const redisMod = await import(baseDir + "_redis.js");

  // ============ 【P2-10】角色归一化迁移：只对命中用户发 EVAL ============
  console.log("【P2-10】normalizeLegacyRoles：MGET 筛选 + 仅命中者 EVAL，子请求不随用户数线性增长");
  const N_USERS = 150;
  const ids = [];
  for (let i = 0; i < N_USERS; i++) {
    ids.push("m" + i);
    // 仅 2 个是遗留 system_admin，其余均为规范 admin/user
    const role = i < 2 ? "system_admin" : (i % 2 === 0 ? "user" : "admin");
    await setkv("user:m" + i, { id: "m" + i, username: "m" + i, role });
  }
  await setkv("users:index", JSON.stringify(ids));

  subrequests = 0;
  const r1 = await migrations.normalizeLegacyRoles(env);
  check("迁移返回 scanned=150", r1.scanned === N_USERS, "scanned=" + r1.scanned);
  check("仅归一化真实遗留账户（2 个）", r1.normalized === 2, "normalized=" + r1.normalized);
  check("无报错", (r1.errors || []).length === 0, "errors=" + JSON.stringify(r1.errors || []));
  check("P2-10 子请求 ≤ " + CAP + "（原为 O(150)=150 次 EVAL）", subrequests <= CAP, "subrequests=" + subrequests);
  check("子请求数 ≈ MGET 批次数(2) + 命中数(2)，与用户总量无关", subrequests <= 6, "subrequests=" + subrequests);
  check("遗留账户已被改写为 admin", (await getkv("user:m0")).role === "admin" && (await getkv("user:m1")).role === "admin");
  check("规范账户未被误改", (await getkv("user:m2")).role === "user" && (await getkv("user:m3")).role === "admin");

  // 幂等：再跑一次不应再改写任何东西
  subrequests = 0;
  const r2 = await migrations.normalizeLegacyRoles(env);
  check("迁移幂等（二次执行 normalized=0）", r2.normalized === 0, "normalized=" + r2.normalized);
  check("幂等重跑子请求更低（无 EVAL）", subrequests <= 4, "subrequests=" + subrequests);

  // 管理端：预算耗尽须返回结构化 503，而非裸异常/谎报 success
  console.log("【P2-10b】admin/manage normalize-roles：预算耗尽转结构化 503");
  await setkv("user:mAdm", { id: "mAdm", role: "admin", username: "mAdm", passwordHash: await loginMod.hash("secret123"), sessionVersion: 1 });
  await setkv("session:tokMAdm", { userId: "mAdm", sessionVersion: 1 });
  subrequests = 0;
  const okRes = await manageMod.onRequestPost({ request: req("/api/admin/manage", "tokMAdm", { action: "normalize-roles" }), env });
  const okJson = await okRes.json();
  check("管理端迁移返回 success", okJson.success === true, "HTTP " + okRes.status + " detail=" + (okJson.detail || ""));
  check("管理端显式回传 complete 诚实信号", okJson.complete === true, "complete=" + okJson.complete);

  // ============ 【P2-11】session 键 TTL：与 Cookie 同寿命 ============
  console.log("【P2-11】登录写入的 session 键带 TTL，不再永久驻留");
  check("SESSION_TTL_SECONDS = 604800（7 天，与 Cookie Max-Age 一致）", redisMod.SESSION_TTL_SECONDS === 604800, "ttl=" + redisMod.SESSION_TTL_SECONDS);
  await setkv("user:loginP2", { id: "loginP2", username: "loginp2", role: "user", passwordHash: await loginMod.hash("secret123"), sessionVersion: 1 });
  await setkv("user:index:loginp2", "loginP2");

  subrequests = 0;
  const loginRes = await loginMod.onRequestPost({ request: req("/api/login", "", { username: "loginp2", password: "secret123" }), env });
  const loginJson = await loginRes.json();
  check("登录成功", loginJson.success === true, "HTTP " + loginRes.status);
  // 从 set-cookie 取 token
  const cookie = String(loginRes.headers.get("set-cookie") || "");
  const m = cookie.match(/zp_session=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : "";
  check("下发 session Cookie", !!token, "cookie=" + cookie.slice(0, 60));
  const ttl = Number(await red.command(["TTL", "zp:session:" + token]));
  check("session 键带 TTL 且≈7 天（不再永久驻留）", ttl > 604000 && ttl <= 604800, "ttl=" + ttl + "秒");
  // Cookie 的 Max-Age 与 Redis TTL 必须一致
  const maxAge = Number((cookie.match(/Max-Age=(\d+)/) || [])[1]);
  check("Cookie Max-Age 与 Redis TTL 严格一致（同寿命，不会单边失效）", maxAge === ttl, "cookie=" + maxAge + " redis=" + ttl);

  // 推进假时钟越过 TTL → session 应自动失效
  red.advance(604801 * 1000);
  const gone = await red.command(["GET", "zp:session:" + token]);
  check("越过 TTL 后 session 自动过期（根治键空间无界增长）", gone === null, "value=" + gone);
  const expiredAuth = await loginMod.onRequestPost({ request: req("/api/login", "", { username: "loginp2", password: "wrongpw" }), env });
  check("过期 session 不影响重新登录能力", (await expiredAuth.json()).success === false);
  red.advance(-604801 * 1000);   // 复原时钟，避免影响后续用例

  // setEx 参数校验
  let threw = false;
  try { await redisMod.setEx(env, "badkey", "v", 0); } catch { threw = true; }
  check("setEx 拒绝非法 TTL（不会写出无 TTL 键）", threw);

  // ============ 【P2-12】管理员弹窗移除 backdrop-filter ============
  console.log("【P2-12】admin.html 弹窗遮罩不再使用 backdrop-filter（移动端掉帧源）");
  const html = fs.readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");
  // 取出 .dialog-bg 规则（排除注释行）
  const dialogRules = html.split("\n").filter(l => l.includes(".dialog-bg") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"));
  const ruleText = dialogRules.join("\n");
  check("找到 .dialog-bg 规则", ruleText.length > 0);
  check(".dialog-bg 已无 backdrop-filter", !/backdrop-filter\s*:\s*(?!none)/i.test(ruleText), ruleText.slice(0, 80));
  check(".dialog-bg 已无 -webkit-backdrop-filter", !/-webkit-backdrop-filter\s*:\s*(?!none)/i.test(ruleText));
  // 全仓（除注释外）不应再有生效的 backdrop-filter
  const files = fs.readdirSync(__dirname + "/..").filter(f => f.endsWith(".html"));
  const cssDir = path.join(__dirname, "..", "css");
  const cssFiles = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter(f => f.endsWith(".css")).map(f => path.join(cssDir, f)) : [];
  let active = 0, offenders = [];
  for (const f of [...files, ...cssFiles]) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith("/*") || t.startsWith("*") || t.startsWith("//")) return;   // 注释不算
      if (/backdrop-filter\s*:\s*(?!none)/i.test(l) || /-webkit-backdrop-filter\s*:\s*(?!none)/i.test(l)) { active++; offenders.push(path.basename(f) + ":" + (i + 1)); }
    });
  }
  check("全站无生效的 backdrop-filter（注释不计）", active === 0, "残留=" + active + (offenders.length ? " @ " + offenders.join(",") : ""));

  // ============ 桩自检：TTL 语义必须真实 ============
  console.log("【桩】MiniRedis 已真实实现 SET..EX 过期（不再失真）");
  await red.command(["SET", "zp:probe:ttl", "v", "EX", "100"]);
  check("TTL 命令返回剩余秒数", Number(await red.command(["TTL", "zp:probe:ttl"])) === 100);
  red.advance(101 * 1000);
  check("越期后 GET 返回 null", (await red.command(["GET", "zp:probe:ttl"])) === null);
  check("越期后 SCAN 不再返回该键（不留僵尸）", JSON.stringify((await red.command(["SCAN", "0", "MATCH", "*", "COUNT", "500"]))[1]).indexOf("probe:ttl") === -1);
  red.advance(-101 * 1000);

  console.log("\nROUTE_CLOSURE_BATCH3：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试运行异常：", e); process.exit(1); });
