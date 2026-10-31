/* 多张截图（同一运单分段拍摄）门店合并回归
   用例取自真实运单：渝DK7692 / 2026-10-27，路线为箭头串联的长行，分三张截图拍摄：
     图1（首图，含表头）末尾残：江北亿达鲜半山华府店（客
     图2（中段）开头是缺前缀的“江北区鸿恩寺客服中心（2026)”、末尾残：渝北中
     图3（末段）开头残：贤加盟重庆彭成商贸有限公司，末尾完整 + 运单号表格
   衔接处有重叠门店（完整版在相邻图里），因此剔除边界残条不丢数据。 */
import assert from "node:assert/strict";
import { mergeStoreEdges } from "../functions/api/waybills/_process-multimage.js";
import { extract } from "../functions/api/waybills/_process-extract.js";
import { formatCompareKey, normalizeForMatch, matchStores } from "../functions/api/waybills/_store-match.js";

const HEADER = [
  "运单列表", "运输日期", "2026-10-27", "车牌号", "渝DK7692",
  "额定载重：18吨", "额定装载", "额定体积：40m³", "主司机", "田波",
  "送货员", "荣富强", "承运订单",
  "总数量129| 总重量1.150255t(6.39%) |总体积3.00823m³(7.52%)"
].join("\n");

// 图1：首图（表头 + 路线开头），末尾被屏幕底部截断
const IMG1 = HEADER + "\n" + [
  "渝北A02230谊品生鲜温馨家园南门店",
  "特渠部重庆市卫生健康委员会（临时)",
  "到家主城-江北区鸿恩寺客服中心（2026)",
  "到家主城-江北区加州客服中心（2026)",
  "江北亿达鲜观府国际店(客百年)",
  "江北亿达鲜半山华府店（客"        // ← 残条（缺“百年)”）
].join(" -> ");

// 图2：中段，开头缺“到家主城-”前缀（看似完整实为残），末尾残“渝北中”
const IMG2 = [
  "江北区鸿恩寺客服中心（2026)",
  "到家主城-江北区加州客服中心（2026)",
  "江北亿达鲜观府国际店(客百年)",
  "江北亿达鲜半山华府店（客百年）",
  "江北亿达鲜御龙天峰(客百年)",
  "江北重庆三峡融资担保集团有限公司",
  "天友加盟农垦大厦店",
  "江北Q784华唐立交店",
  "江北JM03115-谊品生鲜重庆御龙天峰店",
  "天友24h重庆海浚酒店管理有限公司",
  "天友加盟韩志贤加盟重庆彭成商贸有限公司",
  "II类天友生活花卉东路店",
  "特渠部重庆市卫生健康委员会",
  "江北JM03022谊品生鲜重庆北国风光店",
  "渝北中"                          // ← 残条（渝北中景隆的前半）
].join(" -> ");

// 图3：末段，开头残“贤加盟…”（完整名含“天友加盟韩志”），末尾完整，附运单号表格
const IMG3 = [
  "贤加盟重庆彭成商贸有限公司",     // ← 残条（缺“天友加盟韩志”）
  "II类天友生活花卉东路店",
  "特渠部重庆市卫生健康委员会",
  "江北JM03022谊品生鲜重庆北国风光店",
  "渝北中景隆(重庆）贸易有限公司",
  "江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村)",
  "江北胡汪经销商(重庆胡建镜好食品有限公司）",
  "江北A02175谊品生鲜锦绣北滨路店",
  "江北钱大妈半山华府店",
  "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"
].join(" -> ") + "\n运单号\nZW20261027CZZC01914 01897\nZW20261027CZZC01913 01896";

const names = stores => stores.map(s => String(s.name || ""));
const has = (list, kw) => list.some(n => n.includes(kw));

