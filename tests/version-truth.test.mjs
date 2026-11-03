/**
 * 版本真值守卫（tests/version-truth.test.mjs）
 * ------------------------------------------------------------
 * 背景（2026-11-03 体检 P0-1）：tag 已是 v1.0.29，仓库 build.gradle 仍写 1.0.22。
 * 这类漂移不会让任何测试变红，只会让「看版本号判断装没装新包」重新变成玄学。
 *
 * 本测试用临时目录造夹具，真跑脚本进程，断言四类结果：
 *   一致 → 0；公开真值漂移 → 1；Android 落后默认告警但仍 0；--strict-android → 1。
 * 不依赖真实 git 历史（用 --tag 注入真值），因此在浅克隆/沙箱里也能跑。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/check-version-truth.mjs");

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

/** 造一份完整夹具；over 可覆盖任意字段 */
function fixture(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zp-ver-"));
  mkdirSync(join(dir, "downloads"), { recursive: true });
  const ver = over.version ?? "1.0.29";
  const manifest = {
    version: over.manifestVersion ?? ver,
    file: over.file ?? `zhipei-one-${ver}-release.apk`,
    size: over.size ?? 3530238,
    updated: "2026-11-03",
  };
  writeFileSync(join(dir, "version.json"), JSON.stringify({ version: ver, updated: "2026-11-03" }));
  writeFileSync(join(dir, "downloads/manifest.json"), JSON.stringify(manifest));
  const gradle = over.gradle ?? `android {\n defaultConfig {\n versionCode 10029\n versionName "1.0.29"\n }\n}`;
  writeFileSync(join(dir, "build.gradle"), gradle);
  return dir;
}

function run(dir, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--root", dir, "--tag", "v1.0.29", ...extraArgs],
    { encoding: "utf8" }
  );
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/* ===== 1. 四向一致：唯一应该绿的路径 ===== */
{
  const dir = fixture();
  const r = run(dir, ["--android", join(dir, "build.gradle"), "--strict-android"]);
  t("四向一致 → exit 0", r.code === 0, `exit=${r.code}`);
  t("四向一致 → 输出「版本真值一致」", /版本真值一致/.test(r.out), r.out.slice(0, 160));
  rmSync(dir, { recursive: true, force: true });
}

/* ===== 2. 公开真值漂移：必须红 ===== */
{
  const dir = fixture({ version: "1.0.28" });
  const r = run(dir);
  t("version.json 落后 → exit 1", r.code === 1, `exit=${r.code}`);
  t("报错点名 version.json 与 tag", /version\.json 版本 1\.0\.28 ≠ tag 1\.0\.29/.test(r.out), r.out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fixture({ manifestVersion: "1.0.27" });
  const r = run(dir);
  t("manifest 版本落后 → exit 1", r.code === 1, `exit=${r.code}`);
  t("报错点名 manifest", /downloads\/manifest\.json 版本 1\.0\.27/.test(r.out), r.out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fixture({ file: "zhipei-one-latest-release.apk" });
  const r = run(dir);
  t("文件名不带版本号 → exit 1", r.code === 1, `exit=${r.code}`);
  t("说明同名包风险", /同名包/.test(r.out), r.out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fixture({ size: 0 });
  const r = run(dir);
  t("size 为 0 → exit 1", r.code === 1, `exit=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

/* ===== 3. Android 构建期占位：默认告警，严格模式才红 ===== */
{
  const dir = fixture({ gradle: `versionCode 10022\nversionName "1.0.22"` });
  const r = run(dir, ["--android", join(dir, "build.gradle")]);
  t("Android 落后 + 默认 → exit 0（不阻断 PR）", r.code === 0, `exit=${r.code}`);
  t("Android 落后 + 默认 → 有告警", /build\.gradle = 1\.0\.22\/10022/.test(r.out), r.out.slice(0, 200));

  const s = run(dir, ["--android", join(dir, "build.gradle"), "--strict-android"]);
  t("Android 落后 + --strict → exit 1", s.code === 1, `exit=${s.code}`);
  t("严格模式提示发版前对齐", /发版前必须对齐/.test(s.out), s.out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

/* ===== 4. 输入本身不合法：不能被当成绿 ===== */
{
  const dir = fixture();
  const r = spawnSync(process.execPath, [SCRIPT, "--root", dir, "--tag", "1.0"], { encoding: "utf8" });
  t("非法 --tag → exit 1", r.status === 1, `exit=${r.status}`);
  rmSync(dir, { recursive: true, force: true });
}

{
  const r = spawnSync(process.execPath, [SCRIPT, "--root", "/nonexistent-zp", "--tag", "v1.0.29"], {
    encoding: "utf8",
  });
  t("根目录不存在 → exit 1（不静默通过）", r.status === 1, `exit=${r.status}`);
}

/* ===== 汇总 ===== */
if (fail) {
  console.error(`✗ version-truth：${pass} 通过 / ${fail} 失败`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ version-truth：${pass}/${pass} 通过`);
