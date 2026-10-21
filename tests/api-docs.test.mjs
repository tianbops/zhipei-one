/**
 * API 契约文档防漂移守卫（P1-5，node tests/api-docs.test.mjs）
 * -----------------------------------------------------------
 * docs/API.md 由 scripts/gen-api-docs.mjs 从 functions/api/*.js 静态生成。
 * 本守卫以 --check 模式重跑生成器，断言已提交的 docs/API.md 与代码一致——
 * 新增/改动端点却漏跑 `npm run docs:api` 时，CI 立刻 fail，防止文档漂移。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "gen-api-docs.mjs");

try {
  const out = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.match(out, /一致/, "生成器 --check 未报告一致");
} catch (e) {
  assert.fail(
    "docs/API.md 与 functions/api 不一致，请运行 npm run docs:api\n" +
      ((e.stdout || "") + (e.stderr || "") + (e.message || ""))
  );
}

console.log("API 契约文档防漂移守卫：通过（docs/API.md 与 functions/api 一致）");