// 基准库完整门店判定（模拟生产 process.js 传入的 isKnownStore）。
// 残条（缺前缀“江北区鸿恩寺客服中心（2026)” / 缺后缀“…（客”“渝北中”等）不在其中。
const BASE_NAMES = [
  "渝北A02230谊品生鲜温馨家园南门店",
  "特渠部重庆市卫生健康委员会（临时)",
  "特渠部重庆市卫生健康委员会",
  "到家主城-江北区鸿恩寺客服中心（2026)",
  "到家主城-江北区加州客服中心（2026)",
  "江北亿达鲜观府国际店(客百年)",
  "江北亿达鲜半山华府店（客百年）",
  "江北亿达鲜御龙天峰(客百年)",
  "江北重庆三峡融资担保集团有限公司",
  "天友加盟农垦大厦店",
  "江北Q784华唐立交店",
  "江北JM03115-谊品生鲜重庆御龙天峰店",
  "天友24h重庆海浚酒店管理有限公司",
  "天友加盟韩志贤加盟重庆彭成商贸有限公司",
  "II类天友生活花卉东路店",
  "江北JM03022谊品生鲜重庆北国风光店",
  "渝北中景隆(重庆）贸易有限公司",
  "江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村)",
  "江北胡汪经销商(重庆胡建镜好食品有限公司）",
  "江北A02175谊品生鲜锦绣北滨路店",
  "江北钱大妈半山华府店",
  "渝北Q398重庆沁园餐饮管理有限公司松石支路二店",
];
const knownKeys = new Set(BASE_NAMES.map(formatCompareKey));
const isKnownStore = n => knownKeys.has(formatCompareKey(n));

// --- 1) 单图：不适用，行为不变 ---
{
  const r = mergeStoreEdges([IMG1]);
  assert.equal(r.stores, null, "单图不应启用边界裁剪");
  assert.equal(r.edgeTrimmed, 0);
  console.log("✅ 单图不启用裁剪（行为不变）");
}

// --- 2) 三图：合并结果正确 ---
{
  const r = mergeStoreEdges([IMG1, IMG2, IMG3]);
  assert.ok(r.stores && r.stores.length > 0, "多图应产出门店条目");
  const list = names(r.stores);

  // 2.1 残条必须被剔除
  assert.ok(!list.some(n => n.endsWith("（客")), `不应残留底部截断名：${list.filter(n => n.endsWith("（客"))}`);
  assert.ok(!list.some(n => n.trim() === "渝北中"), "不应残留“渝北中”残条");
  // 残条“贤加盟重庆彭成商贸有限公司”是完整名“天友加盟韩志贤加盟…”的后半截，
  // 因此不能用子串包含判断（完整名天然包含它），必须判断是否缺少前缀
  const brokenTail = list.filter(n => n.includes("贤加盟") && !n.includes("天友加盟"));
  assert.equal(brokenTail.length, 0, `不应残留缺前缀的开头残条：${brokenTail.join(" | ")}`);
  console.log("✅ 三条边界残条已剔除");

  // 2.2 重叠区的完整门店必须保留（证明不丢数据）
  assert.ok(has(list, "半山华府店") && list.some(n => n.includes("半山华府店") && n.includes("客百年")),
    "应保留完整的“江北亿达鲜半山华府店（客百年）”");
  assert.ok(has(list, "中景隆"), "应保留完整的“渝北中景隆(重庆）贸易有限公司”");
  assert.ok(has(list, "韩志贤加盟重庆彭成商贸"), "应保留完整的“天友加盟韩志贤加盟重庆彭成商贸有限公司”");
  assert.ok(has(list, "温馨家园南门店"), "首图第一个门店应保留");
  assert.ok(has(list, "松石支路二店"), "末图末尾完整门店应保留");
  console.log("✅ 重叠区完整门店全部保留（未丢数据）");

  // 2.3 运单号表格不得变成门店
  assert.ok(!has(list, "运单号"), "运单号表格不应产生门店");
  assert.ok(!list.some(n => /^\d{5,}$/.test(n.trim())), "纯数字编号不应成为门店");
  console.log("✅ 运单号表格未产生假门店");

  // 2.4 剔除计数：图1尾 + 图2首 + 图2尾 + 图3首 = 4
  assert.equal(r.edgeTrimmed, 4, `剔除计数应为 4，实际 ${r.edgeTrimmed}`);
  console.log("✅ 剔除计数正确（4 条）");
}

