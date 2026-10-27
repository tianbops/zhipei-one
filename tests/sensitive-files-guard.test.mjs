/**
 * 敏感文件守门测试
 * ------------------------------------------------------------------
 * 运行：node tests/sensitive-files-guard.test.mjs
 *
 * 背景：
 *   tools/migrate-upstash-to-d1.mjs 的 export 步骤默认产出 tools/.upstash-dump.json，
 *   内容是**生产数据全量转储**：用户记录（含 passwordHash）、活跃会话令牌、可用邀请码、
 *   真实运单（门店名/地址/电话）。截至 2026-10-27 该文件约 8.8MB 存在于本地工作区，
 *   且未被 .gitignore 覆盖 —— 一次 `git add -A` 就会把凭证与业务数据提交进公开仓库的历史里，
 *   事后即便删除文件也无法从 git 历史中清除。已于 2026-10-28 补 .gitignore 规则。
 *
 * 守护目标：
 *   1. 转储文件必须被 .gitignore 覆盖（用 git check-ignore 实测，而非仅检查文本）
 *   2. 仓库已跟踪文件里不得出现上述敏感产物
 *   3. 不得出现被跟踪的大体积 JSON 数据文件（> 512KB）——意外转储的兜底网
 *   4. 常见的密钥/令牌文件模式仍在忽略清单中
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let pass = 0,
  fail = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (extra ? " → " + extra : ""));
  }
};

const git = (args) => {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

/** git check-ignore 退出码 0 = 该文件被忽略规则命中。 */
const isIgnored = (relPath) => {
  try {
    execFileSync("git", ["check-ignore", "-q", relPath], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");

/* ============ 1. 转储产物必须被忽略（实测生效，不是只看写了规则） ============ */
const DUMP_PATTERNS = [
  "tools/.upstash-dump.json",
  "tools/anything.dump.json",
  "tmp.upstash-dump.json",
];
for (const p of DUMP_PATTERNS) {
  t(`转储产物被 gitignore 覆盖：${p}`, isIgnored(p), "规则存在但未命中，请检查 .gitignore");
}
t(".gitignore 明确写出迁移转储文件名", /upstash-dump\.json/.test(gitignore));

/* ============ 2. 已跟踪文件里不能有敏感产物 ============ */
const tracked = (git(["ls-files"]) || "").split("\n").filter(Boolean);
const FORBIDDEN = /(\.upstash-dump\.json$|\.dump\.json$|secrets\.json$|\.env$|\.dev\.vars$)/;
const trackedBad = tracked.filter((f) => FORBIDDEN.test(f));
t("仓库未跟踪任何敏感转储/密钥文件", trackedBad.length === 0, trackedBad.join(", "));

/* ============ 3. 大体积 JSON 兜底网 ============ */
const BIG_LIMIT = 512 * 1024;
const bigJsons = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "coverage", ".wrangler", "assets"].includes(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p);
    else if (/\.json$/i.test(name) && st.size > BIG_LIMIT)
      bigJsons.push(`${relative(ROOT, p)} (${(st.size / 1024 / 1024).toFixed(1)}MB)`);
  }
}
walk(ROOT);
// 已存在的历史大文件若被忽略则视为"已受控"（例如本地转储），不算失守
const untrackedBig = bigJsons.filter((entry) => {
  const rel = entry.split(" (")[0];
  return tracked.includes(rel) || !isIgnored(rel);
});
t(
  `无 >${BIG_LIMIT / 1024}KB 的裸奔 JSON 数据文件`,
  untrackedBig.length === 0,
  untrackedBig.join(", ")
);

/* ============ 4. 常见密钥模式仍在忽略清单 ============ */
for (const pat of [".env", ".dev.vars", "secrets.", "*.pem", "*.key"]) {
  t(
    `.gitignore 仍包含 ${pat}`,
    gitignore.split("\n").some((l) => l.trim() === pat || l.trim().startsWith(pat))
  );
}

/* ============ 5. 本地存在转储时的强提醒（不判失败，只输出） ============ */
if (existsSync(join(ROOT, "tools/.upstash-dump.json"))) {
  const controlled = isIgnored("tools/.upstash-dump.json");
  if (controlled) {
    console.log("提示：本地存在 tools/.upstash-dump.json（生产数据转储），已被忽略规则覆盖。");
    console.log("      该文件不需要时请手动删除；删除前请确认 D1 回灌能力已验证。");
  } else {
    console.error(
      "警告：tools/.upstash-dump.json 存在且**未被 gitignore 覆盖**，禁止执行 git add -A！"
    );
  }
}

console.log(`\n敏感文件守门：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
if (fail) {
  console.error("失败用例：");
  failures.forEach((f) => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ 敏感产物与密钥文件均处于忽略覆盖之下");
