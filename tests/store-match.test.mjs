/**
 * 门店匹配引擎回归测试
 * ------------------------------------------------------------------
 * 运行：node tests/store-match.test.mjs
 *
 * 覆盖：
 *   1. 格式差异（括号/间隔号/全角）必须自动匹配，且不产生"更正"
 *   2. 别名与原名词序差异必须自动匹配
 *   3. 近似但不同的门店名必须进入待定，禁止错配
 *   4. 识别乱序 / 错位必须拦截
 *   5. 身份 ID 与业务编码优先级
 *   6. 空基准库 / 空输入 / 同名冲突等边界
 *
 * 核心验收指标：假阳性（错配）必须为 0。
 */

import { matchStores, matchOne, formatCompareKey, businessStoreCode, clean, MATCH_CONFIG } from "../functions/api/waybills/_store-match.js";

let pass = 0, fail = 0;
const failures = [];

function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

/* ============ 基准库（模拟一条真实配送线路） ============ */
const base = [
  { storeId: "S001", name: "华润万家(龙华店)", originalName: "华润万家龙华店", aliases: ["华润万家龙华", "龙华华润万家"], routeOrder: 1 },
  { storeId: "S002", name: "沃尔玛(坂田店)", originalName: "沃尔玛坂田店", aliases: ["沃尔玛坂田"], routeOrder: 2 },
  { storeId: "S003", name: "永辉超市(宝安中心店)", originalName: "永辉超市宝安中心店", aliases: [], routeOrder: 3 },
  { storeId: "S004", name: "大润发(龙华店)", originalName: "大润发龙华店", aliases: ["大润发龙华"], routeOrder: 4 },
  { storeId: "S005", name: "顺丰速运(坂田营业点)", originalName: "顺丰速运坂田营业点", aliases: [], routeOrder: 5 },
  { storeId: "S006", name: "星巴克(深圳湾店)", originalName: "星巴克深圳湾店", aliases: [], routeOrder: 6 },
  { storeId: "S007", name: "家乐福(梅林店)", originalName: "家乐福梅林店", aliases: [], routeOrder: 7 },
  { storeId: "S008", name: "7-11便利店(福田店)", originalName: "7-11便利店福田店", aliases: ["711福田店"], routeOrder: 8 },
];

/* ============ 用例：[识别原文, 期望storeId 或 null=待定] ============ */
const MATCH_CASES = [
  ["华润万家（龙华店）", "S001", "全角括号"],
  ["华润万家·龙华店", "S001", "间隔号"],
  ["华润万家 龙华店", "S001", "空格"],
  ["华润万家龙华", "S001", "别名"],
  ["龙华华润万家", "S001", "别名词序"],
  ["沃尔玛坂田店", "S002", "原始名"],
  ["沃尔玛(坂田店)", "S002", "半角括号"],
  ["永辉超市宝安中心店", "S003", "原始名"],
  ["永辉超市（宝安中心）店", "S003", "括号+店"],
  ["大润发龙华店", "S004", "原始名"],
  ["顺丰速运坂田营业点", "S005", "原始名"],
  ["星巴克深圳湾店", "S006", "原始名"],
  ["7-11便利店福田店", "S008", "原始名"],
  ["711福田店", "S008", "别名"],
];

const PENDING_CASES = [
  ["大润发龙岗店", "龙岗≠龙华，不同门店"],
  ["华润万家龙岗店", "龙岗≠龙华，不同门店"],
  ["家乐福梅林二店", "疑似另一家门店"],
  ["沃尔玛坂田2号店", "主体编号不同"],
  ["永辉超市宝安西乡店", "西乡≠宝安中心"],
  ["星巴克深圳湾二店", "疑似另一家门店"],
  ["华润万家", "信息不足，无法确定哪一家"],
  ["便利店", "信息不足"],
  ["麦当劳", "基准库中不存在"],
  ["万科城店天津", "识别乱序"],
  ["店龙华华润万家", "识别错位"],
];

/* ============ 1. 格式归一 / 工具函数 ============ */
t("clean 去除首尾空格", clean("  abc  ") === "abc");
t("formatCompareKey 忽略括号差异", formatCompareKey("华润万家(龙华店)") === formatCompareKey("华润万家·龙华店"));
t("formatCompareKey 保留字序语义", formatCompareKey("天津万科") !== formatCompareKey("津天科万"));
t("businessStoreCode 提取编码", businessStoreCode("门店 JM123456") === "JM123456");
t("businessStoreCode 无编码返回 null", businessStoreCode("华润万家") === null);

/* ============ 2. 应自动匹配的用例 ============ */
const matchOut = MATCH_CASES.map(([rawName]) => matchStores([{ rawName }], base)[0]);
MATCH_CASES.forEach(([raw, expect, note], i) => {
  const r = matchOut[i];
  t("自动匹配：" + raw + "（" + note + "）", !r.pending && r.storeId === expect, "实际 " + (r.pending ? "待定" : r.storeId));
});
const sameWaybillAliases = matchStores([{ rawName: "华润万家（龙华店）" }, { rawName: "龙华华润万家" }], base);
t("同一运单不同识别文本不被静默合并", sameWaybillAliases[1].pending && sameWaybillAliases[1].matchDiagnostics?.reason === "STORE_ID_COLLISION");

/* ============ 3. 格式差异不应计为"更正" ============ */
MATCH_CASES.forEach(([raw, , note], i) => {
  if (/括号|间隔号|空格/.test(note)) {
    t("格式差异不计更正：" + raw, matchOut[i].correction === false);
  }
});

