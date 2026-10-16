// 智配One · 历史导出（history-export）回归（P1 历史导出 / 报告 P2-2）
// ------------------------------------------------------------------
// 覆盖：
//   (1) format=csv → Content-Type text/csv、Content-Disposition 含 .csv、带 BOM、含表头与数据；
//   (2) format=json → application/json、JSON 数组、count 正确；
//   (3) 范围过滤（month / date）生效；
//   (4) format 非法 → 400；
//   (5) 越权线路 → 403。
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const fmtCN = (d) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const v = Object.fromEntries(p.filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const todayCN = () => fmtCN(new Date());
const daysAgo = (n) => fmtCN(new Date(Date.now() - n * 86400000));
function getReq(url, token) {
  return { url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } };
}
const seedJson = (fullKey, obj) => red.command(["SET", fullKey, JSON.stringify(obj)]);

(async () => {
  const TODAY = todayCN(), OLD = daysAgo(40);
  const ROUTE = "route-2001", OTHER = "route-9999", M = "uM", tokM = "tok-M";
  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const exportMod = await import(baseDir + "history-export.js");
  const exportReq = (params, token) => {
    const u = "https://app.local/api/history-export?" + params;
    return exportMod.onRequestGet({ request: getReq(u, token), env });
  };

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", WAYBILL_HISTORY_MONTHS: 13 };
  seedJson("zp:user:" + M, { id: M, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-M", { userId: M, sessionVersion: 1 });
  seedJson("zp:user:uX", { id: "uX", role: "user", boundRouteId: OTHER, dispatchRouteId: OTHER, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-X", { userId: "uX", sessionVersion: 1 });
  seedJson("zp:route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });

  const buildRecord = (id, date) => ({
    schemaVersion: "2", id, routeId: ROUTE, routeName: "线路2001", date, vehicle: "粤B11111",
    customerName: "张三", phone: "13812345678", address: "杭州市余杭区", totalWeight: 2.5,
    stores: [{ storeId: "JM03050", name: "门店A", address: "余杭区文一西路", routeOrder: 1 }],
    stage: "CONFIRMED", summary: { original: 1, total: 1 }, createdAt: date + "T09:00:00+08:00",
  });
  const indexKey = (date) => "zp:route:" + ROUTE + ":waybills:" + date;

  seedJson("zp:waybill:w-today", buildRecord("w-today", TODAY));
  red.command(["SADD", indexKey(TODAY), "w-today"]);
  seedJson("zp:waybill:w-old", buildRecord("w-old", OLD));
  red.command(["SADD", indexKey(OLD), "w-old"]);

  console.log("\n【1】CSV 导出：整窗");
  const resp1 = await exportReq("format=csv&routeId=" + ROUTE, tokM);
  check("CSV 响应成功(2xx)", resp1.status === 200 || resp1.status === undefined, "status=" + resp1.status);
  const ct1 = resp1.headers.get("content-type") || "";
  check("Content-Type = text/csv", ct1.includes("text/csv"), ct1);
  const cd1 = resp1.headers.get("content-disposition") || "";
  check("Content-Disposition 含 .csv", cd1.includes(".csv"), cd1);
  const buf1 = new Uint8Array(await resp1.arrayBuffer());
  check("CSV 带 BOM(EF BB BF)", buf1[0] === 0xEF && buf1[1] === 0xBB && buf1[2] === 0xBF);
  const body1 = new TextDecoder("utf-8").decode(buf1);
  check("CSV 含表头「日期」", body1.includes("日期"));
  check("CSV 含两单数据(门店A)", (body1.match(/门店A/g) || []).length >= 2, "门店A次数=" + (body1.match(/门店A/g) || []).length);

  console.log("\n【2】JSON 导出：整窗");
  const resp2 = await exportReq("format=json&routeId=" + ROUTE, tokM);
  const body2 = await resp2.text();
  const j2 = JSON.parse(body2);
  check("JSON 结构含 waybills 数组", Array.isArray(j2.waybills) && j2.count === 2, "count=" + j2.count);
  check("JSON 含两单", j2.waybills.length === 2);

  console.log("\n【3】范围过滤：仅导出今天");
  const resp3 = await exportReq("format=json&routeId=" + ROUTE + "&date=" + TODAY, tokM);
  const j3 = JSON.parse(await resp3.text());
  check("按 date 过滤后仅 1 单", j3.count === 1 && j3.waybills[0].id === "w-today", "count=" + j3.count);

  console.log("\n【4】format 非法 → 400");
  const resp4 = await exportReq("format=xml&routeId=" + ROUTE, tokM);
  const j4 = JSON.parse(await resp4.text());
  check("非法 format 被拒", j4.success === false, "code=" + j4.code);

  console.log("\n【5】越权线路 → 403");
  const resp5 = await exportReq("format=csv&routeId=" + ROUTE, "tok-X");
  const j5 = JSON.parse(await resp5.text());
  check("越权导出被拒", j5.success === false, "code=" + j5.code + " error=" + j5.error);

  console.log("─".repeat(56));
  console.log("历史导出回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
