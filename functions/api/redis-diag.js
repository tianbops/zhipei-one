// Redis 链路自检（临时诊断用）：确认 Cloudflare Pages 当前到底连的是哪个库、
// Worker 落在哪个 PoP、Worker→Redis 单次往返多少毫秒。
//
// 为什么需要它：CF Pages 的环境变量改完必须重新部署才生效，光看控制台配置
// 无法确认线上跑的是旧库（GCP us-central1）还是新库（亚太）。而"读取中卡 10 秒"
// 的元凶就是 Worker→Redis 这一段，必须能量化才能证明迁移有效。
//
// 安全：不返回任何键名与键值，只返回聚合统计；无正确 k 参数直接 404 且不消耗 Redis。
import {json} from "./_json.js";
import {command, get} from "./_redis.js";
import {envAdminCredentials, envAdminId} from "./_env-admin.js";

// 只是门槛，不是密钥：猜不到就当作接口不存在。不保护任何敏感数据（返回值本就只有统计）。
const DIAG_KEY = "zpdiag-8f3a2c";
const SCAN_CAP = 20000;   // 扫到这个数就停，避免大库把诊断变成慢请求

function endpointOf(env){
  try { return new URL(env.UPSTASH_REDIS_REST_URL).host; } catch { return null; }
}

// 环境变量自检表：这次事故的教训是"控制台配了什么"和"代码实际读什么"根本不是一回事
// （ADMIN_BOOTSTRAP_KEY 配了但代码从不读；ADMIN_SETUP_KEY 缺失导致空库死锁）。
// 与其每次 grep 代码对表，不如让线上自己报：必填项缺哪个、哪些是配了也没用的僵尸变量。
// 只回传"配没配"与"是否合法"，绝不回传任何值。
const ENV_SPEC = [
  {name:"UPSTASH_REDIS_REST_URL",      required:true,  note:"Redis REST 地址（现为亚太新库）"},
  {name:"UPSTASH_REDIS_REST_TOKEN",    required:true,  note:"Redis REST 令牌"},
  {name:"PADDLEOCR_ACCESS_TOKEN",      required:true,  note:"运单 OCR 识别"},
  {name:"ADMIN_USERNAME",              required:true,  note:"环境变量管理员账号（清库后可重建管理员）"},
  {name:"ADMIN_PASSWORD_HASH",         required:true,  note:"SHA-256(密码) 64 位 hex"},
  {name:"ADMIN_SETUP_KEY",             required:false, note:"备选：/api/admin/bootstrap 一次性初始化"},
  {name:"PADDLEOCR_BASE_URL",          required:false, note:"可选，不配则用官方默认地址"},
  {name:"WAYBILL_STRICT_OWNER",        required:false, note:'可选，"1" 时运单回退为仅本人可见（止血开关）'},
  {name:"WAYBILL_HISTORY_MONTHS",      required:false, note:"可选，默认 13 个月查询窗口"},
  {name:"ADMIN_BOOTSTRAP_KEY",         deprecated:true, note:"代码从不读取，可删"},
  {name:"DATA_RESET_KEY",              deprecated:true, note:"admin/reset.js 已硬编码 410，可删"},
];

function envCheck(env){
  const cred = envAdminCredentials(env);
  const set = (n) => {
    const v = env?.[n];
    return v !== undefined && v !== null && String(v).trim() !== "";
  };
  const items = ENV_SPEC.map((s) => {
    const present = set(s.name);
    let status;
    if (s.deprecated) status = present ? "DEPRECATED" : "ABSENT";
    else if (!present) status = s.required ? "MISSING_REQUIRED" : "OPTIONAL_UNSET";
    else status = "OK";
    return {name:s.name, required:!!s.required && !s.deprecated, deprecated:!!s.deprecated,
            set:present, status, note:s.note};
  });
  // 两个管理员变量必须"成对且合法"才算可用：账号格式对 + 哈希是 64 位 hex，
  // 只配一个等于没配（envAdminCredentials 会返回 null）。
  const missing = items.filter((x) => x.status === "MISSING_REQUIRED").map((x) => x.name);
  const deprecatedSet = items.filter((x) => x.status === "DEPRECATED").map((x) => x.name);
  return {
    ok: missing.length === 0 && !!cred,
    missing_required: missing,
    // 管理员能不能在空库上自助重建，是这套配置里唯一"缺了就进不去系统"的项
    env_admin_usable: !!cred,
    deprecated_but_set: deprecatedSet,
    items,
  };
}

