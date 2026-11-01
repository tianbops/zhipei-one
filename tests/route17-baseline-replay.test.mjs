/**
 * 17号线规划离线重放测试（2026-10-20，v2 语义修正）
 * ------------------------------------------------------------------
 * 语义修正（用户 2026-10-20 明确）：
 *   原始运单图片的门店排列 ≠ 配送顺序，它只是「输入」；
 *   基准数据的顺序才是配送顺序，是「规划的输出目标」。
 *   因此本测试的唯一权威断言是：
 *       无论输入的门店排列如何，plan() 输出必须等于基准顺序的子序列。
 *   （v1 曾把运单列表截图当作实际配送顺序去反推 routeOrder，立论错误，已移除。）
 *
 * 运行：node tests/route17-baseline-replay.test.mjs
 * 退出码：规划不变量失败 → 1。
 *
 * 边界说明：原始运单纸面图片未在本地伟可用的 OCR 通道里跑过，
 *   这里的三天门店排列来自用户提供的运单图片人工抄录，属测试输入，不是真值。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { matchStores, formatCompareKey } from "../functions/api/waybills/_store-match.js";
import { createRouteBaseIndex } from "../functions/api/waybills/_process-plan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/* ================================================================
 * 夹具 1：17号线基准库（用户提供，列表顺序 = routeOrder）
 * ================================================================ */
const NAV = s => s ? `https://surl.amap.com/${s}` : "";
// [名称, 导航短链码, 备注]
const ROUTE17_BASELINE = [
  ["江北胡汪洋经销商（重庆胡建镜好食品有限公司）", "zTkZfPL2fP", ""],
  ["渝北中景隆(重庆)贸易有限公司", "", "由经销商代送"],
  ["江北重庆兴农融资担保集团有限公司", "", "由经销商代送"],
  ["江北重庆三峡融资担保集团有限公司", "", "由经销商代送"],
  ["渝北Q312重庆沁园餐饮管理有限公司松石北路店", "L0E65r1hcQ0", "由经销商代送"],
  ["渝北Q044重庆沁园餐饮管理有限公司加州龙华小吃店", "LMBE81r7aE", "由经销商代送"],
  ["特渠部重庆明德商业保理有限公司", "", "由经销商代送"],
  ["渝北Q398重庆沁园餐饮管理有限公司松石支路二店", "LfpJ4R1h5Hw", "由经销商代送"],
  ["渝北Q105重庆沁园餐饮管理有限公司财信国际小吃店", "", "由经销商代送"],
  ["渝北格意东和春天店", "MzBOpHEbHK", "由经销商代送"],
  ["渝北JM03131谊品生鲜长安锦绣城店", "AdXwff1e4Rz", ""],
  ["到家主城-江北区加州客服中心（2026）", "", ""],
  ["到家主城-江北区鸿恩寺客服中心（2026）", "SACrkaP5WS", ""],
  ["特渠部重庆市卫生健康委员会", "AweHMZ51hw", ""],
  ["渝北钱大妈重庆东和春天店", "AAhmTn1B2aU", ""],
  ["天友24h重庆海浚酒店管理有限公司", "Av3Msp1tbyg", ""],
  ["特渠部重庆市市级机关后勤服务中心(龙脊花园食堂)", "AEBwNPzfAK", ""],
  ["渝北A02230谊品生鲜温馨家园南门店", "ASAMjvP8RY", ""],
  ["渝北中国邮政集团江北分公司(佳阖养老)", "XIREd4ZbaU", ""],
  ["天友加盟韩志贤加盟重庆彭成商贸有限公司", "BIThH3K4iZ", ""],
  ["江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)", "BNfNhLHfqp", ""],
  ["II类天友生活花卉东路店", "BVENzHk6lp", ""],
  ["江北重庆渝商餐饮文化产业投资有限公司", "CjBlIB1dfQD", ""],
  ["特渠部重庆市区嘉陵公园管理中心（大客户)", "CQu3iNO3xc", ""],
  ["江北重庆全嘉食品供应链科技有限公司（救助管理站）", "D8ncdbEeHE", ""],
  ["特渠部江北区全英食品经营部", "D6PWU9Yfdl", ""],
  ["江北沁园Q642绿地海外滩米拉公馆店", "FIi3R7A1Lm", ""],
  ["特渠部重庆市药品监督管理局检查一局", "FVJ1YB12Mi", ""],
  ["江北JM03022谊品生鲜重庆北国风光店", "FAuespj1V5", ""],
  ["江北亿达鲜半山华府店(客百年)", "Fb9sjTL0kw", ""],
  ["江北钱大妈半山华府店", "F9F97bx8Bg", ""],
  ["江北沁园Q568东方家园店", "EX5L3rjctb", ""],
  ["特渠部重庆市市级机关后勤服务中心（北滨路）", "EvjVFLI17z", ""],
  ["特渠部重庆市玖鑫酒店有限公司(市委统战部)", "Ew9PFTTgsB", ""],
  ["江北A02175谊品生鲜锦绣北滨路店", "Erm38t34Ya", ""],
  ["江北沁园Q432沁园金砂水岸店", "EN7MNz1vaiA", ""],
  ["江北Q784华唐立交店", "pGIanJfg1O4", ""],
  ["江北亿达鲜御龙天峰(客百年)", "E28mE118bKv", ""],
  ["江北JM03115 - 谊品生鲜重庆御龙天峰店", "E3x0Ex1sgRh", ""],
  ["江北沁园Q714轨道华新街店", "DPOFwRzdCq", ""],
  ["江北亿达鲜观府国际店（客百年）", "1flByr0485T", ""],
  ["天友加盟农垦大厦店", "DNucIhMedX", ""],
  ["特渠部重庆市卫生健康委员会（临时）", "", ""],
];
const baseStores = ROUTE17_BASELINE.map(([name, nav, note], i) => ({
  storeId: `R17-${String(i + 1).padStart(2, "0")}`,
  originalName: name,
  name,
  aliases: [],
  businessStoreCode: "",
  navigation: NAV(nav),
  routeOrder: i + 1,
  note,
}));
const route17MatchIndex = createRouteBaseIndex(baseStores);