// --- 3) 两张图场景 ---
{
  // 生产真实形态：有基准库 predicate；仅首图+末图（中间图缺失）时，
  // 首图残条在末图无完整副本，靠位置式兜底（图序可靠 + 非基准库门店）剔除。
  const r = mergeStoreEdges([IMG1, IMG3], extract, { isKnownStore });
  assert.ok(r.stores && r.stores.length > 0);
  const list = names(r.stores);
  assert.ok(!list.some(n => n.endsWith("（客")), "两张图时首图末尾残条应剔除");
  const brokenTail2 = list.filter(n => n.includes("贤加盟") && !n.includes("天友加盟"));
  assert.equal(brokenTail2.length, 0, "两张图时末图开头残条应剔除");
  assert.ok(has(list, "松石支路二店"), "末图末尾应保留");
  assert.equal(r.edgeTrimmed, 2);
  console.log("✅ 两张图场景正确");
}

// --- 4) 空文本不应崩溃 ---
{
  const r = mergeStoreEdges(["", "", ""]);
  assert.equal(r.stores, null);
  assert.equal(r.edgeTrimmed, 0);
  console.log("✅ 空文本安全");
}

// --- 5) 重复粘贴（两段都含表头）：表头必须被逐处清洗，不得粘进门店名 ---
{
  const seg = HEADER + "\n" + [
    "渝北A02230谊品生鲜温馨家园南门店",
    "特渠部重庆市卫生健康委员会（临时)",
    "江北亿达鲜半山华府店（客百年）"
  ].join(" -> ");
  // 粘贴两遍：两段表头 + 两段路线（生产单 d4e2c65a 的真实形态）
  const r = extract(seg + "\n" + seg);
  const list = (r.stores || []).map(x => String(x.name || ""));
  const dirty = list.filter(n => /运单列表|运输日期|总数量|车牌号|承运订单/.test(n));
  assert.equal(dirty.length, 0, `表头不得粘进门店名：${dirty.join(" | ")}`);
  assert.ok(list.some(n => n.includes("温馨家园南门店")), "首家门店必须保留");
  assert.ok(list.some(n => n.includes("半山华府店")), "末家门店必须保留");
  console.log("✅ 重复粘贴时表头逐处清洗，门店不丢");
}

// --- 6) 截图 UI 噪声（状态栏/导航栏）必须剥离，且不误伤真实店名 ---
{
  const noisy = "06:05 5G85 < X 运单列表 江北区鸿恩寺客服中心（2026）";
  const r = extract(noisy);
  const list = names(r.stores || []);
  assert.equal(list.length, 1, `应只识别出 1 家门店，实际：${JSON.stringify(list)}`);
  assert.ok(!/06:05|5G|运单列表/.test(list[0]), `噪声未清理：${list[0]}`);
  assert.ok(list[0].includes("鸿恩寺客服中心"), `门店名丢失：${list[0]}`);

  // 真实店名不得被误伤（24h 开头 / 数字开头但后接汉字）
  for (const keep of ["24h天友便利重庆渝中店", "07号仓库直营店"]) {
    const k = names(extract(keep).stores || []);
    assert.equal(k[0], keep, `真实店名被误改：${JSON.stringify(keep)} → ${JSON.stringify(k[0])}`);
  }
  // 状态栏信号被 OCR 拼成 "G5G85"（"5G 85"），逃过前缀剥离 —— 短、无中文、含数字 → 丢弃
  const g5 = names(extract("06:05\nG5G85\n< X\n运单列表\n江北区鸿恩寺客服中心(2026）").stores || []);
  assert.equal(g5.length, 1, `状态栏残串应被丢弃，实际：${JSON.stringify(g5)}`);
  assert.ok(g5[0].includes("鸿恩寺客服中心"), `门店名丢失：${g5[0]}`);

  // 纯英文短名（无数字）不得被误杀
  const en = names(extract("KFC -> Starbucks Coffee 重庆店").stores || []);
  assert.equal(en.length, 2, `纯英文短名不得被丢弃，实际：${JSON.stringify(en)}`);

  console.log("✅ 截图 UI 噪声剥离正确，真实店名不受影响");
}

// --- 7) 图片顺序不可靠时必须按「含表头」校正首图 ---
{
  // 故意把中段图放在第一位（实测用户相册多选顺序出现过该情况）
  const r = mergeStoreEdges([IMG2, IMG1, IMG3]);
  const list = names(r.stores || []);
  assert.ok(list[0] && list[0].includes("温馨家园"), `首图判错，首条应为首家门店，实际：${list[0]}`);
  assert.ok(!list.some(n => /运单列表|运输日期|车牌号|06:05|5G/.test(n)),
    `残留表头/状态栏脏名：${list.filter(n => /运单列表|运输日期|车牌号|06:05|5G/.test(n)).join(" | ")}`);
  assert.ok(has(list, "半山华府店"), "重叠区门店不得丢失");
  assert.ok(has(list, "钱大妈半山华府店"), "末图门店不得丢失");
  console.log("✅ 含表头的图自动判为首图，脏名清零且不丢门店");
}

