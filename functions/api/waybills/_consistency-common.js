/**
 * 智配One · 一致性自检 —— 共享 helper 层
 * ----------------------------------------------------------
 * 本文件由 _consistency.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 键结构契约（process.js / history.js / _waybill-events.js / _waybill-proc.js）：
 *   主记录   zp:waybill:<id>
 *   索引     zp:route:<routeId>:waybills:<date>  (SET，存 waybill id)
 *   日去重   zp:waybill:dedupe:<dailySig>         (string -> id)
 *   内容指纹 zp:waybill:fingerprint:<fp>           (string -> id)
 * Asia/Shanghai 日期口径：运单日期兜底与 createdAt 取日期均以此为准，避免时区错位。
 */

export const WB_PREFIX = "zp:waybill:";
export const INDEX_PREFIX = "zp:route:";
export const INDEX_SUFFIX = ":waybills:";
export const clean = v => String(v ?? "").trim();
export const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim());
// Asia/Shanghai 日期：运单日期兜底与 createdAt 取日期均以此为准，避免时区错位。
const cnDateParts = dateObj => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dateObj);
  const v = Object.fromEntries(p.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
export const todayCN = () => cnDateParts(new Date());
// 由 createdAt 推 YYYY-MM-DD；非法输入返回 null（上层再兜底到今天）
export const cnDateOf = iso => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? cnDateParts(new Date(t)) : null;
};

// ====== Cloudflare Workers 资源边界护栏（2026-10-07 生产事故修） ======
// Workers 免费版每请求子请求上限约 50。巡检走两条成本线：
//   ① SCAN 迭代：每次迭代 = 1 个子请求；键空间大 + MATCH 稀疏时迭代次数 ≈ 键空间/COUNT
//   ② 逐键读取：GET / SMEMBERS 每个键 = 1 个子请求
// 旧实现两条都是 O(N)：先是逐键 GET/SMEMBERS，再叠加无上限的稀疏 SCAN，
// 生产数据量下必然爆预算 → Worker 抛异常 → Cloudflare Error 1101。
// 因此这里同时收紧三者：COUNT 放大、MGET/pipeline 批量、**全局预算 + 相位数上限**。
// 预算逻辑已统一收口到 _redis-budget.js（Budget / scanKeysBudgeted / mgetBatchMap / smembersBatch），
// 此处只保留一致性扫描专属的迭代上限。预算耗尽时不等平台掐断，而是主动截断并在报告里标注
// degraded —— 宁可给出「可能不完整」的结论，也不能让一致性工具沉默地返回一个「什么问题都没有」的假绿灯。
export const SCAN_ITER_CAP_WAYBILL = 12;
export const SCAN_ITER_CAP_INDEX = 8;

export const parseWaybill = raw => {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
};

export const isReadable = w =>
  w && w.schemaVersion === "2" && typeof w.id === "string" &&
  typeof w.routeId === "string" && Array.isArray(w.stores) &&
  !!w.summary && w.historyStatus !== "SUPERSEDED" &&
  ["PLANNED", "CONFIRMED"].includes(w.stage);

// 判断 pointsTo 是否在作用域内：scopeRoute 为 null 即全部；若指向缺失主记录（悬空）恒报。
export function inScopeOfId(id, waybills, scopeRoute) {
  if (scopeRoute === null) return true;
  const w = waybills.get(id);
  if (!w) return true; // 悬空引用，无论作用域都报
  return clean(w.routeId) === scopeRoute;
}