/* ================================================================
 * 夹具 2：三天运单的门店排列（原始运单图片顺序 = 输入，NOT 配送顺序）
 * ================================================================ */
const WAYBILL_INPUT_DAYS = {
  "2026-09-30": [
    "渝北A02230谊品生鲜温馨家园南门店",
    "到家主城-江北区鸿恩寺客服中心（2026）",
    "到家主城-江北区加州客服中心（2026）",
    "江北亿达鲜观府国际店（客百年）",
    "江北亿达鲜半山华府店(客百年)",
    "江北重庆三峡融资担保集团有限公司",
    "天友加盟农垦大厦店",
    "江北JM03115-谊品生鲜重庆御龙天峰店",
    "天友24h重庆海浚酒店管理有限公司",
    "天友加盟韩志贤加盟重庆彭成商贸有限公司",
    "II类天友生活花卉东路店",
    "特渠部重庆市卫生健康委员会",
    "江北JM03022谊品生鲜重庆北国风光店",
    "渝北中景隆(重庆)贸易有限公司",
    "渝北钱大妈重庆东和春天店",
    "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)",
    "江北胡汪洋经销商（重庆胡建镜好食品有限公司）",
    "江北A02175谊品生鲜锦绣北滨路店",
    "江北钱大妈半山华府店",
    "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
    "渝北Q312重庆沁园餐饮管理有限公司松石北路店",
  ],
  "2026-10-19": [
    "渝北A02230谊品生鲜温馨家园南门店",
    "特渠部重庆市卫生健康委员会（临时）",
    "到家主城-江北区鸿恩寺客服中心（2026）",
    "到家主城-江北区加州客服中心（2026）",
    "江北亿达鲜观府国际店（客百年）",
    "江北亿达鲜半山华府店（客百年）",
    "江北重庆三峡融资担保集团有限公司",
    "天友加盟农垦大厦店",
    "江北JM03115-谊品生鲜重庆御龙天峰店",
    "天友24h重庆海浚酒店管理有限公司",
    "天友加盟韩志贤加盟重庆彭成商贸有限公司",
    "II类天友生活花卉东路店",
    "特渠部重庆市玖鑫酒店有限公司(市委统战部)",
    "特渠部重庆市药品监督管理局检查一局",
    "特渠部重庆市卫生健康委员会",
    "江北JM03022谊品生鲜重庆北国风光店",
    "渝北中景隆（重庆）贸易有限公司",
    "江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村）",
    "江北胡汪洋经销商（重庆胡建镜好食品有限公司）",
    "江北A02175谊品生鲜锦绣北滨路店",
    "江北钱大妈半山华府店",
    "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
  ],
  "2026-10-20": [
    "渝北A02230谊品生鲜温馨家园南门店",
    "特渠部重庆市卫生健康委员会（临时）",
    "到家主城-江北区鸿恩寺客服中心（2026）",
    "到家主城-江北区加州客服中心（2026）",
    "江北亿达鲜观府国际店（客百年）",
    "江北亿达鲜半山华府店（客百年）",
    "江北重庆三峡融资担保集团有限公司",
    "天友加盟农垦大厦店",
    "江北JM03115-谊品生鲜重庆御龙天峰店",
    "天友24h重庆海浚酒店管理有限公司",
    "天友加盟韩志贤加盟重庆彭成商贸有限公司",
    "II类天友生活花卉东路店",
    "特渠部重庆市卫生健康委员会",
    "江北JM03022谊品生鲜重庆北国风光店",
    "渝北中景隆（重庆）贸易有限公司",
    "江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村）",
    "江北胡汪洋经销商（重庆胡建镜好食品有限公司）",
    "江北沁园Q568东方家园店",
    "江北A02175谊品生鲜锦绣北滨路店",
    "江北钱大妈半山华府店",
    "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
    "渝北Q312重庆沁园餐饮管理有限公司松石北路店",
  ],
};

