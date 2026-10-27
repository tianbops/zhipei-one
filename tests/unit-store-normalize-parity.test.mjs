/**
 * 门店名归一函数一致性回归测试
 * ------------------------------------------------------------------
 * 运行：node tests/unit-store-normalize-parity.test.mjs
 *
 * 背景（真实事故，务必读完再改本文件）：
 *   提交 c405fe04（2026-10-08「修复首页今日运单读取异常兜底」）在改动
 *   functions/api/waybills/latest.js 时，把 baseKey 这一行丢失了两个反斜杠：
 *       replace(/\s+/g,"")   →  replace(/s+/g,"")     # \s 退化成 s
 *       replace(/[…【】\[\]…]/g,"") → replace(/[…【】[]…]/g,"")  # \[ \] 退化成 [ ]
 *   两个 bug 的后果不同，但都不报错、不崩溃，属于静默降级：
 *     1. /s+/g 会**删掉门店名里所有字母 s**："北京s店" → "北京店"，
 *        从而与真正的"北京店"发生 hash 碰撞 → 补错备注与导航链接。
 *     2. 字符类里未转义的 ] 会让字符类提前闭合，导致**去标点整段失效**：
 *        "阳光店（A座）" 保留括号、"SS 便利店" 保留空格 → 与基准库对不上，漏补。
 *   该行来自 _history-read.js 的同名 baseKey，属于抄写损坏；已在 2026-10-28 修复，
 *   本测试的作用是**锁死它不许再退化**。
 *
 * 覆盖：
 *   1. latest.js 的 baseKey 行为正确性（不删字母 s / 去空白 / 去中文标点）
 *   2. latest.js 与 _history-read.js 两个同名 baseKey 口径完全一致
 *   3. 全库静态扫描：禁止再出现 /s+/g 与未转义 [] 字符类这类退化写法
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0,
  fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (extra ? " → " + extra : ""));
  }
}

function findBaseKeyExpr(src) {
  const line = src.split("\n").find((l) => l.includes("const baseKey=") && l.includes("normalize"));
  if (!line) throw new Error("未找到 baseKey 定义行（格式变更请同步更新本测试）");
  // 该行可能是 `const baseKey=v=>…,byName=new Map();` 的逗号复合声明，
  // 因此只截取到最后一个 .toLowerCase()（箭头函数体的结尾），避免把后续声明卷进来。
  const arrowStart = line.indexOf("v=>");
  const end = line.lastIndexOf(".toLowerCase()");
  if (arrowStart < 0 || end < 0)
    throw new Error("未能定位 baseKey 箭头函数体（格式变更请同步更新本测试）");
  return line.slice(arrowStart, end + ".toLowerCase()".length);
}

/** 从源码里抽出 baseKey 的箭头函数表达式并实例化（clean 与源文件同名同实现）。 */
function evalArrow(srcLine, label) {
  const clean = (v) => String(v ?? "").trim();
  const expr = findBaseKeyExpr(srcLine);
  // eslint-disable-next-line no-new-func
  const fn = new Function("clean", `return (${expr});`)(clean);
  if (typeof fn !== "function") throw new Error(`${label}: 未能解析出 baseKey 函数`);
  return fn;
}

function findBaseKeyLine(src) {
  const line = src.split("\n").find((l) => l.includes("const baseKey=") && l.includes("normalize"));
  if (!line) throw new Error("未找到 baseKey 定义行（格式变更请同步更新本测试）");
  return line;
}

/* ============ 1. latest.js baseKey 行为正确性 ============ */
const latestSrc = read("functions/api/waybills/latest.js");
const latestKey = evalArrow(findBaseKeyLine(latestSrc), "latest.js");

