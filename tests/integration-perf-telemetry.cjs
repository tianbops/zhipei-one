// 性能遥测集成回归：账户接口细分 + 非 2xx 的 HTTP 状态码细分 + 服务端耗时保留。
// 运行：node tests/integration-perf-telemetry.cjs
// 说明：此前 perf 相关测试只能做源码字符串断言，因为 MiniRedis 不支持 HINCRBY/HINCRBYFLOAT，
//       perf-event 的 Lua 聚合无法在本地执行。补齐这两条命令后，本用例可真正端到端验证：
//       浏览器事件 -> zp:perf:hour:* 聚合 -> /api/perf-report 输出结构。
const { pathToFileURL } = require("url");
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

const red = makeUpstash(new MiniRedis());
let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}
const seed = (key, obj) => red.command(["SET", "zp:" + key, JSON.stringify(obj)]);
const getReq = (url, token) => ({
  url, method: "GET",
  headers: { get: h => (String(h).toLowerCase() === "authorization" ? "Bearer " + token : null) }
});
const postPerf = (events) => {
  const raw = JSON.stringify({ events });
  return {
    url: "https://app.local/api/perf-event", method: "POST",
    headers: { get: h => {
      const n = String(h).toLowerCase();
      if (n === "origin") return "https://app.local";
      if (n === "content-length") return String(raw.length);
      return null;
    } },
    text: async () => raw
  };
};
const findGroup = (report, page, endpoint, status) => {
  for (const h of report.totals.hours || []) {
    for (const g of h.groups || []) {
      if (g.page === page && g.endpoint === endpoint && g.status === status) return g;
    }
  }
  return null;
};