/* ================================================================
 * plan() 镜像（_process-plan.js，P1-1g 拆分后字节级同一行）+ 源码一致性防漂移断言
 * ================================================================ */
const number = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const mirrorPlan = (items, useRouteOrder = true) => {
  const list = useRouteOrder
    ? [...items].sort((a, b) =>
        (number(a.routeOrder) ?? 100000) - (number(b.routeOrder) ?? 100000) ||
        formatCompareKey(a.name).localeCompare(formatCompareKey(b.name), "zh-CN"))
    : [...items];
  return list.map((s, i) => ({ ...s, routeOrder: i + 1 }));
};

const processSrc = readFileSync(path.join(repoRoot, "functions/api/waybills/_process-plan.js"), "utf8");
const PLAN_LINE = 'function plan(items,useRouteOrder=true){const list=useRouteOrder?[...items].sort((a,b)=>(number(a.routeOrder)??100000)-(number(b.routeOrder)??100000)||formatCompareKey(a.name).localeCompare(formatCompareKey(b.name),"zh-CN")):[...items];return list.map((s,i)=>({...s,routeOrder:i+1}))}';
if (!processSrc.includes(PLAN_LINE)) {
  console.error("✗ _process-plan.js 的 plan() 源码已变化，镜像实现需同步更新（防漂移断言）");
  process.exit(1);
}

/* ================================================================
 * 简易断言 + 报告收集
 * ================================================================ */
let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? "  ✓" : "  ✗") + " " + label);
  if (!cond) failures++;
};
const report = [];
const line = (s = "") => { console.log(s); report.push(s); };

/* ================================================================
 * 第 1 步：匹配重放（三 real 天门店名 → 基准库）
 * ================================================================ */
