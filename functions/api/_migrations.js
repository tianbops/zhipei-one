import {json} from "./_json.js";
import {command,get} from "./_redis.js";

// 遗留角色 → 规范角色 的映射。
// system_admin 在权限层（isSystemAdmin）本就等同 admin，从未有任何写入路径产生它，
// 仅历史上遗留账户可能带此 role。归一化不改变任何权限语义，只消除存储中的歧义词表。
const LEGACY_ROLE_MAP = { system_admin: "admin" };

// 幂等：扫描 users:index，把每个遗留别名角色改写为规范角色。
// 返回扫描数 / 归一化数 / 错误列表，可重复执行（已规范的账户不会再动）。
export async function normalizeLegacyRoles(env) {
  const raw = await get(env, "users:index");
  let ids = [];
  try { const v = typeof raw === "string" ? JSON.parse(raw) : raw; if (Array.isArray(v)) ids = v; } catch {}
  let scanned = 0, normalized = 0; const errors = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) continue;
    scanned++;
    const key = "zp:user:" + id;
    const script = "local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,u=pcall(cjson.decode,raw); if not ok or type(u)~='table' then return 0 end; if u.role=='system_admin' then u.role='admin'; redis.call('SET',KEYS[1],cjson.encode(u)); return 1 end; return 0";
    try { const code = Number(await command(env, ["EVAL", script, "1", key])); if (code === 1) normalized++; } catch (e) { errors.push(String(id) + ":" + String(e?.message || e)); }
  }
  return { scanned, normalized, errors };
}
