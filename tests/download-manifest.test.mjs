/* 下载包命名约束（2026-10-30）。
 *
 * 事故：用户点了「更新到 V1.0.19」，装完仍是 V1.0.18，系统还提示
 * 「已安装相同版本 智配One(1.0.18)」。
 *
 * 根因不在服务端——线上 /downloads/*.apk 的 versionCode 实测就是 10019；
 * 在于安装包用固定文件名 zhipei-one-latest-release.apk：
 *   - 系统下载器按 URL 末段起名，目标路径每次都一样，下载目录里躺着上次的 1.0.18
 *   - 通知栏里两条同名下载，点哪条全靠运气
 *   - 文件名不带版本，用户也没法分辨
 * 于是「新包下好了」和「装的是旧包」同时成立。
 *
 * 约束：文件名必须带版本号，manifest.file 必须与之一致，且磁盘上真有这个文件。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ✅ " + name + (detail ? `  [${detail}]` : "")); }
  else { fail++; console.log("  ❌ " + name + (detail ? `  [${detail}]` : "")); }
};

const manifest = JSON.parse(fs.readFileSync(path.join(root, "downloads/manifest.json"), "utf8"));
const account = fs.readFileSync(path.join(root, "pages/account.html"), "utf8");

console.log("一、清单与磁盘一致");
t("version 是 x.y.z", /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
t("file 带版本号", manifest.file === `zhipei-one-${manifest.version}-release.apk`, manifest.file);
t("file 不再是固定名", !/latest/.test(manifest.file), manifest.file);
t("file 无路径分隔符（只允许同目录）", !/[/\\]/.test(manifest.file), manifest.file);

const apkPath = path.join(root, "downloads", manifest.file);
t("APK 真的存在", fs.existsSync(apkPath), manifest.file);
if (fs.existsSync(apkPath)) {
  const size = fs.statSync(apkPath).size;
  t("size 与清单一致", size === manifest.size, `${size} vs ${manifest.size}`);
}
const apks = fs.readdirSync(path.join(root, "downloads")).filter((f) => f.endsWith(".apk"));
t("目录里只有当前版本一个 APK（旧包必须删掉）", apks.length === 1, apks.join(","));

console.log("\n二、页面不再引用固定名");
t("account.html 无 zhipei-one-latest-release.apk", !account.includes("zhipei-one-latest-release.apk"));
t("account.html 按 manifest.file 拼地址", /"\/downloads\/"\+file/.test(account));
t("链接带 ?v= 版本参数（缓存隔离）", /\?v="\+encodeURIComponent\(ver\)/.test(account));
t("download 属性带版本号", /zhipei-one-"\+\(ver\|\|"latest"\)\+"-release\.apk"/.test(account));

console.log("\n三、更新提示只认「可下载的版本」");
t("原生分支不再用 webVer 当目标版本", !/setAction\("更新到 V"\+state\.webVer/.test(account));
t("原生分支用 apkVer（manifest）", /const target=state\.apkVer;/.test(account));
t("有新版本角标用 apkVer 优先", /const latest=state\.apkVer\|\|state\.webVer;/.test(account));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
