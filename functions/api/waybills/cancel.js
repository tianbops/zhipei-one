import { json } from "../_json.js";
import { currentUser } from "../_auth.js";
import { cancelProc, getProc } from "./_waybill-proc.js";

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ success: false, error: "未登录" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "请求格式错误" }, 400); }
  const requestId = String(body?.requestId || "").trim();
  if (!requestId || requestId.length > 128) return json({ success: false, error: "处理任务无效" }, 400);

  const proc = await getProc(env, requestId);
  if (!proc || String(proc.userId || "") !== String(user.id || "")) {
    return json({ success: false, state: "unavailable", error: "处理任务不存在或无权操作" }, 404);
  }
  if (proc.stage === "DONE") return json({ success: false, state: "done", message: "运单已保存，不能取消" }, 409);
  if (proc.saveClaimedAt) return json({ success: false, state: "saving", message: "运单正在保存，请等待结果" }, 409);

  const cancelled = await cancelProc(env, requestId, {
    action: "REPROCESS",
    hint: "本次处理已中止，请重新上传运单",
    detail: "USER_EXIT"
  });
  if (cancelled) return json({ success: true, state: "cancelled", requestId });

  const latest = await getProc(env, requestId);
  if (latest?.stage === "DONE") return json({ success: false, state: "done", message: "运单已保存，不能取消" }, 409);
  if (latest?.saveClaimedAt) return json({ success: false, state: "saving", message: "运单正在保存，请等待结果" }, 409);
  if (latest?.stage === "CANCELLED") return json({ success: true, state: "cancelled", requestId });
  return json({ success: false, state: "busy", message: "当前处理状态已变化，请等待结果" }, 409);
}
