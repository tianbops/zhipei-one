// P1-1 集成回归（1.0 收口）：RETRY_SAVE 票据超过 15min（或已不存在）时，重保存入口明确返回 RESUME_INVALID + RESUBMIT
// 验证「用户离开 → 超过 TTL → 回来重试」不会卡死或静默失败，而是给出明确的「保存任务已失效，请重新上传」引导。
// 运行：node tests/integration-retry-save-expiry.cjs
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const postFormReq = (url, token, fd) => ({ url, headers: { get: (h) => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }, formData: async () => fd });

(async () => {
  const R = "route-rs";
  const uId = "uR", tok = "tok-R";
  seed("user:" + uId, { id: uId, role: "user", boundRouteId: R, dispatchRouteId: R, routeDuty: "driver", sessionVersion: 1 });
  seed("session:" + tok, { userId: uId, sessionVersion: 1 });
  seed("route:" + R, { id: R, name: "线路R", status: "active" });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const processMod = await import(baseDir + "waybills/process.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  // 票据不存在（等同超过 15min TTL 已消失）→ resume 应 RESUME_INVALID
  const fd = new FormData();
  fd.append("routeId", R);
  fd.append("rawText", "x");
  fd.append("resumeRequestId", "ghost-request");
  const r = await (await processMod.onRequestPost({ request: postFormReq("https://app.local/api/waybills/process", tok, fd), env })).json();

  check("RETRY_SAVE 票据不存在 → 整体失败", r.success !== true);
  check("code=RESUME_INVALID", r.code === "RESUME_INVALID", "code=" + (r.code || ""));
  check("action=RESUBMIT（引导用户重新上传）", r.action === "RESUBMIT", "action=" + (r.action || ""));
  check("hint 明确提示保存任务已失效/请重新上传", /失效|重新上传/.test(r.hint || ""), "hint=" + (r.hint || ""));

  console.log("\nRETRY_SAVE_EXPIRY 集成：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})();
