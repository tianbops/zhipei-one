import {json} from "./_json.js";
import {command,get} from "./_redis.js";
import {Budget,mgetBatchMap,throwBudgetExceeded,SUBREQUEST_LIMIT} from "./_redis-budget.js";

// 遗留角色 → 规范角色 的映射。
// system_admin 在权限层（isSystemAdmin）本就等同 admin，从未有任何写入路径产生它，
// 仅历史上遗留账户可能带此 role。归一化不改变任何权限语义，只消除存储中的歧义词表。
const LEGACY_ROLE_MAP = { system_admin: "admin" };

const NORMALIZE_SCRIPT = "local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.role=='system_admin' then u.role='admin'; redis.call('SET',KEYS[1],cjson.encode(u)); return 1 end; return 0";

// 幂等：扫描 users:index，把每个遗留别名角色改写为规范角色。
// 返回扫描数 / 归一化数 / 错误列表，可重复执行（已规范的账户不会再动）。
//
// P2-10 收口：原实现对 users:index 里**每个**用户各发一次 EVAL（O(N) 子请求），
// 而 system_admin 是历史上极少量账户，正常情况下绝大多数 EVAL 都是纯浪费的往返。
// 现改为「先 MGET 批量读 → 只对真正命中遗留角色的用户发 EVAL」：
//   子请求从 O(全部用户数) 降到 ceil(N/100) + 实际命中数，且全程纳入统一 Budget，
// 预算不足即抛 SUBREQUEST_BUDGET_EXCEEDED，绝不谎报"已全部归一化"。
export async function normalizeLegacyRoles(env) {
  const raw = await get(env, "users:index");
  let ids = [];
  try { const v = typeof raw === "string" ? JSON.parse(raw) : raw; if (Array.isArray(v)) ids = v; } catch {}
  const cleanIds = [];
  for (const id of ids) if (typeof id === "string" && id.trim()) cleanIds.push(id);
  let scanned = 0, normalized = 0; const errors = [];
  if (!cleanIds.length) return { scanned, normalized, errors, complete: true };

  const budget = new Budget(SUBREQUEST_LIMIT);
  const { map, complete } = await mgetBatchMap(env, cleanIds.map(id => "zp:user:" + id), budget, { batch: 100 });
  if (!complete) throwBudgetExceeded(budget.max, "normalize-legacy-roles-read");

  // 只有真的还带 system_admin 的账户才值得发 EVAL
  const targets = [];
  for (const id of cleanIds) {
    scanned++;
    const item = map.get("zp:user:" + id);
    if (!item) continue;
    let u = null;
    try { u = typeof item === "string" ? JSON.parse(item) : item; } catch {}
    if (u && typeof u === "object" && Object.prototype.hasOwnProperty.call(LEGACY_ROLE_MAP, String(u.role || ""))) targets.push(id);
  }

  for (const id of targets) {
    try {
      if (!budget.take(1)) throwBudgetExceeded(budget.max, "normalize-legacy-roles-write");
      const code = Number(await command(env, ["EVAL", NORMALIZE_SCRIPT, "1", "zp:user:" + id]));
      if (code === 1) normalized++;
    } catch (e) {
      if (e?.code === "SUBREQUEST_BUDGET_EXCEEDED") throw e;   // 预算耗尽必须上报，不可混入 errors 后谎报完成
      errors.push(String(id) + ":" + String(e?.message || e));
    }
  }
  return { scanned, normalized, errors, complete: true };
}