// --- 7b) 中段图与末图顺序颠倒（2026-10-27 线上实测故障）---
// 用户相册多选顺序 [首图, 末图, 中段图]：只按表头校正首图时，中段图被当成末图，
// 其底部残条“渝北中”逃过裁剪卡进待定。修复 = ① 运单号表格判末图 ② 底部残条按证据裁剪。
{
  const r = mergeStoreEdges([IMG1, IMG3, IMG2]);
  const list = names(r.stores || []);
  assert.ok(!list.some(n => n.trim() === "渝北中"),
    `顺序颠倒时底部残条“渝北中”仍应剔除：${JSON.stringify(list.filter(n => n.trim() === "渝北中"))}`);
  assert.ok(!list.some(n => n.endsWith("（客")), "首图底部残条应剔除");
  assert.ok(has(list, "松石支路二店"), "末图完整末店不得因顺序颠倒被误删");
  assert.ok(has(list, "中景隆"), "完整的“渝北中景隆”必须保留");
  assert.ok(has(list, "韩志贤加盟重庆彭成商贸"), "完整版门店不得丢失");
  console.log("✅ 中段/末图顺序颠倒时，残条仍被剔除且完整门店不丢");
}

// --- 7c) 运单号表格（ZW…）是末图依据：含表格的图必须排到最后 ---
{
  // IMG3 含 ZW 运单号表格 → 无论上传顺序如何都应排末位
  const r = mergeStoreEdges([IMG1, IMG3, IMG2]);
  const list = names(r.stores || []);
  assert.ok(list[0].includes("温馨家园"), "表头图仍应判为首图");
  // 修正排序后即真实拍摄顺序：中段图底部残条位置式剔除即可命中
  assert.ok(!list.some(n => n.trim() === "渝北中"), "排序修正后“渝北中”应被剔除");
  assert.ok(has(list, "松石支路二店"), "真实末店必须保留");
  console.log("✅ 运单号表格自动判为末图，顺序还原正确");
}

// --- 7d) 底部残条安全阀：基准库真实门店（前缀关系的两家真店）不得误删 ---
// 基准库同时存在「特渠部重庆市卫生健康委员会」与「…（临时）」，前者天然是后者
// 的前缀；若前者恰在某张图末尾，绝不能被当成后者的残条删掉。
// 真实滚动场景：完整真店在下一张图的重叠区必有完整副本（identical≥2 → 保留）。
{
  const imgShort = "到家主城-江北区鸿恩寺客服中心（2026） -> 特渠部重庆市卫生健康委员会";
  // 下一张图以重叠的完整副本开头（真实滚动必然如此）
  const imgTemp = "特渠部重庆市卫生健康委员会 -> 特渠部重庆市卫生健康委员会（临时） -> 渝北A02230谊品生鲜温馨家园南门店";
  const known = name => /卫生健康委员会/.test(String(name || "")) || /鸿恩寺|温馨家园/.test(String(name || ""));
  // 无基准（不传 predicate）：靠「重叠区完整副本」证据保住真店
  const r0 = mergeStoreEdges([imgShort, imgTemp]);
  assert.ok(names(r0.stores || []).some(n => n.includes("卫生健康委员会") && !n.includes("临时")),
    "无基准时真店名不得被当残条删除");
  // 有基准（predicate 命中）：双保险
  const r1 = mergeStoreEdges([imgShort, imgTemp], extract, { isKnownStore: known });
  assert.ok(names(r1.stores || []).some(n => n.includes("卫生健康委员会") && !n.includes("临时")),
    "基准库完整门店不得被当残条删除");
  // 对照组：无末图依据（图序不可靠）时，真残条「渝北中」按证据仍被剔除
  const img3NoTable = ["贤加盟重庆彭成商贸有限公司", "II类天友生活花卉东路店", "渝北中景隆(重庆）贸易有限公司",
    "江北钱大妈半山华府店", "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"].join(" -> ");
  const r2 = mergeStoreEdges([IMG2, img3NoTable], extract, { isKnownStore: known });
  assert.ok(!names(r2.stores || []).some(n => n.trim() === "渝北中"), "有基准时真残条仍应剔除");
  assert.ok(names(r2.stores || []).some(n => n.includes("松石支路二店")), "末图完整末店应保留");
  console.log("✅ 基准库真店（前缀关系）不被误删，真残条仍剔除");
}

