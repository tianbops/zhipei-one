/**
 * 待确认门店重复项回归测试
 * 只合并归一化后完全相同的待确认名称，不改变模糊匹配或 storeId 冲突保护。
 */
const { dedupe, plan, validateResult } = require("../functions/api/waybills/_process-plan.js");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " → " + extra : "")); }
}

const pending = dedupe([
  { rawName: "江北沁园 Q714轨道华新街店", name: "江北沁园 Q714轨道华新街店", storeId: null },
  { rawName: "江北沁园Q714轨道华新街店", name: "江北沁园Q714轨道华新街店", storeId: null },
  { rawName: "江北重庆彩食鲜供应链发展有限公司", name: "江北重庆彩食鲜供应链发展有限公司", storeId: null },
]);
t("相同待确认名称归一化后只保留一条", pending.items.length === 2, JSON.stringify(pending.items));
t("待确认重复计入合并数", pending.merged === 1);
t("不同待确认门店不会被合并", pending.items.some(x => x.rawName === "江北重庆彩食鲜供应链发展有限公司"));

const collision = dedupe([
  { rawName: "门店甲原始名称", name: "标准门店甲", storeId: "S001" },
  { rawName: "门店乙原始名称", name: "标准门店甲", storeId: "S001" },
  { rawName: "门店乙原始名称", name: "标准门店甲", storeId: "S001" },
]);
t("不同识别项争用同一 storeId 仍转待确认", collision.items.length === 2 && collision.items[1].pending === true && collision.items[1].storeId === null);
t("冲突后的相同待确认项不重复保留", collision.items.length === 2 && collision.merged === 1);
t("身份冲突仍有诊断记录", collision.conflicts.length === 2);

const planned = plan(pending.items, false).map((s, i) => ({ ...s, routeOrder: i + 1 }));
const valid = validateResult({ date: "2026-05-21", vehicle: "渝DK7692", stores: planned });
t("去重后的待确认门店可通过重复项校验", valid.valid, JSON.stringify(valid));

const distinct = dedupe([
  { rawName: "谊品生鲜长安锦绣城店", name: "谊品生鲜长安锦绣城店", storeId: null },
  { rawName: "谊品生鲜温馨家园南门店", name: "谊品生鲜温馨家园南门店", storeId: null },
]);
t("不同门店名称保留原样", distinct.items.length === 2 && distinct.merged === 0);

console.log("待确认门店重复项回归测试");
console.log("─".repeat(50));
if (failures.length) { console.log("失败项："); failures.forEach(f => console.log("  ✗ " + f)); console.log("─".repeat(50)); }
console.log("通过 " + pass + " / 失败 " + fail);
console.log(fail === 0 ? "✅ 全部通过" : "❌ 存在失败项");
process.exit(fail ? 1 : 0);
