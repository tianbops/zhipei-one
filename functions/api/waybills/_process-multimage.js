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
     - 非首图：若首条与前图末条是同名重叠，丢弃重复项；若首条是前图残条的完整延续，则保留完整项
     - 每一张图的最后一条：仅当**证据**表明它是底部残条才丢弃（见下）
   重复合并与顺序规划交由后续 DEDUPE / PLAN 处理，本函数不做去重与排序。

   底部残条为何按证据判定、而非按图序位置：
     相册多选顺序不可靠，「含表头当首图」校正只保证第一张，其余图的先后仍可能
     颠倒（实测：中段图被当成末图，其底部残条“渝北中”逃过裁剪，卡进待定确认；
     而真正的末图反被当成中段，完整的末家门店差点被位置式规则误删）。
     残条的证据：它是一条**更长沙店名的前缀截断**——另一张图里存在某门店名，
     归一化后以它开头且明显更长；并且这个截断名没有在任何图里以完整形态出现
     （重叠区会有一模一样的完整副本，identical≥2 → 是完整真店，保留）。
     安全阀：isKnownStore(name) 为真（基准库完整门店，如“特渠部…委员会”与
     “特渠部…委员会（临时）”本就是前缀关系的两家真店）→ 绝不当作残条。

   @param {string[]} imageTexts 逐张截图的 OCR 文本（按上传顺序）
   @param {Function} extractFn 提取函数（默认 extract），便于测试注入
   @param {{isKnownStore?:Function}} opts isKnownStore(name)=>bool：基准库完整门店判定
   @returns {{stores:(Array|null), edgeTrimmed:number}} stores 为 null 表示不适用（单图）
*/
import { extract } from "./_process-extract.js";
import { formatCompareKey } from "./_store-match.js";

