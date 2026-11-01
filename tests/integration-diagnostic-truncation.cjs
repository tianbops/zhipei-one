// P1-4 集成回归（1.0 收口）：运单诊断列表返回真实总数 + truncated 标记
// 验证管理员/用户面对「线路有 25 张运单」时，接口明确告知 count=25 / truncated=true / limit=20，
// 而非把 count 封顶为 20 让人误以为系统只有 20 张。
// 运行：node tests/integration-diagnostic-truncation.cjs
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
  const R = "route-diag";
  const uId = "uDg", tok = "tok-Dg";
  seed("user:" + uId, { id: uId, role: "user", boundRouteId: R, dispatchRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tok, { userId: uId, sessionVersion: 1 });
  seed("route:" + R, { id: R, name: "线路D", status: "active" });

  // seed 25 张运单（同线路，制造 >20 截断）；同时写线路×日期索引（P1-4b 后列表走索引+MGET）
  for (let i = 1; i <= 25; i++) {
    seed("waybill:W" + i, {
      schemaVersion: "2", id: "W" + i, routeId: R, routeName: "线路D", date: TODAY,
      vehicle: "粤B" + String(i).padStart(4, "0"), totalWeight: 0.1, stores: [],
      summary: { original: 0, total: 0, matched: 0, pending: 0, correction: 0, merged: 0, newStores: 0 },
      stage: "CONFIRMED",
      pipeline: ["RECOGNIZED", "EXTRACTED", "MATCHED", "DEDUPED", "PLANNED", "VALIDATED", "CONFIRMED"],
      createdBy: uId, createdAt: TODAY + "T08:00:00.000Z",
      quality: { level: "OK", flags: [] }, ocr: { provider: "PaddleOCR", lowConfidence: null },
      timing: {
        ocrStatusBatchRequestCount: 2, ocrStatusFallbackRequestCount: 0,
        ocrStatusSingleRequestCount: 0, ocrStatusBatchResponseJobCount: 4,
        ocrStatusBatchMatchedJobCount: 2, ocrStatusBatchMissingJobCount: 0,
        ocrImageTimings: [
          { imageIndex: 1, jobId: "job-one", statusMode: "batch", submitMs: 310, statusRequestMs: 230, batchStatusRequestCount: 1, resultFetchMs: 1100, resultChars: 7410, secret: "must-not-leak" },
          { imageIndex: 2, jobId: "job-two", statusMode: "batch", submitMs: 1214, statusRequestMs: 230, batchStatusRequestCount: 1, resultFetchMs: 1201, resultChars: 9270 }
        ]
      }
    });
    red.command(["SADD", "zp:route:" + R + ":waybills:" + TODAY, "W" + i]);
  }

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const diagMod = await import(baseDir + "waybills/diagnostic.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  const dResp = await diagMod.onRequestGet({ request: getReq("https://app.local/api/waybills/diagnostic?routeId=" + R, tok), env });
  const d = await dResp.json();

  check("诊断返回成功", d.success === true);
  check("count 为真实总数 25（非封顶 20）", d.count === 25, "count=" + d.count);
  check("truncated=true（25>20）", d.truncated === true);
  check("limit=20", d.limit === 20);
  check("waybills 仅返回前 20 张", Array.isArray(d.waybills) && d.waybills.length === 20, "len=" + (d.waybills ? d.waybills.length : 0));
  check("返回内容含 waybillId 字段（前端可定位）", d.waybills && d.waybills[0] && !!d.waybills[0].id);
  check("事件链字段为数组（pipeline LRANGE 批量读取）", d.waybills && Array.isArray(d.waybills[0].events));
  check("批量状态请求计数透传", d.waybills?.[0]?.timing?.ocrStatusBatchRequestCount === 2);
  check("逐图 OCR 计时透传两张图片", Array.isArray(d.waybills?.[0]?.timing?.ocrImageTimings) && d.waybills[0].timing.ocrImageTimings.length === 2);
  check("逐图批量模式和请求耗时透传", d.waybills?.[0]?.timing?.ocrImageTimings?.[0]?.statusMode === "batch" && d.waybills[0].timing.ocrImageTimings[0].statusRequestMs === 230);
  check("逐图诊断过滤未授权附加字段", !("secret" in (d.waybills?.[0]?.timing?.ocrImageTimings?.[0] || {})));

  console.log("\nDIAG_TRUNCATION 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