line("═".repeat(64));
line("第 1 步 · 匹配重放（matchStores：三天真实门店名 → 17号线基准库 43 家）");
line("═".repeat(64));
const dayMatched = {};
const dayStoreName = {}; // storeId -> 基准标准名
for (const [date, seq] of Object.entries(WAYBILL_INPUT_DAYS)) {
  const items = seq.map((rawName, i) => ({ index: i + 1, rawName }));
  const matched = matchStores(items, baseStores);
  const indexedMatched = matchStores(items, route17MatchIndex.stores, route17MatchIndex.matchIndex);
  ok(JSON.stringify(indexedMatched) === JSON.stringify(matched), `${date}：复用 MatchIndex 与原匹配输出逐字段一致`);
  dayMatched[date] = matched;
  for (const s of matched) dayStoreName[s.storeId] = s.name;
  const pend = matched.filter(x => x.pending);
  const ids = new Set(matched.map(x => x.storeId));
  ok(pend.length === 0, `${date}：${matched.length}/${seq.length} 全部自动匹配，待定 0（实际待定 ${pend.length}${pend.length ? "：" + pend.map(p => p.rawName).join("、") : ""}）`);
  ok(ids.size === matched.length, `${date}：无 storeId 冲突（去重前 ${matched.length} → 唯一 ${ids.size}）`);
  const sim = matched.filter(x => x.matchMethod === "similarity");
  if (sim.length) line(`    · 相似度匹配 ${sim.length} 家：${sim.map(x => `${x.rawName}→${x.name}(${x.matchConfidence.score})`).join("；")}`);
  const corr = matched.filter(x => x.correction);
  if (corr.length) line(`    · 记名称更正 ${corr.length} 处：${corr.map(x => x.rawName).join("、")}`);
}

/* 跨天占用保护：所有天合并后同一 storeId 不应有两种不同 identityKey 的歧义映射 */
const nameToId = new Map();
let mapConflict = 0;
for (const matched of Object.values(dayMatched)) {
  for (const s of matched) {
    const prev = nameToId.get(s.rawName);
    if (prev && prev !== s.storeId) mapConflict++;
    nameToId.set(s.rawName, s.storeId);
  }
}
ok(mapConflict === 0, `跨天同名映射一致（冲突 ${mapConflict} 处）`);

/* ================================================================
 * 第 2 步：规划确定性（输入顺序不影响输出）
 * ================================================================ */
line("");
line("═".repeat(64));
line("第 2 步 · 规划确定性（plan() 镜像：乱序输入 → 同一输出）");
line("═".repeat(64));
for (const [date] of Object.entries(WAYBILL_INPUT_DAYS)) {
  const items = dayMatched[date];
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  const a = mirrorPlan(items, true).map(x => x.storeId).join(">");
  const b = mirrorPlan(shuffled, true).map(x => x.storeId).join(">");
  ok(a === b, `${date}：随机乱序重规划输出一致（${items.length} 家）`);
  const roSeq = mirrorPlan(items, true).map((x, i) => x.routeOrder === i + 1).every(Boolean);
  ok(roSeq, `${date}：routeOrder 重排后连续 1..${items.length}`);
}

/* ================================================================
 * 第 3 步：规划正确性（权威断言）
 *   输入顺序来自运单图片（不是配送顺序），规划输出必须收敛到基准顺序。
 * ================================================================ */
line("");
line("═".repeat(64));
line("第 3 步 · 规划正确性：输出必须等于基准顺序的子序列");
line("═".repeat(64));
const baseIdxOf = name => ROUTE17_BASELINE.findIndex(b => formatCompareKey(b[0]) === formatCompareKey(name));

for (const [date, inputSeq] of Object.entries(WAYBILL_INPUT_DAYS)) {
  const planned = mirrorPlan(dayMatched[date], true);
  const expected = inputSeq.map(baseIdxOf).sort((a, b) => a - b); // 按基准序号升序 = 基准对该天的配送顺序
  const gotIdx = planned.map(x => baseIdxOf(x.name));

  ok(gotIdx.length === inputSeq.length, `${date}：规划门店数守恒（输入 ${inputSeq.length} → 输出 ${gotIdx.length}）`);
  ok(gotIdx.every((v, i) => v === expected[i]), `${date}：输出逐位等于基准顺序的子序列`);
  ok(gotIdx.every((v, i) => i === 0 || v > gotIdx[i - 1]), `${date}：输出在基准中严格单调递增（无逆序）`);
  const sameAsInput = planned.every((s, i) => formatCompareKey(s.name) === formatCompareKey(inputSeq[i]));
  ok(!sameAsInput, `${date}：输出确实被重排（未退化成原样透传）`);

  // 无基准库兜底时的行为文档化：保持运单原序
  const noBase = mirrorPlan(dayMatched[date], false).map(x => x.name);
  ok(noBase.every((n, i) => formatCompareKey(n) === formatCompareKey(inputSeq[i])), `${date}：useRouteOrder=false 兜底时保持运单原序`);
}

