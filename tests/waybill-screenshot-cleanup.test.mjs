import assert from "node:assert/strict";
import { extract } from "../functions/api/waybills/_process-extract.js";
import { mergeStoreEdges } from "../functions/api/waybills/_process-multimage.js";
import { dedupe } from "../functions/api/waybills/_process-plan.js";
import { formatCompareKey } from "../functions/api/waybills/_store-match.js";

const HEADER = "运单列表\\n运输日期\\n2026-10-28\\n车牌号\\n渝DK7692\\n额定载重：18吨\\n额定装载\\n额定体积：40m³\\n主司机\\n田波\\n送货员\\n荣富强\\n承运订单\\n总数量227|总重量1.563121t(8.68%)|总体积3.462567m³(8.66%)";
const names = items => (items || []).map(item => String(item.name || item.rawName || ""));
const formatKey = value => String(value || "").replace(/[（）()\s]/g, "").replace(/[·•]/g, "");

// Case 1: the first screenshot ends in a clipped store name; the next screenshot
// starts with that same store's complete name. Keep the complete copy, not neither.
{
  const first = HEADER + "\\n" + [
    "渝北A02230谊品生鲜温馨家园南门店",
    "渝北中景隆(重庆)贸易有"
  ].join(" -> ");
  const second = [
    "渝北中景隆(重庆)贸易有限公司",
    "江北钱大妈半山华府店",
    "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"
  ].join(" -> ") + "\\n运单号\\nZW20261028CZZC01885";

  const result = mergeStoreEdges([first, second], extract);
  const list = names(result.stores);
  assert.ok(list.some(name => name.includes("渝北中景隆") && name.includes("贸易有限公司")),
    "完整门店必须保留");
  assert.ok(!list.some(name => name.endsWith("贸易有")), "截图边界残缺名称不得进入规划");
  assert.ok(list.some(name => name.includes("温馨家园南门店")), "首图门店不得丢失");
  assert.ok(list.some(name => name.includes("松石支路二店")), "末图门店不得丢失");
}

// Case 2: a complete store repeated in the overlap is kept once.
{
  const first = HEADER + "\\n" + [
    "渝北A02230谊品生鲜温馨家园南门店",
    "江北钱大妈半山华府店"
  ].join(" -> ");
  const second = [
    "江北钱大妈半山华府店",
    "渝北Q398重庆沁园餐饮管理有限公司松石支路二店"
  ].join(" -> ") + "\\n运单号\\nZW20261028CZZC01884";

  const result = mergeStoreEdges([first, second], extract);
  assert.equal(names(result.stores).filter(name => name.includes("钱大妈半山华府店")).length, 1,
    "跨截图重叠门店只保留一份");
}

// Case 3: downstream identity dedupe remains conservative and does not collapse
// different OCR identities that happen to collide on one storeId.
{
  const same = dedupe([
    { rawName: "江北钱大妈半山华府店", name: "江北钱大妈半山华府店", storeId: "store-1" },
    { rawName: "江北钱大妈半山华府店", name: "江北钱大妈半山华府店", storeId: "store-1" }
  ]);
  assert.equal(same.items.length, 1);
  assert.equal(same.merged, 1);

  const conflict = dedupe([
    { rawName: "门店甲", name: "门店甲", storeId: "store-1" },
    { rawName: "门店乙", name: "门店乙", storeId: "store-1" }
  ]);
  assert.equal(conflict.items.length, 2, "不同识别身份不得因 storeId 冲突而吞店");
  assert.equal(conflict.items[1].pending, true, "身份冲突应转待确认");
}

// Case 4: a scrolling screenshot can repeat several complete stores, not just one.
// Trim the entire exact suffix/prefix overlap while preserving all unique stores.
{
  const first = HEADER + "\\n" + [
    "渝北A02230谊品生鲜温馨家园南门店",
    "渝北中景隆(重庆)贸易有限公司",
    "渝北钱大妈重庆东和春天店",
    "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)"
  ].join(" -> ");
  const second = [
    "渝北中景隆(重庆）贸易有限公司",
    "渝北钱大妈重庆东和春天店",
    "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)",
    "江北胡汪洋经销商(重庆胡建镜好食品有限公司)",
    "江北A02175谊品生鲜锦绣北滨路店"
  ].join(" -> ") + "\\n运单号\\nZW20261028CZZC01885";

  const result = mergeStoreEdges([first, second], extract);
  const list = names(result.stores);
  for (const needle of [
    "渝北中景隆(重庆)贸易有限公司",
    "渝北钱大妈重庆东和春天店",
    "江北重庆彩食鲜供应链发展有限公司(重庆中法供水有限公司花园新村)"
  ]) {
    assert.equal(list.filter(name => formatCompareKey(name) === formatCompareKey(needle)).length, 1,
      `overlap store should be kept once: ${needle}; actual: ${JSON.stringify(list)}`);
  }
  assert.ok(list.some(name => name.includes("江北胡汪洋经销商")), "second image unique store must remain");
  assert.ok(list.some(name => name.includes("锦绣北滨路店")), "last image unique store must remain");
}
console.log("✓ screenshot boundary continuation and overlap cleanup passed");
