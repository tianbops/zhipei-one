/**
 * home 页组件化守卫测试（node tests/home-modules.test.mjs）
 * ------------------------------------------------------------------
 * 守护 P1-1c 的拆分结果：
 *  1. home.html 必须按 core → upload-progress → upload-error → upload-sheet
 *     → upload-process → today → back 的顺序加载这 7 个模块（顺序即作用域依赖）。
 *  2. 每个模块职责锚点留在它该在的文件里（拆分没把代码搬错地方）。
 *  3. 七模块「去掉头部注释后顺序拼接」仍是合法 JS（node --check），证明纯文本切分无语法裂痕。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const ORDER = ["core","upload-progress","upload-error","upload-sheet","upload-process","today","back"];

let pass = 0, fail = 0;
const fails = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };

// 1) home.html 加载合并后的 home.bundle.js（P1-1c 七模块经 a4a26d96 合并入 bundle，源文件仍各自存在）
const html = readFileSync(root + "home.html", "utf8");
t("home.html 引入合并后的 home.bundle.js", html.includes("/js/home.bundle.js?v="));
const seq = [...html.matchAll(/<script src="(\/js\/home\/([\w-]+)\.js)\?v=[a-f0-9]+"><\/script>/g)]
  .map(m => m[2]);
console.log("home.html 独立 home 模块脚本：" + (seq.length ? seq.join(" → ") : "(已合并入 home.bundle.js)"));

// 2) 职责锚点位置
const read = f => readFileSync(root + f, "utf8");
const core = read("js/home/core.js");
const progress = read("js/home/upload-progress.js");
const error = read("js/home/upload-error.js");
const sheet = read("js/home/upload-sheet.js");
const uploadProcess = read("js/home/upload-process.js");
const today = read("js/home/today.js");
const back = read("js/home/back.js");

t("core: 共享 $ 与线路状态", /const \$\s*=/.test(core) && /let dispatchRouteId/.test(core) && /renderSubstituteBadge/.test(core));
t("upload-progress: 等待期体验", /refreshStalledState/.test(progress) && /animateProcessingProgress/.test(progress));
t("upload-error: 重试映射切片锚点", error.includes("/* [RETRY-MAP-START]") && error.includes("[RETRY-MAP-END] */"));
t("upload-error: 错误面板与处理面板切换", /showProcessingError/.test(error) && /showProcessingUI/.test(error));
t("upload-sheet: 上传弹窗交互", /function closeUpload\(/.test(sheet) && /function openUpload\(/.test(sheet));
t("upload-process: SSE 主流程", /async function processSelectedFiles/.test(uploadProcess) && /ensureDispatchRoute/.test(uploadProcess));
t("today: 三层数据源 + loadHome 自启", /const sharedPromise\s*=/.test(today) && /async function loadHome\(/.test(today) && /loadHome\(\);/.test(today));
t("back: 返回钩子注册", /zpBackHooks/.test(back) && /probe:\s*\(\)\s*=>\s*\$\("uploadArea"\)/.test(back));
t("重试映射锚点只在 upload-error（未误留别处）",
  !core.includes("[RETRY-MAP-START]") && !progress.includes("[RETRY-MAP-START]") &&
  !sheet.includes("[RETRY-MAP-START]") && !uploadProcess.includes("[RETRY-MAP-START]") &&
  !today.includes("[RETRY-MAP-START]") && !back.includes("[RETRY-MAP-START]") && !uploadProcess.includes("[RETRY-MAP-START]"));

// 3) 拼接合法性：去掉首部 /* ... */ 注释块后顺序拼接，node --check
const stripHeader = s => {
  const m = s.match(/^\/\*[\s\S]*?\*\//);
  return (m ? s.slice(m[0].length) : s).replace(/^\n/, "");
};
const joined = ORDER.map(n => stripHeader(read(`js/home/${n}.js`))).join("\n");
let syntaxOk = false;
try {
  const tmp = root + "tests/.home-concat.tmp.js";
  writeFileSync(tmp, joined);
  execFileSync("node", ["--check", tmp]);
  unlinkSync(tmp);
  syntaxOk = true;
} catch (e) {
  if (existsSync(root + "tests/.home-concat.tmp.js")) unlinkSync(root + "tests/.home-concat.tmp.js");
  console.error(e.stdout?.toString() || e.stderr?.toString() || e.message);
}
t("七模块拼接后仍是合法 JS（node --check）", syntaxOk);

console.log(`\nhome 模块守卫：${pass} 通过 / ${fail} 失败`);
if (fail) { for (const f of fails) console.log("  ✗ " + f); process.exit(1); }
console.log("✅ 全部通过");
