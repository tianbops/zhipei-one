/* 待定门店「丢弃」出口的守卫（防止被后续改动误删）
   背景：运单截图里的噪声（运单号表格、拍错残条）会变成待定门店，而确认界面原先
   只接受 merge / new —— 遇到噪声只能错误合并或新建假门店，用户被迫取消整单。
   现增加 discard：确认时直接剔除该条目，既不合并也不新增。
   本测试做静态守卫（真实流程由 integration-waybill-lifecycle 等集成测试覆盖）。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backend = readFileSync(new URL("../functions/api/waybills/confirm.js", import.meta.url), "utf8");
const frontend = readFileSync(new URL("../js/order_detail/confirm.js", import.meta.url), "utf8");

// 1) 后端：动作校验必须放行 discard
{
  const m = backend.match(/action!=="merge"&&action!=="new"&&action!=="discard"/);
  assert.ok(m, "后端必须允许 discard 动作");
  console.log("✅ 后端动作校验放行 discard");
}

// 2) 后端：discard 分支要真正剔除条目（记录 index 并跳过合并/新增）
{
  assert.ok(/action==="discard"\)\{discarded\.add\(index\);continue;\}/.test(backend),
    "后端必须有 discard 分支（记录索引并跳过后续处理）");
  assert.ok(/keptStores=discarded\.size\?stores\.filter/.test(backend),
    "被丢弃的条目不得进入后续去重/排序/落库");
  console.log("✅ 后端 discard 真正剔除条目");
}

// 3) 后端：丢弃数量计入 summary（便于诊断核对）
{
  assert.ok(/discarded:\(Number\(order\.summary\?\.discarded\)\|\|0\)\+discarded\.size/.test(backend),
    "丢弃数量应计入 order.summary.discarded");
  console.log("✅ 丢弃数量计入 summary");
}

// 4) 前端：每条待定门店必须有「丢弃」选项
{
  assert.ok(/action:'discard'/.test(frontend), "前端必须提供 discard 选项");
  assert.ok(/丢弃（不是门店）/.test(frontend), "丢弃按钮文案应明确「不是门店」");
  console.log("✅ 前端提供丢弃选项");
}

console.log("\n✅ confirm-discard 全部通过");
