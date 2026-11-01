/* 同日同线路「重传即替换」回归测试
   ------------------------------------------------------------------
   验证 storeOverlap 的口径与 pickSupersededCandidates 的取舍：
   该取代的取代（重传/补全），不该取代的绝不取代（残单、同车第二趟、
   不同车辆、不同日期/线路、已取代、阶段不符、车辆缺失）。
   另含静态守卫：process.js 只在「新建成功」分支触发，且脚本原子标记 + 移出索引。
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { storeNameSet, storeOverlap, storeCoverage, isSubsetOf, sameVehicle, vehiclePlate, pickSupersededCandidates, SUPERSEDE_THRESHOLD } from "../functions/api/waybills/_process-supersede.js";

const ROOT = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");

const mkStores = (names) => names.map((n) => ({ name: n, rawName: n }));

const ROUTE = "route_63d11499d8f845e78221628bac1a6630";
const DATE = "2026-10-27";
const VEH = "渝DK7692";

const FULL = [
  "江北胡汪洋经销商（重庆胡建镜好食品有限公司）",
  "渝北中景隆(重庆)贸易有限公司",
  "江北重庆三峡融资担保集团有限公司",
  "到家主城-江北区加州客服中心（2026）",
  "到家主城-江北区鸿恩寺客服中心（2026）",
  "特渠部重庆市卫生健康委员会",
  "特渠部重庆市卫生健康委员会（临时）",
  "天友24h重庆海浚酒店管理有限公司",
  "渝北A02230谊品生鲜温馨家园南门店",
  "天友加盟韩志贤加盟重庆彭成商贸有限公司",
  "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)",
  "II类天友生活花卉东路店",
  "江北JM03022谊品生鲜重庆北国风光店",
  "江北亿达鲜半山华府店(客百年)",
  "江北钱大妈半山华府店",
  "江北A02175谊品生鲜锦绣北滨路店",
  "江北Q784华唐立交店",
  "江北亿达鲜御龙天峰(客百年)",
  "江北JM03115 - 谊品生鲜重庆御龙天峰店",
  "江北亿达鲜观府国际店（客百年）",
  "天友加盟农垦大厦店",
  "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
];

const newOrder = { id: "NEW1", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", stores: mkStores(FULL) };

/* ============ 1. 覆盖率 / 重叠度 口径 ============ */
{
  // storeOverlap（参考指标，不作主判定）：交集 / 较大集合
  const A = storeNameSet({ stores: mkStores(FULL) });
  assert.equal(storeOverlap(A, A), 1, "同一门店集合重叠度应为 1");
  const missing = storeNameSet({ stores: mkStores(FULL.slice(0, 18)) }); // 漏拍4家，是新单子集
  const ov = storeOverlap(storeNameSet({ stores: mkStores(FULL) }), missing);
  assert.ok(Math.abs(ov - 18 / 22) < 1e-9, `子集场景 storeOverlap 应为 18/22，实际 ${ov}`);
  const partial = storeNameSet({ stores: mkStores(FULL.slice(0, 5)) });
  const ov2 = storeOverlap(partial, storeNameSet({ stores: mkStores(FULL) }));
  assert.ok(Math.abs(ov2 - 5 / 22) < 1e-9, `残单场景 storeOverlap 应为 5/22，实际 ${ov2}`);
  assert.equal(storeOverlap(new Set(), new Set()), 0, "空集合重叠度应为 0");

  // storeCoverage（主判定指标）：|旧∩新| / |旧|
  assert.equal(storeCoverage(A, A), 1, "完全相同覆盖率应为 1");

  // 旧 15 家（13 真门店 + 2 条 OCR 噪声），新 22 家 → 覆盖 13/15=0.867 → 取代（修复点）
  const oldNoisy = mkStores(FULL.slice(0, 13).concat(["g5g85 06:05", "渝北中"]));
  const cov1 = storeCoverage(storeNameSet({ stores: oldNoisy }), storeNameSet({ stores: mkStores(FULL) }));
  assert.ok(Math.abs(cov1 - 13 / 15) < 1e-9, `带噪声旧单覆盖率应为 13/15，实际 ${cov1}`);
  assert.ok(cov1 >= SUPERSEDE_THRESHOLD, "带噪声旧单应达到覆盖率阈值（这是修复点）");

  // 残单反向：旧 22 全、新 5 家 → 覆盖 5/22=0.227 < 0.7 → 绝不取代
  const cov2 = storeCoverage(storeNameSet({ stores: mkStores(FULL) }), storeNameSet({ stores: mkStores(FULL.slice(0, 5)) }));
  assert.ok(Math.abs(cov2 - 5 / 22) < 1e-9, `残单场景覆盖率应为 5/22，实际 ${cov2}`);
  assert.ok(cov2 < SUPERSEDE_THRESHOLD, "残单（新单只拍一段）覆盖率低，绝不取代");

  assert.equal(storeCoverage(new Set(), new Set()), 0, "空集合覆盖率应为 0");
  console.log("✅ 覆盖率口径正确（分母是旧单；残单不会覆盖全单，带噪声旧单仍被取代）");
}

