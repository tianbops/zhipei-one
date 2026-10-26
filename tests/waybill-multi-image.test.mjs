/* 多张截图（同一运单分段拍摄）门店合并回归
   用例取自真实运单：渝DK7692 / 2026-10-27，路线为箭头串联的长行，分三张截图拍摄：
     图1（首图，含表头）末尾残：江北亿达鲜半山华府店（客
     图2（中段）开头是缺前缀的“江北区鸿恩寺客服中心（2026)”、末尾残：渝北中
     图3（末段）开头残：贤加盟重庆彭成商贸有限公司，末尾完整 + 运单号表格
   衔接处有重叠门店（完整版在相邻图里），因此剔除边界残条不丢数据。 */
import assert from "node:assert/strict";
import { mergeStoreEdges } from "../functions/api/waybills/_process-multimage.js";
import { extract } from "../functions/api/waybills/_process-extract.js";

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
  const r = mergeStoreEdges([IMG1, IMG3]);
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

console.log("\n✅ waybill-multi-image 全部通过");