/* ================================================================
 * 第 4 步：输入（运单排列） vs 输出（基准配送顺序）的重排幅度
 *   说明为什么需要规划 —— 运单排列本身不是配送顺序。
 * ================================================================ */
line("");
line("═".repeat(64));
line("第 4 步 · 重排幅度：运单排列 → 基准配送顺序");
line("═".repeat(64));
for (const [date, inputSeq] of Object.entries(WAYBILL_INPUT_DAYS)) {
  const planned = mirrorPlan(dayMatched[date], true);
  const gotIdx = planned.map(x => baseIdxOf(x.name));
  const inpIdx = inputSeq.map(baseIdxOf);
  let inv = 0;
  for (let i = 0; i < inpIdx.length; i++) for (let j = i + 1; j < inpIdx.length; j++) if (inpIdx[i] > inpIdx[j]) inv++;
  const maxInv = inpIdx.length * (inpIdx.length - 1) / 2;
  const kept = gotIdx.filter((v, i) => v === inpIdx[i]).length;
  const totalMove =inpIdx.reduce((s, v, i) => s + Math.abs(gotIdx.indexOf(v) - i), 0);
  line(`\n【${date}】${inputSeq.length} 家`);
  line(`  运单排列本身的逆序度：${inv}/${maxInv}（越高说明运单排列越不像配送顺序）`);
  line(`  规划后仍留在原位的门店：${kept}/${inputSeq.length} 家；平均位移 ${(totalMove / inputSeq.length).toFixed(1)} 位`);
}

/* ================================================================
 * 第 5 步：输出三天各自的基准配送顺序（可直接给司机执行）
 * ================================================================ */
line("");
line("═".repeat(64));
line("第 5 步 · 按基准数据得出的正确配送顺序（规划输出）");
line("═".repeat(64));
for (const [date, inputSeq] of Object.entries(WAYBILL_INPUT_DAYS)) {
  const planned = mirrorPlan(dayMatched[date], true);
  line(`\n【${date}】共 ${planned.length} 站：`);
  planned.forEach((s, i) => {
    const bi = baseIdxOf(s.name) + 1;
    const note = s.note ? `（${s.note}）` : "";
    line(`  第 ${String(i + 1).padStart(2, "0")} 站 · 基准第${String(bi).padStart(2, "0")}位 · ${s.name}${note}`);
  });
}

/* ================================================================
 * 第 6 步：覆盖统计（每日门店是基准集合的子集，客户下单频率不同）
 * ================================================================ */
line("");
line("═".repeat(64));
line("第 6 步 · 覆盖统计（每日运单 = 基准集合的当日下单子集）");
line("═".repeat(64));
const seen = new Set();
for (const [date] of Object.entries(WAYBILL_INPUT_DAYS)) dayMatched[date].forEach(s => seen.add(s.storeId));
for (const [date] of Object.entries(WAYBILL_INPUT_DAYS)) {
  line(`  ${date}：${dayMatched[date].length} 家 / 占基准 ${baseStores.length} 家的 ${(100 * dayMatched[date].length / baseStores.length).toFixed(0)}%`);
}
line(`  三天合计覆盖：${seen.size}/${baseStores.length} 家`);
const never = baseStores.filter(b => !seen.has(b.storeId));
line(`  三天均未下单的基准门店 ${never.length} 家（低频客户，属正常现象）：`);
never.forEach(b => line("    · " + b.name));
ok(seen.size <= baseStores.length, `每日集合 ⊆ 基准集合（合计 ${seen.size} ≤ ${baseStores.length}）`);

line("");
line(failures ? `结果：${failures} 项断言失败` : "结果：全部断言通过（规划输出严格收敛到基准配送顺序）");
process.exit(failures ? 1 : 0);
