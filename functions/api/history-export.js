import { json } from "./_json.js";
import { currentUser } from "./_auth.js";
import { canUseRoute } from "./_permissions.js";
import { readDates, readDateWaybillsBatch, enrichFactory, historyRange, clean } from "./history.js";
import { Budget, SUBREQUEST_BUDGET_EXCEEDED } from "./_redis-budget.js";

// 历史导出（P2-2，资产复用）：GET ?format=csv|json&month=<YYYY-MM>|date=<YYYY-MM-DD>&months=<1-24>
// 复用只读投影与读取预算，按范围序列化运单，以附件形式下载。不新建存储。
const todayCN = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const csvEscape = v => { const s = String(v ?? ""); return `"${s.replace(/"/g, '""')}"`; };
const csvLine = arr => arr.map(csvEscape).join(",");

export async function onRequestGet({ request, env }) {
  try {
    const user = await currentUser(request, env);
    if (!user) return json({ success: false, error: "未登录" }, 401);
    if (user.role === "admin" || !canUseRoute(user)) return json({ success: false, error: "无权导出配送数据" }, 403);
    const url = new URL(request.url);
    const routeId = clean(url.searchParams.get("routeId") || user.dispatchRouteId || user.boundRouteId);
    if (!routeId) return json({ success: false, error: "未绑定线路" }, 400);
    const currentRoute = clean(user.dispatchRouteId) || clean(user.boundRouteId);
    if (routeId !== currentRoute) return json({ success: false, error: "无权导出该线路" }, 403);

    const format = clean(url.searchParams.get("format")).toLowerCase();
    if (format !== "csv" && format !== "json") return json({ success: false, code: "EXPORT_FORMAT_INVALID", error: "format 仅支持 csv 或 json" }, 400);

    const month = clean(url.searchParams.get("month"));
    const date = clean(url.searchParams.get("date"));
    if (month && !/^\d{4}-\d{2}$/.test(month)) return json({ success: false, code: "MONTH_INVALID", error: "月份格式应为 YYYY-MM" }, 400);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ success: false, code: "DATE_INVALID", error: "日期格式应为 YYYY-MM-DD" }, 400);

    const monthsN = (() => {
      const m = Number(url.searchParams.get("months"));
      if (Number.isFinite(m) && m >= 1) return Math.min(24, Math.floor(m));
      return env?.WAYBILL_HISTORY_MONTHS || 13;
    })();
    const range = historyRange(todayCN(), monthsN);
    if ((month && (month < range.start.slice(0, 7) || month > range.end.slice(0, 7))) ||
        (date && (date < range.start || date > range.end))) {
      return json({ success: false, code: "RANGE_OUT_OF_BOUNDS", error: "导出范围超出历史查询窗口" }, 400);
    }

    const budget = new Budget();
    let entries, batch;
    try {
      entries = await readDates(env, routeId, range, budget);
      batch = await readDateWaybillsBatch(env, user, entries, budget);
    } catch (e) {
      if (e?.code === SUBREQUEST_BUDGET_EXCEEDED) return json({ success: false, code: "PARTIAL_FAILURE", error: "导出范围过大，请缩小月份范围后重试", budgetUsed: budget.used, budgetMax: budget.max }, 503);
      throw e;
    }

    // 按范围过滤并收集运单（date desc）
    const list = [];
    for (const entry of entries) {
      if (month && !entry.date.startsWith(month)) continue;
      if (date && entry.date !== date) continue;
      for (const w of (batch.get(entry.date) || [])) list.push(w);
    }
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    const enrich = await enrichFactory(env, routeId);
    const enriched = [];
    for (const w of list) enriched.push(await enrich(w));

    const scope = date ? date : (month ? month : "all");
    const fname = `history-${routeId}-${scope}.${format}`;

    if (format === "json") {
      const body = JSON.stringify({ routeId, scope, range, count: enriched.length, waybills: enriched }, null, 0);
      return new Response(body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fname}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // CSV：运单级一行 + 门店清单列
    const header = ["日期", "线路", "车牌", "司机", "客户", "电话", "门店数", "总重量(t)", "门店清单"];
    const rows = [csvLine(header)];
    for (const w of enriched) {
      const stores = Array.isArray(w.stores) ? w.stores : [];
      const storeNames = stores.map(s => clean(s?.name || s?.rawName)).filter(Boolean).join("、");
      rows.push(csvLine([
        w.date || "",
        w.routeName || "",
        clean(w.vehicle || w.vehicleNo || w.licensePlate || ""),
        clean(w.driverName || ""),
        clean(w.customerName || w.contactName || ""),
        clean(w.phone || w.mobile || ""),
        Number(w.summary?.finalCount || w.summary?.total || stores.length) || 0,
        (Math.round((Number(w.totalWeight) || 0) * 1000) / 1000).toFixed(3),
        storeNames,
      ]));
    }
    const body = "\uFEFF" + rows.join("\r\n");
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fname}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return json({ success: false, code: "HISTORY_EXPORT_FAILED", error: "历史导出失败", detail: String(e?.message || e || "UNKNOWN_ERROR").slice(0, 180) }, 500);
  }
}