/* ============ 2. 归一化：标点/空格差异视为同一门店 ============ */
{
  const a = storeNameSet({ stores: [{ name: "II类天友生活花 卉东路店" }] });
  const b = storeNameSet({ stores: [{ name: "II类天友生活花卉东路店" }] });
  assert.equal(storeOverlap(a, b), 1, "断行空格应归一化为同一门店");
  console.log("✅ 归一化后断行空格视为同一门店");
}

/* ============ 3. 该取代的场景 ============ */
{
  const same = { id: "OLD1", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", stores: mkStores(FULL) };
  assert.equal(pickSupersededCandidates(newOrder, [same]).length, 1, "完全重复应被取代");

  const incomplete = { id: "OLD2", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "PLANNED", stores: mkStores(FULL.slice(0, 18)) };
  assert.equal(pickSupersededCandidates(newOrder, [incomplete]).length, 1, "漏拍旧单应被补全的新单取代");

  const multi = pickSupersededCandidates(newOrder, [same, incomplete]);
  assert.equal(multi.length, 2, "多张重复旧单应全部取代");
  assert.ok(multi.every((x) => x.overlap >= SUPERSEDE_THRESHOLD));

  // 先传 5 家（漏拍）→ 再传全 22 家：残单是子集，必须被取代，否则永远留在统计里
  const tinyOld = { id: "OLD3", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", stores: mkStores(FULL.slice(0, 5)) };
  const picked = pickSupersededCandidates(newOrder, [tinyOld]);
  assert.equal(picked.length, 1, "先传残单再传全单时，残单必须被取代");
  assert.equal(picked[0].subset, true, "应标记为子集取代（覆盖率同样为 1.0）");

  // 真实修复点：旧 15 家（13 真门店 + 2 条 OCR 噪声），新 22 家
  // 覆盖率 13/15=0.867 ≥ 0.7 取代；有噪声故非严格子集，靠覆盖率口径命中
  const noisyOld = { id: "OLD4", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "PLANNED",
    stores: mkStores(FULL.slice(0, 13).concat(["g5g85 06:05", "渝北中"])) };
  const picked2 = pickSupersededCandidates(newOrder, [noisyOld]);
  assert.equal(picked2.length, 1, "带噪声的不完整旧单必须被全单取代（修复点）");
  assert.ok(picked2[0].overlap >= SUPERSEDE_THRESHOLD, "该场景覆盖率应达标");
  assert.equal(picked2[0].subset, false, "有噪声故非严格子集，靠覆盖率口径命中");
  console.log("✅ 重传/补全/先残后全/带噪声旧单 均能正确取代（含多张）");
}

/* ============ 4. 绝不取代的场景（安全边界） ============ */
{
  const base = { id: "OLDX", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", stores: mkStores(FULL) };

  const partialOld = {
    id: "OLDP", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED",
    stores: mkStores(FULL.slice(0, 3)),
  };
  assert.equal(
    pickSupersededCandidates({ ...newOrder, stores: mkStores(FULL.slice(0, 3)) }, [base]).length,
    0,
    "残单不能覆盖全单（否则丢门店）"
  );

  // 反向：旧单完整（22），新单只补拍了一小段（3 家）→ 旧单不是新单的子集，
  // 重叠度 3/22=0.14 < 0.6 → 绝不取代（否则丢 19 家门店 → 漏送）
  const partialNew = { id: "NEW2", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED", stores: mkStores(FULL.slice(0, 3)) };
  assert.equal(pickSupersededCandidates(partialNew, [base]).length, 0, "新单是旧单子集时不得取代完整旧单");
  assert.equal(isSubsetOf(storeNameSet(base), storeNameSet(partialNew)), false, "旧单不应被判为残单子集");

  const otherTrip = {
    id: "OLDT", routeId: ROUTE, date: DATE, vehicle: VEH, stage: "CONFIRMED",
    stores: mkStores(["完全不同的门店甲", "完全不同的门店乙", "完全不同的门店丙"]),
  };
  assert.equal(pickSupersededCandidates(newOrder, [otherTrip]).length, 0, "同车第二趟（不同门店）不得取代");

  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, vehicle: "渝A00001" }]).length, 0, "不同车辆不得取代");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, date: "2026-10-26" }]).length, 0, "不同日期不得取代");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, routeId: "route_other" }]).length, 0, "不同线路不得取代");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, historyStatus: "SUPERSEDED" }]).length, 0, "已取代的单不重复处理");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, stage: "DRAFT" }]).length, 0, "不可读阶段不得取代");
  // 不同"有效车牌"才排除；车牌不可信时交给门店集合判定
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, vehicle: "渝A00001" }]).length, 0, "两台不同车（车牌均可信）不得取代");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, vehicle: "北JM03022" }]).length, 1,
    "车牌被 OCR 污染（北JM03022，单图抬头截断所致）时不得据此排除，仍应取代");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, vehicle: null }]).length, 1,
    "车牌缺失但门店集合一致 → 仍应取代（信息不足时不拿车牌当排除依据）");
  assert.equal(pickSupersededCandidates(newOrder, [{ ...base, id: "NEW1" }]).length, 0, "不得取代自己");

  assert.equal(sameVehicle({ vehicle: VEH }, { vehicle: VEH.toLowerCase() }), true, "车辆比较应归一化");
  assert.equal(vehiclePlate("北JM03022"), "", "非省份简称开头不是可信车牌");
  assert.equal(vehiclePlate("渝DK7692"), "渝DK7692", "标准车牌应能识别");
  assert.equal(vehiclePlate("车辆 渝DK7692"), "渝DK7692", "带前缀文字仍能提取车牌");
  assert.equal(sameVehicle({ vehicle: null }, { vehicle: null }), true, "双方缺失时不据车牌排除");
  console.log("✅ 安全边界全部守住（残单/第二趟/异车/异日/异线路/已取代/阶段不符/缺车辆）");
}