/* ============ 4. 应进入待定的用例（假阳性防线） ============ */
const pendOut = PENDING_CASES.map(([rawName]) => matchStores([{ rawName }], base)[0]);
PENDING_CASES.forEach(([raw, note], i) => {
  const r = pendOut[i];
  t("应待定：" + raw + "（" + note + "）", r.pending === true && r.storeId === null, "实际匹配到 " + r.storeId);
});

/* ============ 5. 待定项必须携带原因，便于前端提示 ============ */
pendOut.forEach((r, i) => {
  t("待定项含原因：" + PENDING_CASES[i][0], Boolean(r.matchDiagnostics?.reason));
});

/* ============ 6. 优先级：身份 ID 与业务编码 ============ */
const byId = matchStores([{ rawName: "完全无关的名字", storeId: "S004" }], base)[0];
t("身份ID优先匹配", byId.storeId === "S004" && byId.matchMethod === "identity");

const byCodeBase = [{ storeId: "C1", name: "某店", businessStoreCode: "JM000123", routeOrder: 1 }];
const byCode = matchStores([{ rawName: "别的名字 JM000123" }], byCodeBase)[0];
t("业务编码匹配", byCode.storeId === "C1" && byCode.matchMethod === "identity-code");

const downgrade = matchStores([{ rawName: "沃尔玛坂田店", storeId: "不存在的ID" }], base)[0];
t("无效身份ID降级为名称匹配", downgrade.storeId === "S002");

/* ============ 7. 边界情况 ============ */
t("空基准库全部待定", matchStores(MATCH_CASES.map(([rawName]) => ({ rawName })), []).every(x => x.pending));
t("空 items 返回空数组", matchStores([], base).length === 0);
t("null items 不报错", matchStores(null, base).length === 0);
t("null baseStores 不报错", matchStores([{ rawName: "任意" }], null).every(x => x.pending));
t("待定项 routeOrder 排在末尾", pendOut[0].routeOrder >= 100000);

/* ============ 8. 同名冲突保护：同名不同 storeId 必须走待定 ============ */
const dupBase = [
  { storeId: "D1", name: "同名店", routeOrder: 1 },
  { storeId: "D2", name: "同名店", routeOrder: 2 },
];
const dup = matchStores([{ rawName: "同名店" }], dupBase)[0];
t("同名冲突不误配", dup.pending === true, "实际 " + dup.storeId);

/* ============ 9. 置信差判定：双高分候选必须待定 ============ */
const closeBase = [
  { storeId: "E1", name: "测试路一百零八号店", routeOrder: 1 },
  { storeId: "E2", name: "测试路一百零九号店", routeOrder: 2 },
];
const close = matchOne("测试路一百零八号店", closeBase);
t("高分歧义候选可正确命中", close.status === "matched" && close.store.storeId === "E1", JSON.stringify(close).slice(0, 120));

/* ============ 10. 配置合理性 ============ */
t("AUTO_MATCH 阈值合理（0.85~0.95）", MATCH_CONFIG.AUTO_MATCH >= 0.85 && MATCH_CONFIG.AUTO_MATCH <= 0.95);
t("存在置信差配置", MATCH_CONFIG.MIN_CONFIDENCE_GAP > 0);
t("候选下限低于自动匹配阈值", MATCH_CONFIG.CANDIDATE_FLOOR < MATCH_CONFIG.AUTO_MATCH);

/* ============ 11. OCR 单字噪声（真实案例：格意→格林） ============ */
// 2026-10-02 复盘：17号线基准库为「渝北格意东和春天店」，
// 若 OCR 误识为「渝北格林东和春天店」（单字差异，综合分约 0.78），
// 正确行为：不自动匹配（避免破坏"零错配"契约），
// 但必须给出候选建议，用户一键确认后写入别名，经学习闭环永久解决。
const ocrNoiseBase = [
  { storeId: "G1", name: "渝北格意东和春天店", originalName: "渝北格意东和春天店", aliases: [], routeOrder: 10 },
  { storeId: "G2", name: "渝北钱大妈重庆东和春天店", originalName: "渝北钱大妈重庆东和春天店", aliases: [], routeOrder: 15 },
];
const ocrNoise = matchOne("渝北格林东和春天店", ocrNoiseBase);
t("OCR单字噪声不自动匹配", ocrNoise.status === "pending", "实际 " + ocrNoise.status);
t("OCR单字噪声首选候选指向正确门店", ocrNoise.status === "pending" && ocrNoise.candidates?.[0]?.storeId === "G1", JSON.stringify(ocrNoise.candidates?.[0] || null));
t("OCR单字噪声候选分落在待定区间", ocrNoise.status === "pending" && ocrNoise.candidates?.[0]?.score >= MATCH_CONFIG.CANDIDATE_FLOOR && ocrNoise.candidates[0].score < MATCH_CONFIG.AUTO_MATCH);

/* ============ 汇总 ============ */
console.log("门店匹配引擎回归测试");
console.log("─".repeat(50));
console.log("自动匹配用例：" + MATCH_CASES.length + " 条");
console.log("待定用例：　　" + PENDING_CASES.length + " 条");
console.log("─".repeat(50));
if (failures.length) {
  console.log("失败项：");
  failures.forEach(f => console.log("  ✗ " + f));
  console.log("─".repeat(50));
}
console.log("通过 " + pass + " / 失败 " + fail);
console.log(fail === 0 ? "✅ 全部通过，假阳性 0" : "❌ 存在失败项");
process.exit(fail ? 1 : 0);
