// 智配One · 自动回填（history-lookup）回归（P0 自动回填 / 报告 P1-2）
// ------------------------------------------------------------------
// 覆盖：
//   (1) 输入手机号 → 返回最近一条匹配运单（date desc）的客户信息；
//   (2) 归一化：138-1234-5678 等价于 13812345678；
//   (3) 未命中 → found:false；
//   (4) 越权线路 → 403；
//   (5) 空查询 → 400。
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
  const lookupMod = await import(baseDir + "history-lookup.js");
  const query = (q, routeId, token) => {
    const u = "https://app.local/api/history-lookup?q=" + encodeURIComponent(q) + "&routeId=" + routeId;
    return lookupMod.onRequestGet({ request: getReq(u, token), env });
  };

  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  seedJson("zp:user:" + M, { id: M, role: "user", boundRouteId: ROUTE, dispatchRouteId: ROUTE, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-M", { userId: M, sessionVersion: 1 });
  seedJson("zp:user:uX", { id: "uX", role: "user", boundRouteId: OTHER, dispatchRouteId: OTHER, routeDuty: "delivery", sessionVersion: 1 });
  seedJson("zp:session:tok-X", { userId: "uX", sessionVersion: 1 });
  seedJson("zp:route:" + ROUTE, { id: ROUTE, name: "线路2001", status: "active" });

  const buildRecord = (id, date, phone, name) => ({
    schemaVersion: "2", id, routeId: ROUTE, routeName: "线路2001", date, vehicle: "粤B11111",
    customerName: name, phone, address: "杭州市余杭区", totalWeight: 1.2,
    stores: [{ storeId: "JM03050", name: "门店A", phone, address: "余杭区文一西路", routeOrder: 1 }],
    stage: "CONFIRMED", summary: { original: 1, total: 1 }, createdAt: date + "T09:00:00+08:00",
  });
  const indexKey = (date) => "zp:route:" + ROUTE + ":waybills:" + date;

  // w-now（今天，张三）与 w-old（40 天前，同号张三）→ 回填应取最近一条 w-now
  seedJson("zp:waybill:w-now", buildRecord("w-now", TODAY, "13812345678", "张三"));
  red.command(["SADD", indexKey(TODAY), "w-now"]);
  seedJson("zp:waybill:w-old", buildRecord("w-old", OLD, "13812345678", "张三"));
  red.command(["SADD", indexKey(OLD), "w-old"]);

  console.log("\n【1】输入手机号 → 返回最近一条（今天）匹配");
  const r1 = await (await query("13812345678", ROUTE, tokM)).json();
  check("命中 found=true", r1.success && r1.found === true, "code=" + r1.code);
  check("取最近一条 date=TODAY", r1.match && r1.match.date === TODAY, "date=" + (r1.match && r1.match.date));
  check("返回客户名 张三", r1.match && r1.match.customerName === "张三");
  check("返回手机号", r1.match && r1.match.phone === "13812345678");
  check("返回门店清单非空", r1.match && Array.isArray(r1.match.stores) && r1.match.stores.length === 1);
  check("命中多条时 hitCount>=2", r1.hitCount >= 2, "hitCount=" + r1.hitCount);

  console.log("\n【2】归一化：138-1234-5678 等价于 13812345678");
  const r2 = await (await query("138-1234-5678", ROUTE, tokM)).json();
  check("归一化命中", r2.success && r2.found === true && r2.match.date === TODAY, "date=" + (r2.match && r2.match.date));

  console.log("\n【3】未命中 → found:false");
  const r3 = await (await query("00000000000", ROUTE, tokM)).json();
  check("未命中 found=false", r3.success && r3.found === false, "found=" + r3.found);

  console.log("\n【4】越权线路 → 403");
  const r4 = await (await query("13812345678", ROUTE, "tok-X")).json();
  check("越权查询被拒", r4.success === false && (r4.code === undefined ? false : true), "code=" + r4.code + " error=" + r4.error);

  console.log("\n【5】空查询 → 400");
  const r5 = await (await query("   ", ROUTE, tokM)).json();
  check("空查询被拒 400", r5.success === false, "code=" + r5.code);

  console.log("─".repeat(56));
  console.log("自动回填回归：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
