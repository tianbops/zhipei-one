import { json } from "./_json.js";
import { currentUser } from "./_auth.js";
import { canUseRoute } from "./_permissions.js";
import { readDates, readDateWaybillsBatch, enrichFactory, historyRange, clean } from "./history.js";
import { Budget, SUBREQUEST_BUDGET_EXCEEDED } from "./_redis-budget.js";

// 自动回填（P1-2，历史资产复用）：输入手机号 / 姓名 / 地址 / 运单号，
// 在 24 个月窗口内查找「最近一条」匹配运单，返回该客户的收件信息与门店清单，
// 供上传 / 录入场景一键带回历史记忆。
// 复用 history.js 的只读投影与读取预算（Budget），不新建任何存储。
const todayCN = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const normalize = v => String(v ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
function matchNeedle(waybill, needle) {
  if (!waybill || typeof waybill !== "object") return false;
  const fields = [
    waybill.id, waybill.date, waybill.routeName, waybill.vehicle, waybill.vehicleNo,
    waybill.plateNumber, waybill.licensePlate, waybill.driverName, waybill.customerName,
    waybill.contactName, waybill.phone, waybill.mobile, waybill.address, waybill.rawText, waybill.ocrText,
  ];
  for (const s of (Array.isArray(waybill.stores) ? waybill.stores : [])) {
    if (!s || typeof s !== "object") continue;
    fields.push(s.name, s.rawName, s.originalName, s.storeName, s.storeId, s.phone, s.mobile, s.contact, s.contactName, s.address, s.navigation, s.note, s.remark);
  }
  return fields.some(v => normalize(v).includes(needle));
}
function pickStores(waybill, limit = 8) {
  return (Array.isArray(waybill.stores) ? waybill.stores : []).slice(0, limit).map(s => ({
    name: clean(s?.name || s?.rawName),
    phone: clean(s?.phone || s?.mobile || s?.contact || s?.contactName),
    address: clean(s?.address),
    navigation: clean(s?.navigation),
    note: clean(s?.note || s?.remark),
  })).filter(s => s.name || s.phone || s.address || s.navigation || s.note);
}

export async function onRequestGet({ request, env }) {
  try {
    const user = await currentUser(request, env);
    if (!user) return json({ success: false, error: "未登录" }, 401);
    if (user.role === "admin" || !canUseRoute(user)) return json({ success: false, error: "无权查询配送业务" }, 403);
    const url = new URL(request.url);
    const routeId = clean(url.searchParams.get("routeId") || user.dispatchRouteId || user.boundRouteId);
    if (!routeId) return json({ success: true, routeId: null, found: false });
    const currentRoute = clean(user.dispatchRouteId) || clean(user.boundRouteId);
    if (routeId !== currentRoute) return json({ success: false, error: "无权查询该线路" }, 403);

    const query = clean(url.searchParams.get("q")).normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (query.length > 80) return json({ success: false, code: "LOOKUP_QUERY_TOO_LONG", error: "查询内容最多 80 个字符" }, 400);
    const needle = normalize(query);
    if (!needle) return json({ success: false, code: "LOOKUP_QUERY_INVALID", error: "请输入有效的查询内容" }, 400);

    const range = historyRange(todayCN(), 24); // 回填放宽到 24 个月，找回更久的客户记忆
    const budget = new Budget();
    let entries, batch;
    try {
      entries = await readDates(env, routeId, range, budget);
      batch = await readDateWaybillsBatch(env, user, entries, budget);
    } catch (e) {
      if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "历史范围较大，请缩短关键词或稍后重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
      throw e;
    }

    // 收集命中运单，取「最近一条」（date desc → createdAt desc → id desc）
    const hits = [];
    for (const entry of entries) {
      for (const w of (batch.get(entry.date) || [])) {
        if (matchNeedle(w, needle)) hits.push(w);
      }
    }
    if (!hits.length) return json({ success: true, routeId, query, found: false });
    hits.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(b.id).localeCompare(String(a.id)));
    const best = hits[0];
    const enrich = await enrichFactory(env, routeId);
    const enriched = await enrich(best);

    return json({
      success: true, routeId, query, found: true,
      match: {
        date: enriched.date,
        routeName: enriched.routeName || "",
        vehicle: clean(enriched.vehicle || enriched.vehicleNo || enriched.licensePlate || ""),
        customerName: clean(enriched.customerName || enriched.contactName),
        phone: clean(enriched.phone || enriched.mobile),
        address: clean(enriched.address),
        storeCount: Number(enriched.summary?.finalCount || enriched.summary?.total || (enriched.stores?.length) || 0),
        totalWeight: Number(enriched.totalWeight) || 0,
        stores: pickStores(enriched),
      },
      hitCount: hits.length,
    });
  } catch (e) {
    return json({ success: false, code: "HISTORY_LOOKUP_FAILED", error: "客户查档失败", detail: String(e?.message || e || "UNKNOWN_ERROR").slice(0, 180) }, 500);
  }
}
