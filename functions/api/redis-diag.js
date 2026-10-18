// Redis 链路自检（临时诊断用）：确认 Cloudflare Pages 当前到底连的是哪个库、
// Worker 落在哪个 PoP、Worker→Redis 单次往返多少毫秒。
//
// 为什么需要它：CF Pages 的环境变量改完必须重新部署才生效，光看控制台配置
// 无法确认线上跑的是旧库（GCP us-central1）还是新库（亚太）。而"读取中卡 10 秒"
// 的元凶就是 Worker→Redis 这一段，必须能量化才能证明迁移有效。
//
// 安全：不返回任何键名与键值，只返回聚合统计；无正确 k 参数直接 404 且不消耗 Redis。
import {json} from "./_json.js";
import {command} from "./_redis.js";

// 只是门槛，不是密钥：猜不到就当作接口不存在。不保护任何敏感数据（返回值本就只有统计）。
const DIAG_KEY = "zpdiag-8f3a2c";
const SCAN_CAP = 20000;   // 扫到这个数就停，避免大库把诊断变成慢请求

function endpointOf(env){
  try { return new URL(env.UPSTASH_REDIS_REST_URL).host; } catch { return null; }
}

export async function onRequestGet(context){
  const {request, env} = context;
  const url = new URL(request.url);
  if (url.searchParams.get("k") !== DIAG_KEY) {
    return json({success:false, error:"页面不存在"}, 404);
  }
  if (!env?.UPSTASH_REDIS_REST_URL || !env?.UPSTASH_REDIS_REST_TOKEN) {
    return json({success:false, error:"REDIS_NOT_CONFIGURED", configured:false}, 200);
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