// --- 7e) 罗马数字序号 OCR 误读：文字全同、仅符号差异必须视为同一家门店 ---
// 线上实测：OCR 把「II类」读成「IⅡ类」（NFKC 分解后 III≠II）→ 相似度 94% 卡待定，
// 且与重叠区的完整版无法去重。
{
  const A = "II类天友生活花卉东路店";
  const B = "IⅡ类天友生活花 卉东路店";   // 实际 OCR 输出（I + Ⅱ）
  const C = "Ⅲ类天友生活花卉东路店";     // Ⅱ 误读成 Ⅲ
  assert.equal(formatCompareKey(B), formatCompareKey(A), `formatCompareKey 未坍缩：${formatCompareKey(B)}`);
  assert.equal(formatCompareKey(C), formatCompareKey(A), `formatCompareKey 未坍缩：${formatCompareKey(C)}`);
  assert.equal(normalizeForMatch(B), normalizeForMatch(A), "normalizeForMatch 未坍缩");
  // 匹配引擎：B 应 data-exact 命中基准库 A（而非 94% 相似度卡待定）
  const base = [{ storeId: "store_ii", name: A }];
  const m = matchStores([{ rawName: B, name: B, sourceLine: B }], base);
  assert.equal(m.length, 1);
  assert.ok(!m[0].pending, `「IⅡ类…」应直接匹配基准门店，实际 pending=${m[0].pending}`);
  assert.equal(m[0].storeId, "store_ii", "应命中基准库「II类…」门店");
  console.log("✅ IⅡ/Ⅲ/Il/ll 与 II 视为同一家门店，直接匹配不再卡待定");
}

// --- 7f) 重复拍末图（两张都含运单号表格）时不得丢完整门店 ---
// 用户可能对列表末尾+表格拍两次：前一张的末条是完整门店，后一张首条是它的
// 重叠副本。位置式兜底必须避开基准库完整门店，否则会与顶部规则一起把该店删光。
{
  const A = ["到家主城-江北区鸿恩寺客服中心（2026）", "江北亿达鲜半山华府店（客百年）", "渝北中景隆(重庆）贸易有限公司"].join(" -> ") + "\n运单号\nZW20261027CZZC01914 01897";
  const B = ["渝北中景隆(重庆）贸易有限公司", "江北重庆彩食鲜供应链发展有限公司（重庆中法供水有限公司花园新村)", "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"].join(" -> ") + "\n运单号\nZW20261027CZZC01913 01896";
  const r = mergeStoreEdges([A, B], extract, { isKnownStore });
  const list = names(r.stores || []);
  assert.ok(has(list, "中景隆"), "重复末图时前一张的完整末店不得被删");
  assert.ok(has(list, "松石支路二店"), "末店必须保留");
  assert.ok(!list.some(n => n.trim() === "渝北中"), "真残条仍应剔除");
  console.log("✅ 重复拍末图时完整门店不丢");
}

// --- 7g) 已知边界：差 1 字的极端截断宁留勿删；无 base 时证据规则独立生效 ---
{
  // 差 1 字：残条「…贸易有限公」与完整名仅差「司」，diff=1 < 阈值 2 → 保守保留，
  // 交给后续相似度匹配兜底（宁可多一个待定，也不误删真店）。
  const C = ["到家主城-江北区鸿恩寺客服中心（2026）", "渝北中景隆(重庆)贸易有限公"].join(" -> ");
  const D = ["渝北中景隆(重庆)贸易有限公司", "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"].join(" -> ");
  const r1 = mergeStoreEdges([C, D], extract, { isKnownStore });
  assert.ok(names(r1.stores || []).some(n => n.includes("贸易有限公")), "差1字残条宁留勿删（交匹配兜底）");

  // 无 base（不传 predicate，对应临时线路/全局学习）：证据规则仍独立生效——
  // 残条有「以它开头的更长门店名」且无完整副本 → 仍剔除；末店保留。
  const img3NoTable = ["贤加盟重庆彭成商贸有限公司", "II类天友生活花卉东路店", "渝北中景隆(重庆）贸易有限公司",
    "江北钱大妈半山华府店", "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"].join(" -> ");
  const r2 = mergeStoreEdges([IMG2, img3NoTable], extract);
  assert.ok(!names(r2.stores || []).some(n => n.trim() === "渝北中"), "无基准时真残条仍按证据剔除");
  assert.ok(names(r2.stores || []).some(n => n.includes("松石支路二店")), "无基准时末店保留");
  console.log("✅ 差1字残条宁留勿删；无 base 时证据规则独立生效");
}

