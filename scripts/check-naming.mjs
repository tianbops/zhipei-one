#!/usr/bin/env node
/**
 * check-naming.mjs —— 命名一致性护栏
 *
 * 定位：与 sw-precache / csp-hashes / gen-api-docs 同属「工具链门禁」，产出方式一致：
 *       正常无输出 + exit 0；有问题打印清单 + exit 1。
 *
 * 设计原则（重要）：
 *   只对「应当同源」的标识符施加硬约束；对不同命名域只做「可见化」，绝不强判相等。
 *
 * 硬校验（失败即 exit 1）：
 *   1) package.json 的 name 必须等于 Git 远端仓库名（由 origin URL 推导，避免写死）
 *   2) version.json 的 version 必须等于最新语义化 tag（去掉 v 前缀）
 *      —— tag 是当前项目的唯一版本真值源（见 zhipei/scripts/sync-version.sh）
 *
 * 软提示（不失败，仅列出便于对照）：
 *   跨命名域标识符快照：Android applicationId / capacitor appId / wrangler 项目名 / manifest 展示名。
 *   这些标识符天然不同域（反域包名 vs 云端项目 slug vs 用户可见名），强行判等是伪约束。
 *
 * 用法：node scripts/check-naming.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, basename } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const problems = [];
const notes = [];

function readJSON(p) {
  const abs = resolve(ROOT, p);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, "utf8")); } catch { return null; }
}

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

/* ---------- 1) package.json name === 仓库名 ---------- */
const pkg = readJSON("package.json");
const remote = git("remote get-url origin");
let repoName = "";
if (remote) {
  const m = remote.match(/[/:]([^/:]+?)(?:\.git)?$/);
  if (m) repoName = m[1];
}
if (pkg?.name && repoName) {
  if (pkg.name !== repoName) {
    problems.push(
      `package.json 的 name 与仓库名不一致\n` +
      `    package.json name : ${pkg.name}\n` +
      `    Git 远端仓库名    : ${repoName}\n` +
      `    说明：该字段会被部分工具当作包标识，拼写漂移易误导协作者与自动化脚本。`
    );
  }
} else {
  notes.push("跳过 package.json name 校验（无远端或无 name 字段）");
}

/* ---------- 2) version.json === 最新 tag ---------- */
const version = readJSON("version.json")?.version;
const tags = git("tag --sort=-v:refname").split("\n").map(s => s.trim()).filter(Boolean);
const semverTags = tags.filter(t => /^v?\d+\.\d+\.\d+$/.test(t));
// 浅克隆（含 --depth 检出）的 tag 数据不完整，此时「本地最新 tag」不等于「真值最新 tag」，
// 强行比对会产生假警报 —— 误报的护栏会很快被人关掉，反而失去防护作用。
// 因此仅在完整克隆下硬校验；浅克隆降级为提示（CI 需用 fetch-depth: 0 才启用该硬门禁）。
const isShallow = git("rev-parse --is-shallow-repository") === "true";
const tagCheckEnforced = version && semverTags.length && !isShallow;
if (tagCheckEnforced) {
  const latestTag = semverTags[0];
  const latestVer = latestTag.replace(/^v/, "");
  if (version !== latestVer) {
    problems.push(
      `version.json 与最新 tag 不一致（tag 是唯一版本真值源）\n` +
      `    version.json      : ${version}\n` +
      `    最新语义化 tag    : ${latestTag}（${latestVer}）\n` +
      `    说明：发版请以 git tag 为准，避免关于页版本号与实际发布漂移。`
    );
  }
} else if (isShallow) {
  notes.push(
    `跳过版本硬校验：当前为浅克隆（tag 数据不完整，本地最新 ${semverTags[0] || "无"} ≠ 远端真值）。` +
    `\n    如需启用该硬门禁，请使用完整克隆（CI 需 fetch-depth: 0）。`
  );
} else {
  notes.push("跳过版本校验（无 version.json 或浅克隆无 tag）");
}

/* ---------- 软提示：跨命名域快照 ---------- */
const wrangler = (() => {
  const abs = resolve(ROOT, "wrangler.toml");
  if (!existsSync(abs)) return null;
  const m = readFileSync(abs, "utf8").match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
})();
const manifestName = readJSON("manifest.json")?.name ?? null;
// 兄弟仓（zhipei）可能不存在（如 CI 只检 Web 仓），缺失则跳过
const siblingAppIds = (() => {
  const cap = readJSON(resolve(ROOT, "..", "zhipei", "capacitor.config.json"));
  const gradlePath = resolve(ROOT, "..", "zhipei", "android", "app", "build.gradle");
  let applicationId = null;
  if (existsSync(gradlePath)) {
    const m = readFileSync(gradlePath, "utf8").match(/applicationId\s+"([^"]+)"/);
    if (m) applicationId = m[1];
  }
  return { appId: cap?.appId ?? null, applicationId };
})();

const snapshot = [
  ["Git 仓库名", repoName || "-"],
  ["package.json name", pkg?.name || "-"],
  ["wrangler 项目名", wrangler || "-"],
  ["manifest 展示名", manifestName || "-"],
  ["capacitor appId", siblingAppIds.appId || "-"],
  ["Android applicationId", siblingAppIds.applicationId || "-"],
];

/* ---------- 输出 ---------- */
if (notes.length) notes.forEach(n => console.log("ℹ " + n));
console.log("命名标识符快照（跨命名域，仅对照不判等）：");
snapshot.forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}`));

if (problems.length) {
  console.error("\n✗ 命名一致性护栏未通过：\n");
  problems.forEach(p => console.error("  • " + p + "\n"));
  process.exit(1);
}
console.log("\n✓ 命名一致性护栏：全部通过");
