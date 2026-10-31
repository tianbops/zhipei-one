/**
 * 运单处理状态机（_waybill-proc）单元测试
 * 验证 PROCESSING → TIMEOUT/FAILED/CANCELLED/DONE 的状态转移与 recoverable/action/hint 携带。
 * 运行：node tests/unit-waybill-proc.test.cjs
 */
const { MiniRedis, makeUpstash } = require("./_mini-redis.cjs");

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log("  ✅ " + name + (info ? "  " + info : "")); }
  else { fail++; console.log("  ❌ " + name + "  " + (info || "")); }
}

(async () => {
  const red = makeUpstash(new MiniRedis());
  const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "x" };
  const mod = await import("../functions/api/waybills/_waybill-proc.js");
  const { beginProc, failProc, getProc, finishProc, claimProcSave, claimProcSaveDetailed, cancelProc, PROC_STAGES } = mod;

  console.log("【A】状态枚举与初始 PROCESSING");
  check("导出 PROC_STAGES 含 6 个状态（含视图态 STALLED）", PROC_STAGES.length === 6 && PROC_STAGES.includes("PROCESSING") && PROC_STAGES.includes("STALLED") && PROC_STAGES.includes("DONE") && PROC_STAGES.includes("TIMEOUT") && PROC_STAGES.includes("FAILED") && PROC_STAGES.includes("CANCELLED"));
  const rid = "req-unit-1";
  const started = await beginProc(env, { requestId: rid, routeId: "route-x", userId: "u1", fileName: "w.png" });
  check("beginProc 返回 PROCESSING 票据", started && started.stage === "PROCESSING" && started.routeId === "route-x" && started.userId === "u1" && started.fileName === "w.png");
  const g0 = await getProc(env, rid);
  check("getProc 可读回 PROCESSING", g0 && g0.stage === "PROCESSING");

  console.log("【B】失败转移：TIMEOUT + 可恢复 RETRY_OCR");
  const t = await failProc(env, rid, { stage: "TIMEOUT", recoverable: true, action: "RETRY_OCR", hint: "OCR识别超时，可重新上传运单重试" });
  check("failProc 转 TIMEOUT", t && t.stage === "TIMEOUT");
  check("TIMEOUT 携带 recoverable=true", t.recoverable === true);
  check("TIMEOUT 携带 action=RETRY_OCR", t.action === "RETRY_OCR");
  check("TIMEOUT 携带 hint", typeof t.hint === "string" && t.hint.length > 0);
  const g1 = await getProc(env, rid);
  check("getProc 读回 TIMEOUT 全字段", g1.stage === "TIMEOUT" && g1.recoverable === true && g1.action === "RETRY_OCR" && g1.hint === "OCR识别超时，可重新上传运单重试");

  console.log("【C】失败转移：CANCELLED（用户取消）");
  const rid2 = "req-unit-2";
  await beginProc(env, { requestId: rid2, routeId: "route-x", userId: "u1" });
  const c = await failProc(env, rid2, { stage: "CANCELLED", recoverable: true, action: "REPROCESS", hint: "已取消识别，可重新上传运单" });
  check("CANCELLED 状态正确", c && c.stage === "CANCELLED" && c.action === "REPROCESS");

  console.log("【D】成功转移：DONE + 关联 waybillId");
  const rid3 = "req-unit-3";
  await beginProc(env, { requestId: rid3, routeId: "route-x", userId: "u1" });
  const d = await finishProc(env, rid3, "wb-abc");
  check("finishProc 转 DONE", d && d.stage === "DONE");
  check("DONE 关联 waybillId", d.waybillId === "wb-abc");
  const g3 = await getProc(env, rid3);
  check("getProc 读回 DONE + waybillId", g3.stage === "DONE" && g3.waybillId === "wb-abc");

  console.log("【E】保存声明与取消竞态：取消先赢 → 禁止保存");
  const rid4 = "req-unit-race-cancel-first";
  await beginProc(env, { requestId: rid4, routeId: "route-x", userId: "u1" });
  const cancelledFirst = await cancelProc(env, rid4, { action: "REPROCESS", hint: "已取消" });
  const claimAfterCancel = await claimProcSave(env, rid4);
  check("取消先成功", cancelledFirst === true);
  check("取消后保存声明失败", claimAfterCancel === false);
  check("取消终态保持 CANCELLED", (await getProc(env, rid4)).stage === "CANCELLED");
  const cancelledDetail = await claimProcSaveDetailed(env, rid4);
  check("详细保存声明识别 CANCELLED", cancelledDetail.ok === false && cancelledDetail.reason === "CANCELLED");

  console.log("【F】保存声明先赢 → 迟到取消不得覆盖，最终 DONE");
  const rid5 = "req-unit-race-save-first";
  await beginProc(env, { requestId: rid5, routeId: "route-x", userId: "u1" });
  const claimFirst = await claimProcSave(env, rid5);
  const cancelledLate = await cancelProc(env, rid5, { action: "REPROCESS", hint: "已取消" });
  const doneAfterClaim = await finishProc(env, rid5, "wb-race");
  check("保存声明成功", claimFirst === true);
  check("保存声明后迟到取消被拒绝", cancelledLate === false);
  check("保存完成后终态为 DONE", doneAfterClaim && doneAfterClaim.stage === "DONE" && doneAfterClaim.waybillId === "wb-race");
  const doneDetail = await claimProcSaveDetailed(env, rid5);
  check("详细保存声明识别 DONE", doneDetail.ok === false && doneDetail.reason === "DONE" && doneDetail.proc.waybillId === "wb-race");

  console.log("【G】终态保护：迟到失败不得覆盖 CANCELLED / DONE");
  const lateCancel = await failProc(env, rid4, { stage: "FAILED", recoverable: true, action: "RETRY_SAVE", hint: "迟到失败" });
  const lateDone = await failProc(env, rid5, { stage: "FAILED", recoverable: true, action: "RETRY_SAVE", hint: "迟到失败" });
  check("CANCELLED 不被迟到 FAILED 覆盖", lateCancel && lateCancel.stage === "CANCELLED");
  check("DONE 不被迟到 FAILED 覆盖", lateDone && lateDone.stage === "DONE" && lateDone.waybillId === "wb-race");

  console.log("【G】边界：缺少 requestId 安全返回 null");
  check("beginProc(null) 返回 null", (await beginProc(env, { requestId: null, routeId: "r", userId: "u" })) === null);
  check("getProc(unknown) 返回 null", (await getProc(env, "nope")) === null);
  const missingDetail = await claimProcSaveDetailed(env, "missing-ticket");
  check("详细保存声明识别票据不存在", missingDetail.ok === false && missingDetail.reason === "TICKET_MISSING");
  check("详细保存声明识别缺失 requestId", (await claimProcSaveDetailed(env, null)).reason === "REQUEST_ID_MISSING");

  console.log("─".repeat(50));
  console.log("状态机单元测试：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("测试运行异常：", e); process.exit(1); });