export function mergeStoreEdges(imageTexts, extractFn = extract, { isKnownStore = null } = {}) {
  if (!Array.isArray(imageTexts) || imageTexts.length < 2) return { stores: null, edgeTrimmed: 0 };
  /* 顺序校正（两级依据）：
     ① 「含表头（运输日期/车牌号/承运订单/总数量）」的当首图——相册多选顺序不可靠
       （实测出现过用户先选 06:05 中段图，导致首图判错：首图的第一条被误保留
       （状态栏+标题+门店），而真正首图的表头+首家门店反被当作“非首图第一条”
       丢弃 → 既留脏名又丢门店）。
     ② 「含运单号表格（ZW…编号网格）」的当末图——该表格只出现在路线列表末尾之后，
       用户只有滚到列表最后才拍得到（实测多张运单末图均为“路线行+运单号表格”）。
       没有它时，中段图与末图的先后无法判别（实测顺序颠倒导致中段图底部残条
       “渝北中”逃过裁剪卡进待定）。 */
  const isHeader = t => /运输日期|车牌号|承运订单|总数量\s*\d/.test(String(t || ""));
  const isTail = t => /\bZW\d{8}[A-Z0-9]+\b/i.test(String(t || ""));
  const rank = t => isHeader(t) ? 0 : (isTail(t) ? 2 : 1);
  const ordered = imageTexts
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(x => x.t);
  const perImage = ordered.map(t => {
    const one = extractFn(String(t || ""));
    return (one && one.stores) || [];
  });
  /* 底部残条证据：全量条目的归一化名中，是否存在「以它开头且明显更长」的版本，
     且它自身没有以完整形态出现在任何图里（重叠区会有一模一样的完整副本）。 */
  const allKeys = [];
  for (const stores of perImage) {
    for (const s of stores) {
      const k = formatCompareKey((s && (s.rawName || s.name)) || "");
      if (k) allKeys.push(k);
    }
  }
  const isBottomResidue = name => {
    const k = formatCompareKey(name || "");
    if (!k) return false;
    if (typeof isKnownStore === "function" && isKnownStore(name)) return false;
    let identical = 0;
    let extended = false;
    for (const n of allKeys) {
      if (n === k) identical++;
      else if (n.startsWith(k) && n.length - k.length >= 2) extended = true;
    }
    /* 证据安全性：若它是完整真店，下一张图的重叠区必有完整副本（identical≥2 → 保留）；
       「有延长版 + 无完整副本」只有截断才同时满足。基准库 predicate 在此之上再兜一层
       （防同名前缀关系的真店对，如 特渠部…委员会 / 特渠部…委员会（临时））。 */
    return extended && identical <= 1;
  };
  const merged = [];
  const processedPerImage = [];
  let edgeTrimmed = 0;
  /* 底部残条删除 = 证据规则（所有图生效）+ 位置式兜底（仅图序可靠时）。
     证据规则：有「以它开头的更长门店名」且无完整副本 → 残条。
     位置式兜底：有运单号表格（末图依据）时，非末图的末条几乎必是残条；但
       - 只在「有基准库可查」（isKnownStore 为函数）时才启用——否则会误删
         临时线路/全局学习场景的完整末店；
       - 且绝不删基准库完整门店（重复拍末图时，前一张的末条是完整门店，
         位置式兜底若不加这道闸会把它与后一张的顶部重叠副本一起删掉 → 丢店）。 */
  const hasTailMarker = ordered.some(t => isTail(t));
  const hasBase = typeof isKnownStore === "function";
  for (let idx = 0; idx < perImage.length; idx++) {
    let stores = perImage[idx];
    if (!stores.length) continue;
    if (idx > 0 && stores.length) {
      // 必须使用前一张图经过边界处理后的条目，而不是原始 perImage：
      // 前图底部残条已经被剔除，不能再参与后图的重叠匹配。
      const previousStores = processedPerImage[idx - 1] || [];
      const keyOf = item => formatCompareKey(item?.rawName || item?.name || "");
      // 只匹配严格连续的「前图后缀 = 本图前缀」，不跨过任何不同门店。
      const findOverlap = candidates => {
        const maxOverlap = Math.min(previousStores.length, candidates.length);
        for (let count = maxOverlap; count >= 1; count--) {
          let equal = true;
          for (let offset = 0; offset < count; offset++) {
            const left = keyOf(previousStores[previousStores.length - count + offset]);
            const right = keyOf(candidates[offset]);
            if (!left || left !== right) { equal = false; break; }
          }
          if (equal) return count;
        }
        return 0;
      };
      let overlapCount = findOverlap(stores);
      if (overlapCount > 0) {
        stores = stores.slice(overlapCount);
        edgeTrimmed += overlapCount;
      } else {
        const firstKey = keyOf(stores[0]);
        const previous = previousStores[previousStores.length - 1];
        const previousKey = keyOf(previous);
        // 上一张底部是名称前缀残片、下一张顶部是完整名称时，保留完整项。
        // 底部残片由 isBottomResidue 根据「更长名称前缀」证据删除。
        const completesPrevious = !!previousKey && firstKey.startsWith(previousKey)
          && firstKey.length - previousKey.length >= 2;
        if (!completesPrevious) {
          // 保留既有顶部残条兜底行为。关键补充：移除首条后再检查一次连续重叠，
          // 可处理「顶部残条 + 后续多家重复门店」；若中间插入不同门店，
          // findOverlap 会因不连续而停止，绝不会跳过该门店跨项裁剪。
          stores = stores.slice(1);
          edgeTrimmed++;
          overlapCount = findOverlap(stores);
          if (overlapCount > 0) {
            stores = stores.slice(overlapCount);
            edgeTrimmed += overlapCount;
          }
        }
      }
    }
    const last = stores[stores.length - 1];
    const lastKey = last && (last.rawName || last.name);
    const positional = hasTailMarker && hasBase && idx < perImage.length - 1
      && !isKnownStore(lastKey);
    if (stores.length && (positional || isBottomResidue(lastKey))) {
      stores = stores.slice(0, -1); edgeTrimmed++;                                // 底部残条
    }
    processedPerImage[idx] = stores;
    for (const s of stores) merged.push(s);
  }
  return { stores: merged.length ? merged : null, edgeTrimmed };
}
