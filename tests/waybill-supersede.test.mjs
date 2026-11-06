/* 同日同线路「重复上传合并」回归测试（2026-11-06 规则收紧后）
   ------------------------------------------------------------------
   业务定调：只要有一处不一致，就判定为不同运单，两单并存。
   只有「门店集合完全相同 + 总重量按 kg 相同 + 车牌不冲突」才判为重复上传。

   本测试锁住两件事：
   1. 真实事故不再发生——同车同日、22 家 1.150887t 与 21 家 1.070565t 必须并存；
   2. 完全一致的上传仍能被合并（兜底 dedupe 失效的场景）。
   另含静态守卫：process.js 只在「新建成功」分支触发，且脚本原子标记 + 移出索引。
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  storeNameSet, sameStoreSet, weightKg, isIdenticalContent,
  sameVehicle, vehiclePlate, pickSupersededCandidates,
} from "../functions/api/waybills/_process-supersede.js";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");

const mkStores = (names) => names.map((n) => ({ name: n, rawName: n }));

const ROUTE = "route_63d11499d8f845e78221628bac1a6630";
const DATE = "2026-11-06";
const VEH = "渝DK7692";

/* 2026-11-06 线上真实两张单（第 1 次截图录入 / 第 2 次粘贴录入） */
const FIRST = [
  "渝北A02230谊品生鲜温馨家园南门店",
  "特渠部重庆市卫生健康委员会（临时）",
  "到家主城-江北区鸿恩寺客服中心(2026)",
  "到家主城-江北区加州客服中心(2026)",
  "江北亿达鲜观府国际店(客百年)",
  "江北亿达鲜半山华府店（客百年）",
  "江北重庆三峡融资担保集团有限公司",
  "天友加盟农垦大厦店",
  "江北JM03115-谊品生鲜重庆御龙天峰店",
  "天友24h重庆海浚酒店管理有限公司",
  "天友加盟韩志贤加盟重庆彭成商贸有限公司",
  "Ⅱ类天友生活花卉东路店",
  "特渠部重庆市卫生健康委员会",
  "江北JM03022谊品生鲜重庆北国风光店",
  "渝北中景隆（重庆）贸易有限公司",
  "渝北钱大妈重庆东和春天店",
  "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)",
  "江北胡汪洋经销商（重庆胡建镜好食品有限公司）",
  "江北沁园Q642绿地海外滩米拉公馆店",
  "江北A02175谊品生鲜锦绣北滨路店",
  "江北钱大妈半山华府店",
  "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
];
/* 第 2 次：少「松石支路二店」，「胡汪洋」写成「汪洋」 */
const SECOND = FIRST.slice(0, 21).map((n) => n.replace("江北胡汪洋经销商", "江北汪洋经销商"));

