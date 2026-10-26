/* 多张截图（同一运单分段拍摄）门店条目合并
   ------------------------------------------------------------------
   背景：长运单一屏放不下，需要分段截图。每张图的上下边缘都会把某家门店名截断：
     - 非首图顶部：上一家门店的后半截（可能只是缺前缀，看起来像完整店名）
     - 非末图底部：最后一家门店的前半截
     - 末图底部：完整（用户滚到列表末尾才拍）
   相邻两张之间必定存在重叠门店（屏幕滚动有重叠区），因此被截断的那家店一定在
   相邻图里有完整版本 —— 剔除边界残条不会造成门店丢失，反而能避免残条变成
   “缺前缀的假门店”或与完整版并存造成重复。

   规则：
     - 非首图：丢弃第一条（顶部残条）
     - 非末图：丢弃最后一条（底部残条）
     - 末图末尾：保留
   重复合并与顺序规划交由后续 DEDUPE / PLAN 处理，本函数不做去重与排序。

   @param {string[]} imageTexts 逐张截图的 OCR 文本（按上传顺序）
   @param {Function} extractFn 提取函数（默认 extract），便于测试注入
   @returns {{stores:(Array|null), edgeTrimmed:number}} stores 为 null 表示不适用（单图）
*/
import { extract } from "./_process-extract.js";

export function mergeStoreEdges(imageTexts, extractFn = extract) {
  if (!Array.isArray(imageTexts) || imageTexts.length < 2) return { stores: null, edgeTrimmed: 0 };
  const merged = [];
  let edgeTrimmed = 0;
  for (let idx = 0; idx < imageTexts.length; idx++) {
    const one = extractFn(String(imageTexts[idx] || ""));
    let stores = (one && one.stores) || [];
    if (!stores.length) continue;
    if (idx > 0) { stores = stores.slice(1); edgeTrimmed++; }                     // 顶部残条
    if (idx < imageTexts.length - 1 && stores.length) { stores = stores.slice(0, -1); edgeTrimmed++; } // 底部残条
    for (const s of stores) merged.push(s);
  }
  return { stores: merged.length ? merged : null, edgeTrimmed };
}
