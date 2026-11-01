import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOutputs } from "../scripts/build-home-bundle.mjs";

/* 守卫：js/home.bundle.js 与 css/home.bundle.css 必须与源文件拼接结果逐字节一致。
 * 防止“改了源文件却不重建 bundle → 线上不生效”的漂移（历史上 esc() 就出过源/产物两份）。
 * 不一致时提示运行：node scripts/build-home-bundle.mjs */
const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const { js, css } = buildOutputs();

assert.strictEqual(js, rd("../js/home.bundle.js"),
  "js/home.bundle.js 与源文件不一致：请运行 node scripts/build-home-bundle.mjs");
assert.strictEqual(css, rd("../css/home.bundle.css"),
  "css/home.bundle.css 与源文件不一致：请运行 node scripts/build-home-bundle.mjs");


// 退出保护：请求已发出但 requestId 尚未到达时，必须留在当前页等待服务端状态。
// 只有尚未发出处理请求（例如本地图片压缩阶段）才允许直接本地中止并离开。
const uploadProcess = rd("../js/home/upload-process.js");
assert.match(uploadProcess, /let processingRequestStarted=false;/,
  "缺少处理请求已发出的独立状态");
assert.match(uploadProcess, /if\(processingRequestStarted&&!processingRequestId\)/,
  "requestId 尚未到达时必须阻止退出");
assert.match(uploadProcess, /processingRequestStarted=true;\s*perfRequestStartedAt=/,
  "必须在发出 process fetch 前标记请求已开始");
assert.match(uploadProcess, /processingRequestStarted=false;\s*processingController=null;/,
  "处理结束后必须清理请求开始状态");

console.log("✅ home.bundle.(js|css) 与源文件一致");
