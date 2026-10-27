/* 同日同线路「重传即替换」——自动取代（SUPERSEDED）
   ------------------------------------------------------------------
   背景：同一天同一线路重复上传（补拍、换截图、纠正）会新增运单，而当日汇总按
   所有可读运单累加（isReadable 只排除 SUPERSEDED），导致家数/重量重复统计；
   历史数据里已出现过同一天 3 张完全重复的运单（67 家 vs 实际 22 家）。

   取代规则（保守，避免误删真实数据）：
     同一线路 + 同一日期 + **同一车辆** + 门店集合高度重叠，命中任一即取代：
       ① 旧单门店集合是新单的**子集**（旧单只是同一份清单的不完整拍摄；
          覆盖「先传 5 家 → 再传全 22 家」）；
       ② 覆盖率 = |旧∩新| / |旧| ≥ 0.7（旧单绝大多数门店都出现在新单里，
          说明旧单是同一份清单的不完整/重复拍摄，应由新单取代）。
          覆盖「先传 15 家、再传全 22 家（各漏拍/重拍几张）」：13/15=0.87 → 取代。
     取舍方向性（故意不对称，分母是 |旧|）：
       - 旧 22 家、新 22 家（同样门店）            → 覆盖 1.00 → 取代
       - 旧 18 家（漏拍）、新 22 家（补全）        → 覆盖 1.00（子集）→ 取代
       - 旧 5 家（漏拍）、新 22 家（补全）         → 覆盖 1.00（子集）→ 取代
       - 旧 15 家、新 22 家（各漏拍/重拍几张）     → 覆盖 0.87 → 取代
       - 旧 22 家、新 5 家（只补拍了一小段）       → 覆盖 0.23 → **不取代**（防丢门店漏送）
       - 旧 10 家、新 10 家（同车第二趟不同门店）  → 覆盖 0.00 → **不取代**
     车辆任一方车牌不可信（缺失/被 OCR 污染）时，不据车牌排除，交由门店集合判定；
     双方都有可信且不同的车牌时，严格排除（同一天同线路多车分送不会被误合并）。

   取代动作（Lua 原子）：historyStatus=SUPERSEDED + supersededBy/At/Reason、
   移出历史索引（SREM）、清理指向该单的当日去重键，保证后续统计与去重不再命中它。
*/
import { command } from "../_redis.js";
import { normalizeForMatch } from "./_store-match-normalize.js";

/** 取代判定阈值：旧单门店被新单覆盖的比例 */
export const SUPERSEDE_COVERAGE = 0.7;
/** 兼容旧命名 */
export const SUPERSEDE_THRESHOLD = SUPERSEDE_COVERAGE;

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

/** 重叠度 = 交集 / 较大集合大小（0~1）。两个空集合视为 0。保留作参考指标。 */
export function storeOverlap(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / big.size;
}

/**
 * 旧单被新单覆盖的比例 = |旧∩新| / |旧|。
 * 这是取代判定的主指标：只要「旧单的门店基本都出现在新单里」，就说明旧单只是
 * 同一份清单的不完整拍摄（漏拍/断行/少传一张），应由新单取代。
 *
 * 为什么不用「交集/较大集合」：实测旧 15 家（含 2 条噪声/截断）、新 22 家，
 * 真正重合 13 家 → 交集/较大 = 0.591 差一点没过阈值，但按覆盖口径 13/15=0.867
 * 明确属于"旧单不完整"，应当取代。
 *
 * 方向性由分母是 |旧| 保证：新单只是旧单的一小部分时（如只补拍一段），
 * 覆盖率会很低，绝不会用残单覆盖完整旧单。
 */
export function storeCoverage(oldSet, newSet) {
  const O = oldSet instanceof Set ? oldSet : new Set(oldSet || []);
  const N = newSet instanceof Set ? newSet : new Set(newSet || []);
  if (!O.size) return 0;
  let inter = 0;
  for (const x of O) if (N.has(x)) inter++;
  return inter / O.size;
}

/** a 是否是 b 的子集（a 的每一家门店都出现在 b 里）。 */
export function isSubsetOf(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/* 中国车牌（省份简称 + 字母 + 5 位字母数字）。
   实测坑：单张截图的抬头被截断时，OCR 会把门店名里的片段当车牌
   （"北JM03022"），若直接按字符串比较车辆，会把同一张运单判成"不同车辆"，
   导致重复单永远不被取代。 */
const PLATE_RE = /[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][A-Z][A-Z0-9]{5}/;

/** 提取可信车牌；识别不出返回空串。 */
export function vehiclePlate(v) {
  const s = String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fa5]/g, "");
  const m = s.match(PLATE_RE);
  return m ? m[0] : "";
}

/**
 * 车辆一致性。
 * 双方都能识别出可信车牌 → 必须相同；
 * 任一方车牌不可信（缺失/被 OCR 污染）→ 不据车牌排除，交由门店集合判定。
 */
export function sameVehicle(a, b) {
  const pa = vehiclePlate(a && a.vehicle);
  const pb = vehiclePlate(b && b.vehicle);
  if (pa && pb) return pa === pb;
  return true;
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
    const oldSet = storeNameSet(o);
    if (!oldSet.size) continue;
    /* 两条判据（不对称，故意如此）：
       1) 旧单门店集合是新单的子集 → 旧单只是"同一份清单的不完整拍摄"，取代它。
          覆盖「先传 5 家（漏拍）→ 再传全 22 家」，否则残单会永远留在当日统计里。
       2) 覆盖率 ≥ 阈值（|旧∩新| / |旧|，分母用旧单）：旧单绝大多数门店都出现在
          新单里 → 旧单是同一份清单的不完整/重复拍摄，由新单取代。
          实测旧 15 家（含 2 条噪声/截断）、新 22 家、重合 13 家 → 13/15=0.87 明确取代。
       注意方向性：分母是 |旧|，所以"新单只是旧单的一小段"（先传全、后只传一小段）
       时覆盖率会很低，绝不取代，绝不能用残单覆盖完整的旧单（会丢门店 → 漏送）。 */
    const subset = isSubsetOf(oldSet, newSet);
    const cov = storeCoverage(oldSet, newSet);
    if (subset || cov >= threshold) {
      out.push({
        id: String(o.id),
        overlap: Number(cov.toFixed(3)),
        subset,
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