const firstOrder = { id: "W-FIRST", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", totalWeight: 1.150887, stores: mkStores(FIRST) };
const secondOrder = { id: "W-SECOND", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", totalWeight: 1.070565, stores: mkStores(SECOND) };

/* ============ 1. 门店集合「完全相同」口径 ============ */
{
  const A = storeNameSet(firstOrder);
  assert.equal(A.size, 22, `第 1 单应有 22 家，实际 ${A.size}`);
  assert.equal(sameStoreSet(A, A), true, "同一集合应判为完全相同");
  assert.equal(sameStoreSet(A, storeNameSet(firstOrder)), true, "顺序不同不影响判定");

  // 归一化：断行空格、全角半角、罗马数字差异视为同一门店
  const a = storeNameSet({ stores: [{ name: "II类天友生活花 卉东路店" }] });
  const b = storeNameSet({ stores: [{ name: "Ⅱ类天友生活花卉东路店" }] });
  assert.equal(sameStoreSet(a, b), true, "断行空格与罗马数字应归一化为同一门店");

  assert.equal(sameStoreSet(A, storeNameSet(secondOrder)), false, "少一家即不完全相同");
  assert.equal(sameStoreSet(A, storeNameSet({ stores: mkStores(FIRST.slice(0, 5)) })), false, "残单不是完全相同");
  assert.equal(sameStoreSet(new Set(), new Set()), false, "空集合不算相同");
  console.log("✅ 门店集合口径：仅完全一致才算相同（少一家 / 多一家 / 空集合均不算）");
}

/* ============ 2. 重量口径（按 kg） ============ */
{
  assert.equal(weightKg({ totalWeight: 1.150887 }), 1151, "1.150887t 应折算为 1151kg");
  assert.equal(weightKg({ totalWeight: 1.070565 }), 1071, "1.070565t 应折算为 1071kg");
  assert.equal(weightKg({}), null, "缺失重量应为 null");
  assert.equal(isIdenticalContent({ stores: mkStores(FIRST), totalWeight: 1.150887 }, { stores: mkStores(FIRST), totalWeight: 1.15088 }), true,
    "OCR 末位抖动（0.000007t）仍算一致");
  assert.equal(isIdenticalContent({ stores: mkStores(FIRST), totalWeight: 1.150887 }, { stores: mkStores(FIRST), totalWeight: 1.1500 }), false,
    "差 1kg 即不算一致");
  console.log("✅ 重量口径：按 kg 比较，只容忍 OCR 末位抖动");
}

/* ============ 3. 真实事故：两单必须并存 ============ */
{
  const picked = pickSupersededCandidates(secondOrder, [firstOrder]);
  assert.equal(picked.length, 0, "22 家 1.150887t 与 21 家 1.070565t 必须并存（不得替换）");

  // 反向（先传第 2 次、后传第 1 次）同样不得替换
  assert.equal(pickSupersededCandidates(firstOrder, [secondOrder]).length, 0, "反向顺序也不得替换");

  // 只差重量：门店完全相同、重量差 0.08t → 仍是两单（同车两批货）
  const sameStoresOtherWeight = { ...firstOrder, id: "W-THIRD", totalWeight: 1.070565 };
  assert.equal(pickSupersededCandidates(sameStoresOtherWeight, [firstOrder]).length, 0, "门店相同但重量不同 → 不同运单");

  // 只差一家：门店 22 vs 21、重量相同 → 仍是两单
  const sameWeightFewer = { ...secondOrder, id: "W-FOURTH", totalWeight: 1.150887 };
  assert.equal(pickSupersededCandidates(sameWeightFewer, [firstOrder]).length, 0, "重量相同但少一家 → 不同运单");

  // 同数量但换了一家（替换而非增删）→ 不同运单
  const swapped = FIRST.slice(0, 21).concat(["另一家完全不同的门店"]);
  assert.equal(pickSupersededCandidates({ ...firstOrder, id: "W-FIFTH", stores: mkStores(swapped) }, [firstOrder]).length, 0,
    "同数量但换了一家 → 不同运单");
  console.log("✅ 真实事故已锁死：门店差异 / 重量差异 任一存在即两单并存");
}

/* ============ 4. 完全一致仍可合并（兜底 dedupe） ============ */
{
  const same = { ...firstOrder, id: "W-SAME" };
  const picked = pickSupersededCandidates(same, [firstOrder]);
  assert.equal(picked.length, 1, "门店与重量完全一致应被合并");
  assert.equal(picked[0].id, "W-FIRST");
  assert.equal(picked[0].overlap, 1, "完全一致覆盖率恒为 1");

  const duplicated = [firstOrder, { ...firstOrder, id: "W-DUP2" }, secondOrder];
  assert.equal(pickSupersededCandidates(same, duplicated).length, 2, "多张完全重复的单应全部合并");

  // 车牌缺失（粘贴文本）不影响「完全一致」判定
  assert.equal(pickSupersededCandidates({ ...same, vehicle: null }, [{ ...firstOrder, vehicle: null }]).length, 1,
    "车牌缺失时，内容完全一致仍应合并");
  console.log("✅ 内容完全一致仍能合并（含多张、含车牌缺失）");
}

/* ============ 5. 绝不取代的安全边界 ============ */
{
  const base = { ...firstOrder, id: "OLDX" };
  const otherTrip = { ...firstOrder, id: "OLDT", stores: mkStores(["完全不同的门店甲", "完全不同的门店乙"]) };
  assert.equal(pickSupersededCandidates(firstOrder, [otherTrip]).length, 0, "同车第二趟（不同门店）不得取代");

  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, vehicle: "渝A00001" }]).length, 0, "不同车辆不得取代");
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, date: "2026-11-05" }]).length, 0, "不同日期不得取代");
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, routeId: "route_other" }]).length, 0, "不同线路不得取代");
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, historyStatus: "SUPERSEDED" }]).length, 0, "已取代的单不重复处理");
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, stage: "DRAFT" }]).length, 0, "不可读阶段不得取代");
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, id: firstOrder.id }]).length, 0, "不得取代自己");

  // 车牌被 OCR 污染（"北JM03022"）时不得据此排除
  assert.equal(pickSupersededCandidates(firstOrder, [{ ...base, vehicle: "北JM03022" }]).length, 1,
    "车牌被 OCR 污染时不得据此排除，内容一致仍应合并");

  assert.equal(sameVehicle({ vehicle: VEH }, { vehicle: VEH.toLowerCase() }), true, "车辆比较应归一化");
  assert.equal(vehiclePlate("北JM03022"), "", "非省份简称开头不是可信车牌");
  assert.equal(vehiclePlate("渝DK7692"), "渝DK7692", "标准车牌应能识别");
  assert.equal(vehiclePlate("车辆 渝DK7692"), "渝DK7692", "带前缀文字仍能提取车牌");
  assert.equal(sameVehicle({ vehicle: null }, { vehicle: null }), true, "双方缺失时不据车牌排除");
  console.log("✅ 安全边界全部守住（第二趟 / 异车 / 异日 / 异线路 / 已取代 / 阶段不符 / 自己）");
}

