/* 同日同线路「重复上传合并」——只有内容完全一致才取代（SUPERSEDED）
   ------------------------------------------------------------------
   背景：同一天同一线路重复上传（补拍、换截图、纠正）会新增运单，而当日汇总按
   所有可读运单累加（isReadable 只排除 SUPERSEDED），导致家数/重量重复统计；
   历史数据里已出现过同一天 3 张完全重复的运单（67 家 vs 实际 22 家）。

   **2026-11-06 规则收紧（业务定调）**：
     只要有一处不一致，就判定为**不同运单**，两单并存，绝不自动替换。

   取代条件（全部满足才取代，即「内容完全一致」）：
     · 同一线路 + 同一日期；
     · 车牌不冲突（双方都能识别出可信车牌时必须相同；任一方车牌缺失/被
       OCR 污染时不据车牌排除——粘贴文本录入本身就没有车牌字段）；
     · 门店集合完全相同（归一化后名称集合相等：数量相同且逐一包含）；
     · 总重量相同（按 kg 取整比较，只容忍 OCR 末位抖动，不容忍真实差异）。
   任一条不满足 → 不同运单，保留两单。

   为什么要这么严：2026-11-06 线上真实事故——同车同日两张单，第 1 张 22 家
   1.150887t / 123 件，第 2 张 21 家 1.070565t / 131 件；旧规则只看「门店覆盖率
   ≥70%」（21/22 = 95%）就判为重传，把第 1 张标成 SUPERSEDED 并移出索引，
   历史 / 首页 / 详情全部消失。门店高度重复 + 数量重量不同，在本业务里是
   「同车一天两批货」的常态，不是重传。

   取舍：残单（先传 5 家、再传全 22 家）不再自动清理，会保留成两张，由司机
   在运单详情里手动删除。宁可多一张可删的，也不能少一张找不回的。

   取代动作（Lua 原子）：historyStatus=SUPERSEDED + supersededBy/At/Reason、
   移出历史索引（SREM）、清理指向该单的当日去重键，保证后续统计与去重不再命中它。
   注：内容完全一致的上传在更早的「当日去重」环节就会合并（idempotent），
   走到本模块属于兜底（去重键缺失 / 历史旧单无 dedupeKey 等场景）。
*/
import { command } from "../_redis.js";
import { normalizeForMatch } from "./_store-match-normalize.js";

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

/** 两个门店集合是否完全相同（数量相同且逐一包含）。空集合不算相同。 */
export function sameStoreSet(a, b) {
  const A = a instanceof Set ? a : new Set(a || []);
  const B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/** 总重量（kg 整数）。缺失返回 null，便于把「一方缺失」判为不一致。 */
export function weightKg(order) {
  const n = Number(order && order.totalWeight);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

/* 中国车牌（省份简称 + 字母 + 5 位字母数字）。
   实测坑：单张截图的抬头被截断时，OCR 会把门店名里的片段当车牌
   （"北JM03022"），若直接按字符串比较车辆，会把同一张运单判成"不同车辆"。 */
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
 * 任一方车牌不可信（缺失/被 OCR 污染）→ 不据车牌排除，交由门店与重量判定。
 */
export function sameVehicle(a, b) {
  const pa = vehiclePlate(a && a.vehicle);
  const pb = vehiclePlate(b && b.vehicle);
  if (pa && pb) return pa === pb;
  return true;
}

/**
 * 两张单是否「内容完全一致」（可判为重复上传）。
 * 一处不同即返回 false —— 门店集合、总重量（按 kg）任一不同都不算重复。
 */
export function isIdenticalContent(a, b) {
  if (!a || !b) return false;
  if (!sameStoreSet(storeNameSet(a), storeNameSet(b))) return false;
  const wa = weightKg(a);
  const wb = weightKg(b);
  if (wa === null || wb === null) return wa === wb; // 双方都缺才算一致
  return wa === wb;
}

/**
 * 从候选旧运单里挑出应被新单取代的（内容完全一致的那些）。
 * @param {object} newOrder 新运单
 * @param {object[]} others 同线路同日的其它运单
 * @returns {{id:string, overlap:number, total:number, stage:string}[]}
 */
export function pickSupersededCandidates(newOrder, others) {
  if (!newOrder || !newOrder.id) return [];
  const out = [];
  for (const o of (others || [])) {
    if (!o || !o.id || o.id === newOrder.id) continue;
    if (String(o.routeId || "") !== String(newOrder.routeId || "")) continue;
    if (String(o.date || "") !== String(newOrder.date || "")) continue;
    if (String(o.historyStatus || "") === "SUPERSEDED") continue;
    if (!READABLE_STAGES.includes(String(o.stage || ""))) continue;
    if (!sameVehicle(newOrder, o)) continue;
    // 唯一内容判据：门店集合完全相同 + 总重量（kg）相同。少一家、多一家、
    // 换一家、重量差 1kg，一律视为不同运单，保留两单。
    if (!isIdenticalContent(newOrder, o)) continue;
    out.push({
      id: String(o.id),
      overlap: 1,
      total: Array.isArray(o.stores) ? o.stores.length : 0,
      stage: String(o.stage || ""),
    });
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
w.supersededReason = "REUPLOAD_IDENTICAL"
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