// 登录探针（?u=<登录时输入的用户名>）：不回传任何密码/哈希/用户名原文，只回传布尔与长度，
// 用来区分"账号或密码错误"到底是哪一类：
//   - env_admin_usable=false  → 线上 ADMIN_USERNAME/哈希非法（多半是新用户名含非法字符或没部署）
//   - typed_matches_env_admin=false → 你输的用户名和线上环境变量管理员对不上（没部署/打错）
//   - admin_seeded_in_db=false 且 env_admin_usable=true → 播种逻辑没生效（真 bug）
//   - seeded_hash_matches_env=false → 库里哈希和 env 哈希不一致（清库后第一次登录才会发生，正常会重写）
async function loginProbe(env, uParam){
  const cred = envAdminCredentials(env);
  const typed = String(uParam ?? "");
  const typedTrim = typed.trim();
  const redisReady = !!(env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN);
  const probe = {
    env_admin_usable: !!cred,
    env_username_valid: !!cred,
    typed_len: typed.length,
    typed_has_surrounding_ws: typed !== typedTrim,
    typed_matches_env_admin: cred ? (typedTrim.toLowerCase() === cred.username.toLowerCase()) : false,
    admin_seeded_in_db: null,
    seeded_hash_matches_env: null,
  };
  if (redisReady && cred){
    try {
      const raw = await get(env, "user:" + envAdminId());
      if (raw){
        let cur = null; try { cur = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
        if (cur && cur.role === "admin"){
          probe.admin_seeded_in_db = true;
          probe.seeded_hash_matches_env = String(cur.passwordHash ?? "") === cred.passwordHash;
        } else {
          probe.admin_seeded_in_db = false;
        }
      } else {
        probe.admin_seeded_in_db = false;
      }
    } catch {
      probe.admin_seeded_in_db = null;
    }
  }
  return probe;
}

export async function onRequestGet(context){
  const {request, env} = context;
  const url = new URL(request.url);
  const uParam = url.searchParams.get("u");
  const loginProbeResult = (uParam !== null) ? await loginProbe(env, uParam) : undefined;
  if (url.searchParams.get("k") !== DIAG_KEY) {
    return json({success:false, error:"页面不存在"}, 404);
  }
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) {
    // 这个分支也要报：空库死锁的判定（管理员能否初始化）不依赖 Redis 是否配好
    return json({success:false, error:"REDIS_NOT_CONFIGURED", configured:false,
                 env_check: envCheck(env),
                 adminSetupKeyConfigured: !!env.ADMIN_SETUP_KEY,
                 adminEnvConfigured: !!envAdminCredentials(env),
                 login_probe: loginProbeResult}, 200);
  }

  const out = {
    success: true,
    configured: true,
    endpoint: endpointOf(env),
    // 环境变量改完必须重新部署才生效，所以要把线上实际跑的构建也报出来，
    // 否则无法区分"配置没改"和"改了但没部署"。
    deploy: {
      branch: env.CF_PAGES_BRANCH ?? null,
      commit: (env.CF_PAGES_COMMIT_SHA ?? "").slice(0, 10) || null,
    },
    // 空库时系统能否自助启动，全看这个开关：没它 /api/admin/bootstrap 直接 503，
    // 于是"没有管理员 → 不能建邀请码 → 不能注册"死锁，数据清空后系统永远进不去。
    // 只回传"配没配"，绝不回传值。
    adminSetupKeyConfigured: !!env.ADMIN_SETUP_KEY,
    // 环境变量管理员是否可用（账号名 + 合法 sha256 hex 哈希都在才算）。
    // 它决定了"数据库被清空后系统还能不能进得去"。
    adminEnvConfigured: !!envAdminCredentials(env),
    env_check: envCheck(env),
    login_probe: loginProbeResult,
    cf: {
      colo: request.cf?.colo ?? null,
      country: request.cf?.country ?? null,
      city: request.cf?.city ?? null,
    },
  };

  // 1) Worker→Redis 单次往返（PING 采样）
  const samples = [];
  try {
    for (let i = 0; i < 6; i++) {
      const t = Date.now();
      await command(env, ["PING"]);
      samples.push(Date.now() - t);
    }
    samples.sort((a, b) => a - b);
    out.rtt_ms = {
      samples,
      min: samples[0],
      max: samples[samples.length - 1],
      median: samples[Math.floor(samples.length / 2)],
    };
  } catch (e) {
    out.rtt_ms = {error: String(e && e.message || e).slice(0, 200)};
  }

  // 2) 键空间概览（只统计，不返回任何键名/键值）
  const types = Object.create(null);
  try {
    let cursor = "0";
    let total = 0;
    const prefixes = Object.create(null);
    do {
      const res = await command(env, ["SCAN", cursor, "COUNT", "500"]);
      const next = Array.isArray(res) ? String(res[0]) : "0";
      const keys = Array.isArray(res) && Array.isArray(res[1]) ? res[1] : [];
      for (const k of keys) {
        total++;
        const seg = String(k).split(":");
        prefixes[seg.slice(0, 2).join(":")] = (prefixes[seg.slice(0, 2).join(":")] || 0) + 1;
      }
      cursor = next;
      if (total >= SCAN_CAP) break;
    } while (cursor !== "0");
    out.keys = {total, capped: total >= SCAN_CAP, by_prefix: prefixes};
  } catch (e) {
    out.keys = {error: String(e && e.message || e).slice(0, 200)};
  }

  // 2.5) 写探针（?w=1）：证明"keys.total=0"是真的空库，而不是 SCAN 在这库上不工作。
  // 写一个 60 秒 TTL 的临时键 → 读回 → 用 SCAN 找它 → 删除。
  // 若 wrote=true 而 seen_by_scan=false，说明 SCAN 有问题，上面的键数统计不可信。
  if (url.searchParams.get("w") === "1") {
    const probe = "zp:__diag__" + Date.now();
    try {
      await command(env, ["SET", probe, "1", "EX", "60"]);
      const got = await command(env, ["GET", probe]);
      const scan = await command(env, ["SCAN", "0", "MATCH", "zp:__diag__*", "COUNT", "100"]);
      const list = Array.isArray(scan) && Array.isArray(scan[1]) ? scan[1] : [];
      out.writeprobe = {
        wrote: String(got) === "1",
        seen_by_scan: list.indexOf(probe) >= 0,
        scan_hits: list.length,
      };
      await command(env, ["DEL", probe]);
    } catch (e) {
      out.writeprobe = {error: String(e && e.message || e).slice(0, 200)};
    }
  }

  // 3) 类型抽样：只对前若干个键做 TYPE，够判断数据结构是否完整
  try {
    const res = await command(env, ["SCAN", "0", "COUNT", "50"]);
    const keys = Array.isArray(res) && Array.isArray(res[1]) ? res[1].slice(0, 20) : [];
    for (const k of keys) {
      try {
        const t = await command(env, ["TYPE", k]);
        types[String(t)] = (types[String(t)] || 0) + 1;
      } catch {}
    }
    out.types_sample = types;
  } catch {
    out.types_sample = null;
  }

  return json(out, 200);
}