/* ============ 6. 静态守卫：接入点与原子动作 ============ */
{
  const proc = read("functions/api/waybills/process.js");
  const mod = read("functions/api/waybills/_process-supersede.js");

  // 必须在「新建成功」分支里触发（而不是去重命中/idempotent 分支）
  const newBranch = proc.slice(proc.indexOf('if(reason==="NEW")'));
  assert.ok(newBranch.slice(0, 700).includes("supersedeSameDay"), "必须在 reason===\"NEW\" 分支内触发合并");

  // 必须在重算汇总之前（否则被合并的单仍计入当日统计）
  const idxSuper = proc.indexOf("supersedeSameDay(env,order,indexKey)");
  const idxMeta = proc.indexOf('await touchMeta(); markSaveStage("saveDayMetaMs"');
  assert.ok(idxSuper > 0 && idxMeta > idxSuper, "合并必须发生在重算当日汇总之前");

  // 原子脚本：标记状态 + 移出索引 + 清理去重/指纹键
  assert.ok(/historyStatus\s*=\s*"SUPERSEDED"/.test(mod), "脚本必须写入 historyStatus=SUPERSEDED");
  assert.ok(/redis\.call\("SREM"/.test(mod), "脚本必须把旧单移出历史索引（避免统计重复）");
  assert.ok(/zp:waybill:dedupe:/.test(mod), "应清理指向旧单的当日去重键");
  assert.ok(/zp:waybill:fingerprint:/.test(mod), "应清理指向旧单的内容指纹键");
  assert.ok(/supersededBy/.test(mod) && /supersededAt/.test(mod) && /supersededReason/.test(mod), "必须留痕（谁取代的/何时/原因）");
  assert.ok(/REUPLOAD_IDENTICAL/.test(mod), "取代原因应标明「仅内容完全一致」");

  // 规则守卫：不得再出现覆盖率/子集判据（一处不一致即不同运单）
  assert.ok(!/storeCoverage|SUPERSEDE_THRESHOLD|SUPERSEDE_COVERAGE/.test(mod), "不得保留覆盖率/阈值判定（已改为完全一致）");

  // 预算保护：读取失败时跳过合并，不影响保存
  assert.ok(/read\.complete/.test(proc), "批量读取应受预算保护");
  assert.ok(/catch\{return\[\]\}/.test(proc), "合并异常不得影响主流程");

  // 根因守卫：mgetBatchMap 必须传「完整 Redis 键」（zp:waybill: 前缀）。
  assert.ok(proc.includes('mgetBatchMap(env,ids.map(id=>"zp:waybill:"+id)'), "合并读取必须补 zp:waybill: 前缀");
  assert.ok(!proc.includes('mgetBatchMap(env,ids,budget'), "process.js 不得再以裸 id 调 mgetBatchMap");
  console.log("✅ 接入点、原子性、留痕、规则收紧与键前缀齐备");
}

console.log("\n✅ waybill-supersede 全部通过");
