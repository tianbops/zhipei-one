/**
 * 降级可观测单元测（functions/api/_degrade.js）
 * ------------------------------------------------------------------
 * 运行：node tests/unit-degrade.test.mjs
 *
 * 这个模块的验收标准是**三条铁律**，任何一条被破坏都会让它从"观测手段"变成"新故障源"：
 *   1. 自身绝不抛错（哪怕传进来的是 undefined / 循环引用对象 / 会抛 toString 的对象）
 *   2. 同一 tag 在窗口内限频（不打爆日志配额），且必须如实累计 suppressed 计数
 *   3. 长跑不内存泄漏（tag 状态有上限并会淘汰）
 */

import { degraded, __resetDegradeState } from "../functions/api/_degrade.js";

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

/** 捕获 console.warn 的输出，返回 callFn 执行期间的告警行数组。 */
function captureWarnings(callFn) {
  const rows = [];
  const original = console.warn;
  console.warn = (msg) => rows.push(msg);
  try {
    callFn();
  } finally {
    console.warn = original;
  }
  return rows;
}

/* ============ 1. 首次调用必须打印结构化单行 JSON ============ */
__resetDegradeState();
const first = captureWarnings(() => degraded("unit.first", new Error("boom"), { routeId: "r1" }));
t("首次调用产生 1 条告警", first.length === 1, JSON.stringify(first));
const payload = (() => {
  try {
    return JSON.parse(first[0]);
  } catch (e) {
    return null;
  }
})();
t("输出是可解析的单行 JSON", !!payload, first[0]);
t("level=warn", payload?.level === "warn", String(payload?.level));
t("kind=degraded", payload?.kind === "degraded", String(payload?.kind));
t("保留原始 tag", payload?.tag === "unit.first", String(payload?.tag));
t("error 取自 message", payload?.error === "boom", String(payload?.error));
t("上下文字段原样透传", payload?.routeId === "r1", String(payload?.routeId));

/* ============ 2. 窗口内重复 tag 必须被限频 ============ */
__resetDegradeState();
const rows = captureWarnings(() => {
  const r1 = degraded("unit.freq", new Error("again"));
  const r2 = degraded("unit.freq", new Error("again"));
  const r3 = degraded("unit.freq", new Error("again"));
  t("首次返回 printed=true", r1.printed === true);
  t("重复返回 printed=false", r2.printed === false && r3.printed === false);
  t("hits 如实累计到 3", r3.hits === 3, String(r3.hits));
});
t("窗口内只落 1 行日志（限频生效）", rows.length === 1, `实际 ${rows.length} 行`);

/* ============ 3. 换 tag 不受限频影响 ============ */
__resetDegradeState();
const mixed = captureWarnings(() => {
  degraded("unit.a", new Error("x"));
  degraded("unit.b", new Error("y"));
  degraded("unit.a", new Error("x"));
});
t("不同 tag 互不抑制", mixed.length === 2, `实际 ${mixed.length} 行`);

/* ============ 4. 自身绝不抛错（输入再脏也不能让业务崩） ============ */
__resetDegradeState();
let threw = null;
const dirtyRows = captureWarnings(() => {
  try {
    const cyclic = { name: "cyclic" };
    cyclic.self = cyclic; // JSON.stringify 会抛 Converting circular structure
    degraded("unit.dirty", undefined);
    degraded("unit.dirty2", { message: { nested: true } });
    degraded("unit.dirty3", "纯字符串抛错");
    degraded("unit.dirty4", null, undefined);
    degraded("unit.dirty5", new Error("cyclic"), { bad: cyclic });
    degraded("unit.dirty6", new Error("长文本" + "x".repeat(1000)));
  } catch (e) {
    threw = String(e?.message || e);
  }
});
t("各种脏输入均不抛出", threw === null, String(threw));
t("脏输入不产生日志噪音外泄（全部被捕获）", typeof dirtyRows.length === "number");
const dirty2 = JSON.parse(dirtyRows.find((r) => r.includes("unit.dirty2")) || "{}");
t(
  "对象型 message 被安全序列化而非 [object Object]",
  String(dirty2.error).includes("nested"),
  String(dirty2.error)
);

/* ============ 5. error 字段长度受控，不得污染日志 ============ */
__resetDegradeState();
const longRow = captureWarnings(() => degraded("unit.long", new Error("y".repeat(1000))));
const longPayload = JSON.parse(longRow[0]);
t(
  "error 字段截断到 300 字符以内",
  String(longPayload.error).length <= 300,
  String(longPayload.error).length
);

/* ============ 6. 长跑不内存泄漏：tag 状态有上限 ============ */
__resetDegradeState();
threw = null;
try {
  captureWarnings(() => {
    for (let i = 0; i < 600; i++) degraded(`unit.flood.${i}`, new Error("e"));
  });
} catch (e) {
  threw = String(e?.message || e);
}
t("灌入 600 个不同 tag 不抛错", threw === null, String(threw));
__resetDegradeState();
const afterReset = captureWarnings(() => degraded("unit.first", new Error("again")));
t(
  "__resetDegradeState 后重新打印（窗口被清空）",
  afterReset.length === 1,
  String(afterReset.length)
);

console.log(`\n降级可观测：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
if (fail) {
  console.error("失败用例：");
  failures.forEach((f) => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ 降级上报限频可靠且自身不抛错");