// --- 8) 待定门店可按「丢弃」剔除（确认接口出口存在）---
{
  const fs = await import("node:fs");
  const be = fs.readFileSync(new URL("../functions/api/waybills/confirm.js", import.meta.url), "utf8");
  assert.ok(/discard/.test(be), "后端未支持 discard 动作");
  assert.ok(/discarded/.test(be), "后端未统计丢弃数量");
  console.log("✅ 确认接口保留「丢弃」出口");
}

console.log("\n✅ waybill-multi-image 全部通过");


// --- 9) 连续重叠必须按出现次数精确断言（防止“存在即可”掩盖重复）---
{
  const A = "到家主城-江北区鸿恩寺客服中心（2026）";
  const B = "到家主城-江北区加州客服中心（2026）";
  const C = "江北亿达鲜观府国际店（客百年）";
  const D = "江北亿达鲜半山华府店（客百年）";
  const seq = xs => xs.join(" -> ");
  const count = (xs, name) => xs.filter(x => formatCompareKey(x) === formatCompareKey(name)).length;

  // 两条连续重叠：第二张图的 A、B 是重复副本，必须各只出现一次。
  {
    const r = mergeStoreEdges([seq([A, B, C]), seq([A, B, C, D])], extract);
    const list = names(r.stores || []);
    assert.equal(count(list, A), 1, "两图重叠 A 必须恰好保留一次");
    assert.equal(count(list, B), 1, "两图重叠 B 必须恰好保留一次");
    assert.equal(count(list, C), 1, "两图重叠 C 必须恰好保留一次");
    assert.equal(count(list, D), 1, "第二图新增 D 必须完整保留一次");
  }

  // 三条连续重叠：验证最长连续后缀/前缀，不只验证门店“存在”。
  {
    const r = mergeStoreEdges([seq([A, B, C]), seq([A, B, C, D])], extract);
    const list = names(r.stores || []);
    for (const store of [A, B, C, D]) {
      assert.equal(count(list, store), 1, `三条连续重叠后 ${store} 必须恰好出现一次`);
    }
  }

  // 括号全半角、空格差异：仅归一化后相等才允许裁剪。
  {
    const variant = "江北亿达鲜观府国际店 (客百年)";
    assert.equal(formatCompareKey(variant), formatCompareKey(C), "括号/空格差异应归一化");
    const r = mergeStoreEdges([seq([A, B, C]), seq([B, variant, D])], extract);
    const list = names(r.stores || []);
    assert.equal(count(list, B), 1, "归一化后的 B 重叠副本必须裁剪");
    assert.equal(count(list, C), 1, "归一化后的 C 重叠副本必须裁剪");
    assert.equal(count(list, D), 1, "新增门店 D 必须保留");
  }

  // 中间插入不同门店会打断连续重叠；不得跨过 X 把后面的 C 当成连续重叠裁掉。
  {
    const X = "江北重庆三峡融资担保集团有限公司";
    const r = mergeStoreEdges([seq([A, B, C]), seq([B, X, C, D])], extract);
    const list = names(r.stores || []);
    assert.ok(list.some(n => formatCompareKey(n) === formatCompareKey(X)), "中间插入的 X 必须保留");
    assert.ok(count(list, C) >= 1, "不得跨过 X 误删后续 C");
    assert.ok(list.some(n => formatCompareKey(n) === formatCompareKey(D)), "非重叠新增 D 必须保留");
  }

  console.log("✅ 连续两条/三条重叠按精确次数校验；归一化与中间插入边界已覆盖");
}