(async () => {
  const adminId = "uAdmin", tok = "tok-admin";
  seed("user:" + adminId, { id: adminId, username: "admin", role: "admin", name: "", sessionVersion: 1 });
  seed("session:" + tok, { userId: adminId, sessionVersion: 1 });

  const baseDir = pathToFileURL(__dirname + "/../functions/api/").href;
  const perfEvent = await import(baseDir + "perf-event.js");
  const perfReport = await import(baseDir + "perf-report.js");
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x", PADDLEOCR_ACCESS_TOKEN: "x" };

  console.log("\n[A] 上报一批浏览器事件（含账户 4xx/401、403、网络失败、历史 2xx 带阶段、非法状态码）");
  const ack = await (await perfEvent.onRequestPost({ request: postPerf([
    { page: "account", endpoint: "api-account-me", status: "4xx", duration: 3000, server: 120, code: 401 },
    { page: "account", endpoint: "api-account-me", status: "4xx", duration: 4500, server: 130, code: 401 },
    { page: "account", endpoint: "api-account-me", status: "2xx", duration: 2500, server: 800, code: 200 },
    { page: "account", endpoint: "api-account-settings", status: "4xx", duration: 1500, server: 90, code: 403 },
    { page: "account", endpoint: "api-account-me", status: "network", duration: 78000, server: null },
    { page: "account", endpoint: "api-account-me", status: "abort", duration: 12, server: null },
    { page: "account", endpoint: "api-account-me", status: "timeout", duration: 30000, server: null },
    { page: "history", endpoint: "api-history", status: "2xx", duration: 87000, server: 1243,
      phases: { "history-index": 12.3, "history-aggregate": 45.6, "history-db-primary-queries": 3, "history-db-replica-queries": 2, "history-db-region-apac-queries": 2, "history-bogus-phase": 9.9 } },
    { page: "home", endpoint: "api-waybill-process", status: "2xx", duration: 56000, server: 32000,
      phases: { "waybill-client-compress": 300, "waybill-client-first-response": 5000, "waybill-client-stream": 50000, "waybill-server-ocr": 20000, "waybill-server-base": 150, "waybill-server-base-lookup": 120, "waybill-server-base-index": 2, "waybill-server-base-wait": 0, "waybill-server-base-overlap": 122, "waybill-server-total": 32000, "waybill-server-save-lifecycle-events": 3.5, "waybill-server-end-to-end": 36000, "waybill-server-temp-cleanup": 5.5 } },
    { page: "account", endpoint: "api-account", status: "4xx", duration: 1000, server: 30, code: 409 },
    { page: "account", endpoint: "api-account-me", status: "4xx", duration: 1000, server: 10, code: 999 },
    { page: "account", endpoint: "api-not-whitelisted", status: "2xx", duration: 100, server: 5 }
  ]), env })).json();
  check("事件接收：合法 8 条被接受、非法端点被拒", ack.success === true && ack.accepted === 11, JSON.stringify(ack));

  console.log("\n[B] 读取管理员报告");
  const rep = await (await perfReport.onRequestGet({ request: getReq("https://app.local/api/perf-report", tok), env })).json();
  check("报告读取成功", rep.success === true && !!rep.totals, rep.success ? "" : JSON.stringify(rep));

  console.log("\n[C] 账户接口细分（此前 /api/me 与 /api/account* 被并成一个 api-account）");
  const eps = Object.keys(rep.totals.endpoints || {});
  check("api-account-me 作为独立接口出现", eps.includes("api-account-me"), JSON.stringify(eps));
  check("api-account-settings 作为独立接口出现", eps.includes("api-account-settings"));
  check("api-waybill-process 作为独立端到端指标出现", eps.includes("api-waybill-process"));
  check("旧标签 api-account 仍可读取（兼容未升级客户端的历史数据）", eps.includes("api-account"));
  check("未白名单的端点不出现在报告里", !eps.includes("api-not-whitelisted"));

  console.log("\n[D] 非 2xx 的 HTTP 状态码细分（把「账户 30 次异常」拆到真实原因）");
  const g401 = findGroup(rep, "account", "api-account-me", "4xx");
  const codes = g401 && g401.codes;
  check("4xx 组带 codes 细分", !!codes, JSON.stringify(g401 && Object.keys(g401.codes || {})));
  check("401 聚合为 2 次且平均耗时正确", codes && codes["401"] && codes["401"].count === 2 && codes["401"].avgMs === 3750,
    JSON.stringify(codes && codes["401"]));
  check("401 的服务端耗时被保留", codes && codes["401"] && codes["401"].serverAvgMs === 125,
    JSON.stringify(codes && codes["401"]));
  check("401 峰值取最大值 4500", codes && codes["401"] && codes["401"].max === 4500);
  check("非法状态码 999 未被聚合", codes && codes["999"] === undefined);
  const gSettings = findGroup(rep, "account", "api-account-settings", "4xx");
  check("403 归属到 account-settings 而非 me", gSettings && gSettings.codes && gSettings.codes["403"] && gSettings.codes["403"].count === 1,
    JSON.stringify(gSettings && gSettings.codes));

  console.log("\n[E] 状态码与服务/网络失败必须分开（不可混为一类）");
  const gNet = findGroup(rep, "account", "api-account-me", "network");
  check("network 单独成组", !!gNet, JSON.stringify(gNet && { count: gNet.count, avgMs: gNet.avgMs }));
  check("network 组没有状态码细分（连接层失败本就没有状态码）", gNet && !gNet.codes);
  check("network 峰值 78000ms 被记录", gNet && gNet.max === 78000);
  const gAbort = findGroup(rep, "account", "api-account-me", "abort");
  check("abort 主动取消独立成组", !!gAbort && gAbort.count === 1 && gAbort.max === 12, JSON.stringify(gAbort));
  check("abort 组没有 HTTP 状态码", gAbort && !gAbort.codes);
  const gTimeout = findGroup(rep, "account", "api-account-me", "timeout");
  check("timeout 超时独立成组", !!gTimeout && gTimeout.count === 1 && gTimeout.max === 30000, JSON.stringify(gTimeout));
  check("timeout 组没有 HTTP 状态码", gTimeout && !gTimeout.codes);
  const g2xx = findGroup(rep, "account", "api-account-me", "2xx");
  check("2xx 组不产生状态码细分（不无谓放大样本体积）", g2xx && !g2xx.codes);

  console.log("\n[F] 既有能力不被破坏（历史阶段计时 / 服务端耗时 / 旧格式字段）");
  const gHist = findGroup(rep, "history", "api-history", "2xx");
  check("历史分组仍然携带阶段计时", gHist && gHist.phases && gHist.phases["history-index"] && gHist.phases["history-index"].avgMs === 12.3,
    JSON.stringify(gHist && gHist.phases));
  check("未授权阶段名被丢弃", gHist && gHist.phases && gHist.phases["history-bogus-phase"] === undefined);
  check("D1 主库读取数被聚合", gHist && gHist.phases && gHist.phases["history-db-primary-queries"] && gHist.phases["history-db-primary-queries"].avgMs === 3);
  check("D1 副本读取数被聚合", gHist && gHist.phases && gHist.phases["history-db-replica-queries"] && gHist.phases["history-db-replica-queries"].avgMs === 2);
  check("D1 实际读取区域被聚合", gHist && gHist.phases && gHist.phases["history-db-region-apac-queries"] && gHist.phases["history-db-region-apac-queries"].avgMs === 2);
  const gWaybill = findGroup(rep, "home", "api-waybill-process", "2xx");
  check("运单端到端处理独立成组", !!gWaybill, JSON.stringify(gWaybill && gWaybill.endpoint));
  check("waybill 阶段映射到既有 history 命名空间", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-total"] && gWaybill.phases["history-waybill-server-total"].avgMs === 32000,
    JSON.stringify(gWaybill && gWaybill.phases));
  check("线路基准读取耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-base-lookup"] && gWaybill.phases["history-waybill-server-base-lookup"].avgMs === 120);
  check("线路基准索引编译耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-base-index"] && gWaybill.phases["history-waybill-server-base-index"].avgMs === 2);
  check("OCR 后剩余等待可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-base-wait"] && gWaybill.phases["history-waybill-server-base-wait"].avgMs === 0);
  check("OCR 期间重叠耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-base-overlap"] && gWaybill.phases["history-waybill-server-base-overlap"].avgMs === 122);
  check("OCR 阶段耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-ocr"] && gWaybill.phases["history-waybill-server-ocr"].avgMs === 20000);
  check("保存阶段耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-save-lifecycle-events"] && gWaybill.phases["history-waybill-server-save-lifecycle-events"].avgMs === 3.5);
  check("R2 清理耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-temp-cleanup"] && gWaybill.phases["history-waybill-server-temp-cleanup"].avgMs === 5.5);
  check("上传至服务端清理完成总耗时可聚合", gWaybill && gWaybill.phases && gWaybill.phases["history-waybill-server-end-to-end"] && gWaybill.phases["history-waybill-server-end-to-end"].avgMs === 36000);
  check("运单服务端总耗时被保留", gWaybill && gWaybill.serverAvgMs === 32000);
  check("2xx 的服务端平均耗时保留", gHist && gHist.serverAvgMs === 1243, JSON.stringify(gHist && gHist.serverAvgMs));
  check("旧格式字段 page|endpoint|status|metric 仍可解析", gHist && gHist.count === 1 && gHist.avgMs === 87000);

  console.log("\n[G] 权限：非管理员不能读性能报告");
  const uid = "uNormal"; seed("user:" + uid, { id: uid, role: "user", sessionVersion: 1 });
  seed("session:" + tok + "N", { userId: uid, sessionVersion: 1 });
  const denied = await perfReport.onRequestGet({ request: getReq("https://app.local/api/perf-report", tok + "N"), env });
  check("普通用户读取被拒 403", denied.status === 403, "status=" + denied.status);

  console.log("\nPERF_TELEMETRY 集成：" + (fail === 0 ? "通过 " + pass + " / 失败 0" : "通过 " + pass + " / 失败 " + fail));
  if (fail > 0) process.exitCode = 1;
})();
