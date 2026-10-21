/**
 * 智配One · 门店匹配引擎 v2 —— 第 0/1 层：格式归一
 * ------------------------------------------------------------------
 * 本文件由 _store-match.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 对外契约保持不变：clean / formatCompareKey / businessStoreCode /
 * normalizeForMatch 仍从 _store-match.js 入口导出。
 * formatCompareKey 保持「纯格式归一」语义不变（去重与线路分段复用，不可篡改）。
 */

export const clean = v => String(v ?? "").trim();

/* ================================================================
 * 第 0 层：格式归一（保持旧语义，供去重 / 分段复用）
 * ================================================================ */

export const formatCompareKey = v => {
  let s = clean(v);
  try { s = s.normalize("NFKC"); } catch {}
  return s
    .replace(/[\s\p{Z}\p{Cf}\p{P}\p{S}]+/gu, "")
    .replace(/Ⅱl|Il|II|ⅱ/gi, "II")
    .toLowerCase();
};

export const businessStoreCode = v => {
  const m = clean(v).match(/(?:^|[^A-Z0-9])(JM|A|Q)[\p{Pd}_ ]?(\d{3,12})(?=$|[^A-Z0-9])/i);
  return m ? (m[1] + m[2]).toUpperCase() : null;
};

/* ================================================================
 * 第 1 层：匹配专用归一（仅用于评分，不影响对外契约）
 * ================================================================ */

/** 基础归一：全角半角、空白（含 OCR 断行 \n、制表符）、括号、标点、罗马数字 */
export const normalizeForMatch = v => {
  let s = clean(v);
  try { s = s.normalize("NFKC"); } catch {}
  return s
    .replace(/[\s\p{Z}\p{Cf}]+/gu, "")
    .replace(/[（）()【】\[\]{}<>《》「」『』""''‘’]/g, "")
    .replace(/[·•、,，。；;:：!！?？\-_—~～|/\\]/g, "")
    .replace(/Ⅱ|ⅱ/gi, "II")
    .replace(/Ⅲ|ⅲ/gi, "III")
    .toLowerCase();
};

/** 剥离通用业态后缀（店 / 超市 / 商场…），用于「主体」比较 */
export const stripGenericSuffix = s =>
  s.replace(/(?:分店|门店|专卖店|连锁店|便利店|超市|商场|广场|店)+$/g, "");

/** 剥离行政区前缀噪声 */
export const stripRegionPrefix = s =>
  s.replace(/^(?:中国|广东省|深圳市|广州市|东莞市|佛山市|北京市|上海市|珠海市|中山市)/g, "");

/** 数字 / 序号字符 */
export const DIGIT_SEQ = /[0-9０-９一二三四五六七八九十百]/g;