/* ============ 5. 静态守卫：接入点与原子动作 ============ */
{
  const proc = read("functions/api/waybills/process.js");
  const mod = read("functions/api/waybills/_process-supersede.js");

  // 必须在「新建成功」分支里触发（而不是去重命中/idempotent 分支）
  const newBranch = proc.slice(proc.indexOf('if(reason==="NEW")'));
  assert.ok(
    newBranch.slice(0, 700).includes("supersedeSameDay"),
    "必须在 reason===\"NEW\" 分支内触发取代"
  );
  // 必须在重算汇总之前（否则被取代的单仍计入当日统计）
  const idxSuper = proc.indexOf("supersedeSameDay(env,order,indexKey)");
  const idxMeta = proc.indexOf('await touchMeta(); markSaveStage("saveDayMetaMs"');
  assert.ok(idxSuper > 0 && idxMeta > idxSuper, "取代必须发生在重算当日汇总之前");

  // 原子脚本：标记状态 + 移出索引 + 清理去重/指纹键
  assert.ok(/historyStatus\s*=\s*"SUPERSEDED"/.test(mod), "脚本必须写入 historyStatus=SUPERSEDED");
  assert.ok(/redis\.call\("SREM"/.test(mod), "脚本必须把旧单移出历史索引（避免统计重复）");
  assert.ok(/zp:waybill:dedupe:/.test(mod), "应清理指向旧单的当日去重键");
  assert.ok(/zp:waybill:fingerprint:/.test(mod), "应清理指向旧单的内容指纹键");
  assert.ok(/supersededBy/.test(mod) && /supersededAt/.test(mod) && /supersededReason/.test(mod), "必须留痕（谁取代的/何时/原因）");

  // 预算保护：读取失败时跳过取代，不影响保存
  assert.ok(/read\.complete/.test(proc), "批量读取应受预算保护");
  assert.ok(/catch\{return\[\]\}/.test(proc), "取代异常不得影响主流程");

  // 根因守卫：mgetBatchMap 必须传「完整 Redis 键」（zp:waybill: 前缀）。
  // SMEMBERS 拿到的是裸 id，若直接传裸 id，MGET 全落空 → others 恒空 → 取代永不触发。
  assert.ok(
    proc.includes('mgetBatchMap(env,ids.map(id=>"zp:waybill:"+id)'),
    "取代读取必须补 zp:waybill: 前缀（线上旧残单未被清理的根因）"
  );
  assert.ok(
    !proc.includes('mgetBatchMap(env,ids,budget'),
    "process.js 不得再以裸 id 调 mgetBatchMap（supersede 与去重兜底扫描均已修复）"
  );
  console.log("✅ 接入点、原子性、留痕、预算保护与键前缀齐备");
}

console.log("\n✅ waybill-supersede 全部通过");
