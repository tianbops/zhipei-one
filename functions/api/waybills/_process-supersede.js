/* 同日同线路「重传即替换」——自动取代（SUPERSEDED）
   ------------------------------------------------------------------
   背景：同一天同一线路重复上传（补拍、换截图、纠正）会新增运单，而当日汇总按
   所有可读运单累加（isReadable 只排除 SUPERSEDED），导致家数/重量重复统计；
   历史数据里已出现过同一天 3 张完全重复的运单（67 家 vs 实际 22 家）。

   取代规则（保守，避免误删真实数据）：
     同一线路 + 同一日期 + **同一车辆** + 门店集合高度重叠
     重叠度 = |交集| / |较大集合|      （用较大集合做分母）
       - 旧 22 家、新 22 家（同样的门店）        → 1.00 → 取代
       - 旧 18 家（漏拍）、新 22 家（补全）      → 0.82 → 取代
       - 旧 22 家、新 5 家（只补拍了一小段）     → 0.23 → **不取代**（不能拿残单覆盖全单）
       - 旧 10 家、新 10 家（同车第二趟不同门店）→ 0.00 → **不取代**
     车辆任一方缺失时一律不取代（信息不足，宁可留两张人工看）。

   取代动作（Lua 原子）：historyStatus=SUPERSEDED + supersededBy/At/Reason、
   移出历史索引（SREM）、清理指向该单的当日去重键，保证后续统计与去重不再命中它。
*/
import { command } from "../_redis.js";
import { normalizeForMatch } from "./_store-match-normalize.js";

/** 取代判定阈值：较大集合被覆盖的比例 */
export const SUPERSEDE_THRESHOLD = 0.6;

/** 运单的可读阶段（与 _waybill-meta.js 的 isReadable 保持一致） */
const READABLE_STAGES = ["PLANNED", "CONFIRMED"];

/** 门店名归一化集合（去空、去重） */
export function storeNameSet(order) {
  const set = new Set();
  for (const s of (order && Array.isArray(order.stores) ? order.stores : [])) {
    const n = normalizeForMatch(s && (s.name || s.rawName) ? (s.name || s.rawName) : "");
    if (n) set.add(n);
  }
  return set;
}

/** 重叠度 = 交集 / 较大集合大小（0~1）。两个空集合视为 0。 */
export function storeOverlap(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / big.size;
}

/** 车辆一致性。任一方缺失即视为不可判定（返回 false，保守不取代）。 */
export function sameVehicle(a, b) {
  const va = normalizeForMatch((a && a.vehicle) || "");
  const vb = normalizeForMatch((b && b.vehicle) || "");
  if (!va || !vb) return false;
  return va === vb;
}

/**
 * 从候选旧运单里挑出应被新单取代的。
 * @param {object} newOrder 新运单
 * @param {object[]} others 同线路同日的其它运单
 * @param {{threshold?:number}} opts
 * @returns {{id:string, overlap:number, total:number, stage:string}[]}
 */
export function pickSupersededCandidates(newOrder, others, { threshold = SUPERSEDE_THRESHOLD } = {}) {
  if (!newOrder || !newOrder.id) return [];
  const newSet = storeNameSet(newOrder);
  const out = [];
  for (const o of (others || [])) {
    if (!o || !o.id || o.id === newOrder.id) continue;
    if (String(o.routeId || "") !== String(newOrder.routeId || "")) continue;
    if (String(o.date || "") !== String(newOrder.date || "")) continue;
    if (String(o.historyStatus || "") === "SUPERSEDED") continue;
    if (!READABLE_STAGES.includes(String(o.stage || ""))) continue;
    if (!sameVehicle(newOrder, o)) continue;
    const ov = storeOverlap(newSet, storeNameSet(o));
    if (ov >= threshold) {
      out.push({
        id: String(o.id),
        overlap: Number(ov.toFixed(3)),
        total: Array.isArray(o.stores) ? o.stores.length : 0,
        stage: String(o.stage || ""),
      });
    }
  }
  return out;
}

/* 原子取代：校验仍是可读旧单 → 标记 SUPERSEDED → 移出索引 → 清理当日去重键。
   返回 1 表示已取代；0 表示未取代（记录不存在/已被取代/阶段不符）。 */
const SUPERSEDE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then redis.call("SREM", KEYS[2], ARGV[1]); return 0 end
local ok, w = pcall(cjson.decode, raw)
if not ok or type(w) ~= "table" then return 0 end
if w.historyStatus == "SUPERSEDED" then redis.call("SREM", KEYS[2], ARGV[1]); return 0 end
if w.stage ~= "PLANNED" and w.stage ~= "CONFIRMED" then return 0 end
w.historyStatus = "SUPERSEDED"
w.supersededBy = ARGV[2]
w.supersededAt = ARGV[3]
w.supersededReason = "REUPLOAD_SAME_DAY"
redis.call("SET", KEYS[1], cjson.encode(w))
redis.call("SREM", KEYS[2], ARGV[1])
if w.dailyDedupeKey and w.dailyDedupeKey ~= "" then
  local dk = "zp:waybill:dedupe:" .. w.dailyDedupeKey
  if redis.call("GET", dk) == ARGV[1] then redis.call("DEL", dk) end
end
if w.businessFingerprint and w.businessFingerprint ~= "" then
  local fk = "zp:waybill:fingerprint:" .. w.businessFingerprint
  if redis.call("GET", fk) == ARGV[1] then redis.call("DEL", fk) end
end
return 1
`;

/**
 * 把 candidates 逐条原子取代。
 * @returns {Promise<{id:string, overlap:number, total:number}[]>} 实际被取代的
 */
export async function applySupersede(env, newOrder, candidates, { nowISO } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return [];
  const indexKey = "zp:route:" + String(newOrder.routeId || "") + ":waybills:" + String(newOrder.date || "");
  const at = nowISO || new Date().toISOString();
  const done = [];
  for (const c of list) {
    try {
      const r = await command(env, [
        "EVAL", SUPERSEDE_SCRIPT, "2",
        "zp:waybill:" + c.id, indexKey,
        c.id, String(newOrder.id || ""), at,
      ]);
      if (Number(r) === 1) done.push({ id: c.id, overlap: c.overlap, total: c.total });
    } catch { /* 单条失败不影响主流程与其它条目 */ }
  }
  return done;
}
