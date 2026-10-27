/**
 * Lua 脚本归一化（供 EVAL 注册表按内容精确匹配）。
 * 与具体存储无关，零依赖，避免 _db.js ↔ _redis-eval.js 循环依赖。
 *
 * 归一化步骤：
 *   1. 去除块注释 --[[ ... ]] 与行注释 -- ...
 *   2. 折叠所有空白（含换行/制表/连续空格）为单空格并裁边
 *   3. 把 Lua 字符串字面量统一成单引号（消除 "GET" 与 'GET' 的写法差异，
 *      从而让「同一逻辑、仅引号不同」的脚本必定匹配）
 */
export function normalizeLua(script) {
  let s = String(script || "");
  s = s.replace(/--\[\[[\s\S]*?\]\]/g, " ");
  s = s.replace(/--[^\n]*/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // 折叠相邻引号：先把双引号串内的双引号换成单引号（仅针对 Lua 串定界符层面）。
  // 做法：将整段里的 " 替换为 '（Lua 串定界符统一），不影响语义。
  s = s.replace(/"/g, "'");
  return s;
}

export default { normalizeLua };
