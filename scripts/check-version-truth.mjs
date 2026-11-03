#!/usr/bin/env node
/**
 * 版本真值守卫（scripts/check-version-truth.mjs）
 * ------------------------------------------------------------------
 * 背景（2026-11-03 总控体检 P0-1）：tag 是唯一版本真值，但「仓库文件」会悄悄落后。
 * 实测 v1.0.29 发布时：
 *   - git tag            = v1.0.29
 *   - version.json       = 1.0.29
 *   - downloads/manifest = 1.0.29
 *   - android/build.gradle = 1.0.22   ← 落后 7 个补丁版本，无人发现
 * 原因是发版工作流在构建时用 sed 临时改写 build.gradle、改完不提交；`check:naming`
 * 只校验 package.json 与 version.json，不读 build.gradle。
 *
 * 本脚本只读，把「四个产物是否指向同一个版本」变成一条可重复的红/绿：
 *   1) git tag（可用 --tag 覆盖，便于测试）
 *   2) version.json
 *   3) downloads/manifest.json（版本号 + 文件名含版本号 + size > 0）
 *   4) 可选：Android build.gradle 的 versionName / versionCode
 *
 * 为什么第 4 项默认只告警：main 分支要求 PR（branch protection），发版又在 tag 上跑，
 * 没有任何合规路径能把构建期的 sed 结果自动提交回 main；若设为硬失败，v1.0.30 之后
 * 每个 PR 都会红。故默认 warning，`--strict-android` 供发版前人工把关时使用。
 *
 * 用法：
 *   node scripts/check-version-truth.mjs
 *   node scripts/check-version-truth.mjs --root <dir> --tag v1.2.3
 *   node scripts/check-version-truth.mjs --android ../zhipei/android/app/build.gradle --strict-android
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

/* ---------- 参数 ---------- */
function argv(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const ROOT = resolve(argv("--root", process.cwd()));
const FORCED_TAG = argv("--tag");
const ANDROID_GRADLE = argv("--android");
const STRICT_ANDROID = has("--strict-android");

/* ---------- 结果收集 ---------- */
const errors = [];
const warnings = [];
const passed = [];
const ok = (m) => passed.push(m);
const bad = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* ---------- 工具 ---------- */
function readJSON(rel) {
  const p = join(ROOT, rel);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    bad(`${rel} 读取/解析失败：${e.message}`);
    return null;
  }
}

function semverParts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).replace(/^v/, "").split(/[-+]/)[0]);
  return m ? m.slice(1).map(Number) : null;
}

function latestTag() {
  if (FORCED_TAG) return FORCED_TAG;
  try {
    const out = execFileSync("git", ["tag", "--list", "v*.*.*"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tags = out
      .split("\n")
      .map((s) => s.trim())
      .filter((t) => semverParts(t));
    if (!tags.length) return null;
    tags.sort((a, b) => {
      const x = semverParts(a);
      const y = semverParts(b);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
      return 0;
    });
    return tags[tags.length - 1];
  } catch {
    return null;
  }
}

/* ---------- 1. tag ---------- */
const tag = latestTag();
if (!tag) {
  bad(
    FORCED_TAG
      ? `--tag 不是合法语义化版本：${FORCED_TAG}`
      : "取不到最新语义化 tag（浅克隆缺 tag 时请在 CI 用 fetch-depth: 0，或本地 git fetch --tags）"
  );
} else if (!semverParts(tag)) {
  bad(`最新 tag 不是 vX.Y.Z 形式：${tag}`);
} else {
  ok(`真值 tag = ${tag}`);
}
const VER = tag ? String(tag).replace(/^v/, "") : null;

/* ---------- 2 & 3. 公开真值 ---------- */
const versionJson = readJSON("version.json");
const manifest = readJSON("downloads/manifest.json");

if (versionJson && VER) {
  if (versionJson.version === VER) ok(`version.json = ${VER}`);
  else bad(`version.json 版本 ${versionJson.version} ≠ tag ${VER}`);
  if (!versionJson.updated) warn("version.json 缺 updated 字段");
}

if (manifest && VER) {
  if (manifest.version === VER) ok(`downloads/manifest.json 版本 = ${VER}`);
  else bad(`downloads/manifest.json 版本 ${manifest.version} ≠ tag ${VER}`);

  const file = String(manifest.file || "");
  if (!/\.apk$/i.test(file)) bad(`manifest.file 不是 .apk：${file || "(空)"}`);
  else if (!file.includes(VER)) bad(`manifest.file 未带版本号：${file}（应含 ${VER}，否则同名包会被系统当成上次的下载）`);
  else ok(`manifest.file = ${file}`);

  if (!(Number(manifest.size) > 0)) bad(`manifest.size 非法：${manifest.size}`);
  else ok(`manifest.size = ${Number(manifest.size)} B`);
}

/* ---------- 4. Android 构建期占位（默认告警） ---------- */
if (ANDROID_GRADLE) {
  const p = resolve(ANDROID_GRADLE);
  let src = "";
  try {
    src = readFileSync(p, "utf8");
  } catch (e) {
    bad(`build.gradle 读取失败：${e.message}`);
  }
  if (src && VER) {
    const name = /versionName\s+"([^"]+)"/.exec(src)?.[1] || "";
    const code = Number(/versionCode\s+(\d+)/.exec(src)?.[1] || 0);
    const expectCode = VER.split(".").reduce((acc, n, i) => acc + Number(n) * (i === 0 ? 10000 : i === 1 ? 100 : 1), 0);
    const msg = `build.gradle = ${name || "(空)"}/${code}，tag = ${VER}/${expectCode}`;
    if (name === VER && code === expectCode) {
      ok(`Android ${msg}`);
    } else if (STRICT_ANDROID) {
      bad(`Android ${msg}（发版前必须对齐；CI 会在构建时注入，但仓库文件不会自动回写）`);
    } else {
      warn(
        `Android ${msg} —— 构建期由 android.yml 用 sed 注入，仓库文件不自动回写；` +
          `发版前请跑 scripts/sync-version.sh 并提交`
      );
    }
  }
}

/* ---------- 输出 ---------- */
for (const m of passed) console.log(`  ✓ ${m}`);
for (const m of warnings) console.log(`  ! ${m}`);
for (const m of errors) console.error(`  ✗ ${m}`);

if (errors.length) {
  console.error(`\n✗ 版本真值不一致：${passed.length} 通过 / ${warnings.length} 告警 / ${errors.length} 失败`);
  process.exit(1);
}
console.log(`\n✓ 版本真值一致：${passed.length} 通过${warnings.length ? ` / ${warnings.length} 告警` : ""}`);
