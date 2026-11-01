/**
 * 智配One · 门店匹配引擎 v2
 * ------------------------------------------------------------------
 * 设计目标：宁可待定，不可错配。
 *
 * 旧版问题（已在真实回归中复现）：
 *   旧算法用「字符集合交并比」做相似度，对字序完全不敏感。
 *   - "天津万科城店" vs "津天科万城店"     → 1.000（识别乱序被判完全相同）
 *   - "店龙华华润万家" vs "华润万家龙华店"  → 1.000（识别错位噪声被判完全相同）
 *   - "星巴克深圳湾二店" vs "星巴克深圳湾店" → 0.875（可能是两家门店，被错误自动匹配）
 *   实测同一批 24 条用例中，旧算法产生 2 处假阳性，会导致运单品送错门店。
 *
 * 新版方案：多信号加权投票 + 硬性守门规则 + 显式置信差。
 *
 * 对外契约（process.js 依赖，保持不变）：
 *   clean / formatCompareKey / businessStoreCode / matchStores
 * 其中 formatCompareKey 保持「纯格式归一」语义不变，
 * 因其同时被去重与线路分段逻辑复用，不可篡改语义。
 */

/* ================================================================
 * 入口（P1-1g 拆分）：实现已按职责拆到三个兄弟模块，本文件只做转发，
 * 公开面与拆分前逐一对应（process.js / 各测试无需改动）。
 * ================================================================ */

export {clean, formatCompareKey, businessStoreCode, normalizeForMatch,
  stripGenericSuffix, stripRegionPrefix, DIGIT_SEQ} from "./_store-match-normalize.js";
export {editDistance, editSim, ngramSim, lcsRatio, pinyinKey} from "./_store-match-similarity.js";
export {scoreNames, MATCH_CONFIG, evaluate, matchOne, matchStores, createMatchIndex} from "./_store-match-engine.js";
export {default} from "./_store-match-engine.js";
