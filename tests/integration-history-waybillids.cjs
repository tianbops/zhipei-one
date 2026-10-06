// P1-3 集成回归（1.0 收口）：历史接口不再以「当日最后一张」作为隐含代表运单
// 验证 history 月视图/单日查询返回 waybillIds[] + hasMultiple，移除 waybillId:list[last] 隐含默认入口，
// 符合「waybillId 是运单唯一事实源」原则；前端据此进入「当日运单列表 → 指定 waybillId → 详情」。
// 运行：node tests/integration-history-waybillids.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const todayCN = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const getReq = (url, token) => ({ url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) } });

(async () => {
  const TODAY = todayCN();
  const R = "route-hist";
  const uId = "uH", tok = "tok-H";
  seed("user:" + uId, { id: uId, role: "user", boundRouteId: R, dispatchRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tok, { userId: uId, sessionVersion: 1 });
  seed("route:" + R, { id: R, name: "线路H", status: "active" });

  const ids = ["H1", "H2", "H3"];
  let i = 0;
  for (const id of ids) {
    seed("waybill:" + id, {
      schemaVersion: "2", id, routeId: R, routeName: "线路H", date: TODAY, vehicle: "粤B0001", totalWeight: 0.1, stores: [],
      summary: { original: 0, total: 0, matched: 0, pending: 0, correction: 0, merged: 0, newStores: 0 },
      stage: "CONFIRMED",
      pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
      createdBy: uId, createdAt: TODAY + "T0" + String(i) + ":00:00.000Z",
      quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null }
    });
    i++;
  }
  red.command(["SADD", "zp:route:" + R + ":waybills:" + TODAY, ...ids]);

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const histMod = await import(baseDir + "history.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  const m = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R, tok), env })).json();
  const day = m.history.find(x => x.date === TODAY);
  check("月视图含当日", !!day);
  check("月视图返回 waybillIds 含 3 张", day && Array.isArray(day.waybillIds) && day.waybillIds.length === 3, "ids=" + (day ? day.waybillIds.length : 0));
  check("hasMultiple=true（单日多张）", day && day.hasMultiple === true);
  check("月视图不再以 waybillId 作为隐含代表运单", day && !("waybillId" in day), "keys=" + (day ? Object.keys(day).join(",") : ""));

  const s = await (await histMod.onRequestGet({ request: getReq("https://app.local/api/history?routeId=" + R + "&date=" + TODAY, tok), env })).json();
  check("单日查询返回成功", s.success === true);
  check("单日返回 waybillIds 含 3 张", s && Array.isArray(s.waybillIds) && s.waybillIds.length === 3, "ids=" + (s && s.waybillIds ? s.waybillIds.length : 0));
  check("单日 hasMultiple=true", s && s.hasMultiple === true);
  check("单日不再返回隐含 waybill 单张字段", s && !("waybill" in s), "keys=" + (s ? Object.keys(s).join(",") : ""));
  check("单日仍返回 waybills 数组（前端可选渲染列表）", s && Array.isArray(s.waybills) && s.waybills.length === 3);

  console.log("\nHISTORY_WAYBILLIDS 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
