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

console.log("✅ home.bundle.(js|css) 与源文件一致");