t(
  "不删除字母 s（回归：/s+/g 曾把 s 当空白删掉）",
  latestKey("北京世纪店") === latestKey("北京世纪店") &&
    latestKey("北京s店") !== latestKey("北京店"),
  `北京s店→${latestKey("北京s店")} / 北京店→${latestKey("北京店")}`
);
t("字母 s 原样保留", latestKey("北京s店").includes("s"), latestKey("北京s店"));
t("去除空格", latestKey("SS 便利店") === "ss便利店", latestKey("SS 便利店"));
t("去除全角空格", latestKey("SS　便利店") === "ss便利店", latestKey("SS　便利店"));
t("去除中文括号", latestKey("阳光店（A座）") === "阳光店a座", latestKey("阳光店（A座）"));
t("去除半角括号", latestKey("阳光店(A座)") === "阳光店a座", latestKey("阳光店(A座)"));
t("去除方括号", latestKey("阳光店[A座]") === "阳光店a座", latestKey("阳光店[A座]"));
t(
  "去除中文句号分号",
  latestKey("坂田营业点。A") === "坂田营业点a" && latestKey("坂田；A") === "坂田a",
  `${latestKey("坂田营业点。A")} / ${latestKey("坂田；A")}`
);
// 注意（既有口径，请勿擅自"强化"）：baseKey 的字符类不含半角逗号，而 NFKC 会把全角逗号
// 转成半角，故逗号会被保留。confirm.js / _global-learning.js 的 normalized 口径更强（含逗号），
// 两边本就不同；本处只要求 latest 与 _history-read 这两处**同名同用途**的函数一致。
// 任何"顺手把逗号也加上"的改动都属于改写门店匹配规则，必须先走人工验收。
t("NFKC 全角转半角", latestKey("ＡＢＣ店") === "abc店", latestKey("ＡＢＣ店"));
t(
  "格式差异视为同一门店（这是 baseline 回填能命中的前提）",
  latestKey("华润万家 (龙华店)") === latestKey("华润万家(龙华店)"),
  `${latestKey("华润万家 (龙华店)")} vs ${latestKey("华润万家(龙华店)")}`
);
t("不同门店不得碰撞", latestKey("北京店") !== latestKey("上海店"));

/* ============ 2. 两处同名 baseKey 口径必须一致 ============ */
const histSrc = read("functions/api/_history-read.js");
const histKey = evalArrow(findBaseKeyLine(histSrc), "_history-read.js");
const SAMPLES = [
  "北京世纪店 (朝阳)",
  "SS 便利店",
  "阳光店（A座）",
  "华润万家 (龙华店)",
  "沃尔玛[坂田店]",
  "7-11 便利店 (福田)",
  "",
  "  ",
  "顺丰速运；坂田营业点",
];
for (const s of SAMPLES) {
  t(
    `latest 与 _history-read 口径一致：「${s}」`,
    latestKey(s) === histKey(s),
    `latest=${latestKey(s)} / hist=${histKey(s)}`
  );
}

/* ============ 3. 全库静态扫描：禁止退化写法再有踪迹 ============ */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "coverage", "assets", ".wrangler"].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const offenders = { sus: [], badClass: [] };

// 3a. `replace(/s+/g` —— 缺反斜杠，会把字母 s 当空白删除
const SUS = /replace\(\/s\+/;
// 3b. 字符类内出现未转义的 `[` 或 `]`（如 【】[]{}），会让字符类提前闭合导致整段替换失效
const BADCLASS = /\[[^\]\n\\]*【】\[\]/;

const SELF = "tests/unit-store-normalize-parity.test.mjs";
for (const p of files) {
  const rel = relative(ROOT, p);
  if (rel === SELF) continue; // 本文件注释里引用了坏样例，必须自排除
  const src = read(rel);
  src.split("\n").forEach((line, i) => {
    const code = line.trim();
    // 跳过注释行：文档里允许以反例形式出现坏写法，但不许出现在可执行代码里
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (SUS.test(line)) offenders.sus.push(`${rel}:${i + 1}`);
    if (BADCLASS.test(line)) offenders.badClass.push(`${rel}:${i + 1}`);
  });
}

t(
  "全库无 replace(/s+ 退化写法（会删掉门店名里的字母 s）",
  offenders.sus.length === 0,
  offenders.sus.join(", ")
);
t(
  "全库无未转义 [] 字符类退化写法（会令去标点整段失效）",
  offenders.badClass.length === 0,
  offenders.badClass.join(", ")
);
t("扫描覆盖有效（扫到的源码文件数 > 20）", files.length > 20, `实际 ${files.length}`);

/* ============ 汇总 ============ */
console.log(`\n门店名归一一致性：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
if (fail) {
  console.error("失败用例：");
  failures.forEach((f) => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ 门店名归一函数口径一致，无退化写法");
