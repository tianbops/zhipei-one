/**
 * 智配One · 门店匹配引擎 v2 —— 第 3/4/5 层：评分 + 守门 + 对外主入口
 * ------------------------------------------------------------------
 * 本文件由 _store-match.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 依赖：_store-match-normalize.js（归一）、_store-match-similarity.js（相似度）。
 * 对外契约：matchStores / matchOne / evaluate / scoreNames / MATCH_CONFIG。
 */

import {clean, formatCompareKey, businessStoreCode, normalizeForMatch,
  stripGenericSuffix, stripRegionPrefix, DIGIT_SEQ} from "./_store-match-normalize.js";
import {editDistance, editSim, ngramSim, lcsRatio, pinyinKey} from "./_store-match-similarity.js";

/* ================================================================
 * 第 3 层：综合评分
 * ================================================================ */

export function scoreNames(raw, target) {
  const A = normalizeForMatch(raw);
  const B = normalizeForMatch(target);
  if (!A || !B) return { score: 0, signals: {} };
  if (A === B) return { score: 1, signals: { exact: 1 } };

  const aBody = stripGenericSuffix(stripRegionPrefix(A));
  const bBody = stripGenericSuffix(stripRegionPrefix(B));

  // 主体完全一致（仅业态后缀差异）→ 同一门店
  // 主体长度需 >= 3，避免 "A店" vs "B店" 退化情形
  if (aBody && bBody && aBody === bBody && aBody.length >= 3) {
    return { score: 0.97, signals: { bodyExact: 1 } };
  }

  // 互相包含（OCR 漏字 / 带路线段前缀，如
  //   "渝北JM03050谊品生鲜温馨家园南门店" ⊃ "谊品生鲜温馨家园南门店"）
  // 短串 >= 4 字时视为同一门店的强信号，直接给到自动匹配档；
  // 空格 / 断行已在归一层剥离，不参与差异。
  const containedAt = A.indexOf(B);
  const containedPrefix = containedAt >= 0 ? A.slice(0, containedAt) : "";
  const safeContainmentPrefix = Boolean(businessStoreCode(raw)) ||
    (Boolean(containedPrefix) && stripRegionPrefix(containedPrefix) === "") ||
    /(?:运输日期|运单日期|配送日期|日期|车牌号|车牌|总重量|重量|司机|配送员|驾驶员|送货员)/.test(containedPrefix);
  if (A.length >= B.length && B.length >= 4 && containedAt >= 0 &&
      A.endsWith(B) && safeContainmentPrefix) {
    return { score: 0.92, signals: { containment: 1 } };
  }

  const sEdit   = editSim(A, B);
  const sBody   = (aBody && bBody) ? editSim(aBody, bBody) : 0;
  const sGram   = ngramSim(A, B, 2);
  const sGram3  = ngramSim(A, B, 3);
  const sLcs    = lcsRatio(A, B);
  const pa = pinyinKey(A), pb = pinyinKey(B);
  const sPinyin = (pa && pb) ? editSim(pa, pb) : 0;

  const score =
      0.20 * sEdit
    + 0.22 * sBody
    + 0.16 * sGram
    + 0.14 * sGram3
    + 0.20 * sLcs
    + 0.08 * sPinyin;

  return { score, signals: { sEdit, sBody, sGram, sGram3, sLcs, sPinyin } };
}

/* ================================================================
 * 第 4 层：守门规则（拦截危险匹配）
 * ================================================================ */

/**
 * 疑似乱序检测：字符集合高度重合，但相邻关系几乎不重合。
 * 用于拦截识别乱序 / 错位产生的伪门店名。
 */
function looksLikeShuffled(A, B) {
  if (A === B) return false;
  if (A.length < 4 || B.length < 4) return false;
  const setA = new Set(A), setB = new Set(B);
  let common = 0;
  for (const c of setA) if (setB.has(c)) common++;
  const setSim = common / (new Set([...setA, ...setB]).size || 1);
  const gramSim = ngramSim(A, B, 2);
  return setSim >= 0.95 && gramSim < 0.45;
}

/**
 * 数字差异分类：
 *   "suffix" → 差异仅来自末尾序号（梅林店 / 梅林二店），属同店别称写法
 *   "core"   → 数字位于主体位置（1号店 / 2号店），可能是不同门店，需人工确认
 *   null     → 无纯数字差异
 */
function divergentNumberKind(A, B) {
  const na = (A.match(DIGIT_SEQ) || []).join("");
  const nb = (B.match(DIGIT_SEQ) || []).join("");
  if (na === nb) return null;

  // “2号店”与“店”在删除数字后仍会差一个“号”；先去掉紧邻门店后缀的“号”，
  // 才能识别这是门店编号差异，不能让它绕过不同门店编号的人工确认守门。
  const stripNumberMarker = value => value
    .replace(DIGIT_SEQ, "")
    .replace(/号(?=(?:分店|门店|专卖店|便利店|营业点|店)?$)/g, "");
  const sa = stripNumberMarker(A);
  const sb = stripNumberMarker(B);
  if (sa !== sb && stripGenericSuffix(sa) !== stripGenericSuffix(sb)) return null; // 仅通用门店后缀差异可忽略；主体差异仍交由常规评分处理

  // 仅当编号数字本身位于名称末尾时才视为可容忍的尾随编号；
  // “二店 / 2号店”中的编号仍在“店”前，必须按可能的不同门店处理。
  const tail = /[0-9０-９一二三四五六七八九十百]+$/;
  const tailOnly = Boolean(tail.test(A) || tail.test(B)) && Math.min(sa.length, sb.length) >= 3;
  return tailOnly ? "suffix" : "core";
}

export const MATCH_CONFIG = {
  /** 自动匹配阈值：低于此值一律进入待定，交人工确认 */
  AUTO_MATCH: 0.90,
  /** 与次优候选的最小分差：分差过小说明存在歧义，进入待定 */
  MIN_CONFIDENCE_GAP: 0.05,
  /** 进入候选列表（供人工选择）的下限 */
  CANDIDATE_FLOOR: 0.70,
  /** 候选列表最多返回条数 */
  MAX_CANDIDATES: 5,
};

/** 单对评分 + 守门 */
export function evaluate(raw, target) {
  const A = normalizeForMatch(raw);
  const B = normalizeForMatch(target);
  const { score, signals } = scoreNames(raw, target);

  const numberKind = divergentNumberKind(A, B);
  const flags = {
    shuffled: looksLikeShuffled(A, B),
    numberDiff: numberKind === "core",
    suffixNumber: numberKind === "suffix",
  };

  let final = score;
  let blocked = false;
  let blockReason = null;

  if (flags.shuffled) {
    blocked = true;
    blockReason = "字符顺序严重不一致（疑似识别乱序或不同门店）";
    final = Math.min(final, 0.5);
  } else if (flags.numberDiff) {
    final = Math.min(final, 0.65);
    blockReason = "主体编号不一致，需人工确认";
  } else if (flags.suffixNumber) {
    // 末尾序号差异（同店别称写法）小幅加分，但仍须满足阈值
    final = Math.min(1, final + 0.10);
  }

  return { score: final, rawScore: score, signals, flags, blocked, blockReason };
}

/* ================================================================
 * 第 5 层：对外主入口
 * ================================================================ */

const identityValue = v => clean(v).split(/\s*[•·]\s*/)[0].trim();

const identityFields = s => [
  s?.name,
  s?.originalName,
  ...(Array.isArray(s?.aliases) ? s.aliases : []),
].map(identityValue).filter(Boolean);

const fmtCandidate = x => ({
  storeId: clean(x.store?.storeId),
  name: clean(x.store?.name || x.store?.originalName),
  score: Number(x.score.toFixed(3)),
  matchedName: x.matchedName || null,
  reason: x.blockReason || null,
});

/**
 * 单门店匹配（带置信判定）。
 * 返回 { status:"matched", store, score, signals, candidates }
 *   或 { status:"pending", reason, candidates }
 */
export function matchOne(rawName, baseStores) {
  const stores = Array.isArray(baseStores) ? baseStores : [];
  const scored = [];

  for (const store of stores) {
    let best = null;
    for (const n of identityFields(store)) {
      const r = evaluate(rawName, n);
      if (!best || r.score > best.score) best = { ...r, matchedName: n };
    }
    if (!best || best.blocked) continue;
    if (best.score < MATCH_CONFIG.CANDIDATE_FLOOR) continue;
    scored.push({ store, ...best });
  }

  scored.sort((a, b) => b.score - a.score);

  const top1 = scored[0] || null;
  const top2 = scored[1] || null;
  const candidates = scored.slice(0, MATCH_CONFIG.MAX_CANDIDATES).map(fmtCandidate);
  const topScore = top1 ? Number(top1.score.toFixed(3)) : null;
  const secondScore = top2 ? Number(top2.score.toFixed(3)) : null;
  const scoreGap = top1 ? Number((top1.score - (top2?.score ?? 0)).toFixed(3)) : null;
  const candidateCount = candidates.length;

  if (!top1) {
    return { status: "pending", reason: "no_candidate", candidateCount: 0, topScore: null, secondScore: null, scoreGap: null, candidates: [], confidence: { level: "PENDING", reason: "no_candidate", score: null, candidateCount: 0, topScore: null, secondScore: null, scoreGap: null } };
  }
  if (top1.score < MATCH_CONFIG.AUTO_MATCH) {
    return { status: "pending", reason: "below_threshold", candidateCount, topScore, secondScore, scoreGap, candidates, confidence: { level: "PENDING", reason: "below_threshold", score: topScore, candidateCount, topScore, secondScore, scoreGap } };
  }
  if (top2 && top1.score - top2.score < MATCH_CONFIG.MIN_CONFIDENCE_GAP) {
    return { status: "pending", reason: "ambiguous", candidateCount, topScore, secondScore, scoreGap, candidates, confidence: { level: "PENDING", reason: "ambiguous（候选分差过小）", score: topScore, candidateCount, topScore, secondScore, scoreGap } };
  }
  return {
    status: "matched",
    store: top1.store,
    score: top1.score,
    signals: top1.signals,
    matchedName: top1.matchedName,
    candidates,
    candidateCount,
    topScore,
    secondScore,
    scoreGap,
    confidence: {
      level: top1.score >= 0.95 ? "HIGH" : "MEDIUM",
      reason: top1.score >= 0.95 ? "高度相似（主体一致）" : "相似度达标（自动匹配）",
      score: topScore,
      candidateCount,
      topScore,
      secondScore,
      scoreGap,
      signals: top1.signals,
    },
  };
}

/**
 * 批量匹配（替代旧版 matchStores，输出字段保持兼容）。
 *
 * 匹配优先级（与架构契约一致）：
 *   1. 身份 ID（storeId 直匹配）
 *   2. 业务门店编码（JM/A/Q + 数字）
 *   3. 精确名称 / 别名（格式归一后相等）
 *   4. 受控相似度 + 守门 + 置信差，否则进入待定
 */
export function matchStores(items, baseStores) {
  const stores = Array.isArray(baseStores) ? baseStores : [];

  // 同一张运单内的身份占用保护：
  // 不同原始识别项如果最终争用同一个 storeId，不能让后续 dedupe
  // 因标准化 name 相同而把它们吞掉。真正相同的 OCR 重复项仍允许正常去重。
  const occupiedStoreIds = new Map();

  // ---- 索引构建 ----
  const byId = new Map();
  const byCode = new Map();
  const byExactKey = new Map();

  /** 同名冲突（指向不同 storeId）时置 null，避免错误收敛 */
  const markUnique = (map, key, store) => {
    if (!key) return;
    if (!map.has(key)) { map.set(key, store); return; }
    const cur = map.get(key);
    if (cur && clean(cur.storeId) !== clean(store.storeId)) map.set(key, null);
  };

  for (const store of stores) {
    const id = clean(store?.storeId);
    if (id) byId.set(id, store);

    for (const field of identityFields(store)) {
      markUnique(byExactKey, formatCompareKey(field), store);
    }
    // 业务门店编码索引：必须同时覆盖 store.businessStoreCode 正式字段
    // （base.js 会写入该字段；旧版遗漏此项，导致带编码的门店无法按编码匹配）
    for (const field of [store?.storeId, store?.name, store?.originalName, store?.businessStoreCode, ...(Array.isArray(store?.aliases) ? store.aliases : [])]) {
      markUnique(byCode, businessStoreCode(field), store);
    }
  }

  return (items || []).map((item, index) => {
    const rawName = clean(item?.rawName || item?.name);
    const incomingId = clean(item?.storeId);
    const incomingCode =
      businessStoreCode(rawName) ||
      businessStoreCode(item?.name) ||
      businessStoreCode(incomingId);

    let target = null;
    let method = null;

    // 1. 身份 ID
    if (incomingId && byId.has(incomingId)) {
      target = byId.get(incomingId);
      method = "identity";
    }

    // 2. 业务门店编码
    if (!target && incomingCode) {
      const hit = byCode.get(incomingCode);
      if (hit) { target = hit; method = "identity-code"; }
    }

    // 3. 精确名称 / 别名
    if (!target) {
      const exact = byExactKey.get(formatCompareKey(rawName));
      if (exact) { target = exact; method = "data-exact"; }
    }

    // 4. 受控相似度
    let confidence = null;
    if (!target) {
      const r = matchOne(rawName, stores);
      if (r.status === "matched") {
        target = r.store;
        method = "similarity";
        confidence = { score: Number(r.score.toFixed(3)), signals: r.signals, matchedName: r.matchedName };
      } else {
        return {
          ...item,
          rawName,
          name: rawName,
          storeId: null,
          routeOrder: 100000 + index,
          matchStatus: "pending",
          matchMethod: null,
          correction: false,
          pending: true,
          candidates: r.candidates || [],
          matchConfidence: r.confidence || {
            level: "PENDING",
            reason: r.reason || "no_candidate",
            score: r.topScore ?? null,
            candidateCount: r.candidateCount || 0,
            topScore: r.topScore ?? null,
            secondScore: r.secondScore ?? null,
            scoreGap: r.scoreGap ?? null,
          },
          matchDiagnostics: {
            baseStoreCount: stores.length,
            reason: r.reason || "no_candidate",
            compareKey: formatCompareKey(rawName),
          },
        };
      }
    }

    const standard = clean(target.name) || rawName;
    const targetStoreId = clean(target.storeId);
    const rawIdentityKey = formatCompareKey(rawName);
    const prior = targetStoreId ? occupiedStoreIds.get(targetStoreId) : null;

    // 关键安全规则：
    // A、B 是不同原始识别项，但都被匹配到同一个 storeId。
    // 不能把 B 继续标成 matched，否则后续标准化 name 会一样并被 dedupe 吞掉。
    // 保留 B 为待定，交人工确认；绝不自动丢失门店。
    if (targetStoreId && prior && prior.identityKey !== rawIdentityKey) {
      return {
        ...item,
        rawName,
        storeId: null,
        name: rawName,
        originalName: rawName,
        routeOrder: 100000 + index,
        matchStatus: "pending",
        matchMethod: null,
        correction: false,
        pending: true,
        candidates: [{
          storeId: targetStoreId,
          name: standard,
          score: method === "similarity" ? (confidence?.score ?? null) : 1,
          reason: "同一运单中不同识别项指向同一门店，存在身份冲突",
        }],
        matchConfidence: {
          level: "PENDING",
          reason: "STORE_ID_COLLISION",
          score: method === "similarity" ? (confidence?.score ?? null) : 1,
          candidateCount: 1,
          topScore: method === "similarity" ? (confidence?.score ?? null) : 1,
          secondScore: null,
          scoreGap: null,
        },
        matchDiagnostics: {
          baseStoreCount: stores.length,
          reason: "STORE_ID_COLLISION",
          rawName,
          previousRawName: prior.rawName,
          storeId: targetStoreId,
        },
      };
    }

    if (targetStoreId) {
      occupiedStoreIds.set(targetStoreId, {identityKey: rawIdentityKey, rawName});
    }

    const isFormatOnly =
      formatCompareKey(rawName) === formatCompareKey(standard) ||
      identityFields(target).some(f => formatCompareKey(f) === formatCompareKey(rawName));

    return {
      ...item,
      rawName,
      storeId: targetStoreId,
      name: standard,
      originalName: clean(target.originalName) || rawName,
      routeOrder: Number(target.routeOrder) || index + 1,
      matchStatus: "matched",
      matchMethod: method,
      matchConfidence: method === "similarity" && confidence ? confidence : {
        level: "HIGH",
        reason: method === "identity" || method === "identity-code" ? "身份ID/业务编码精确匹配" : "门店名称精确匹配",
        score: method === "similarity" ? (confidence?.score ?? null) : 1,
        candidateCount: method === "similarity" ? (confidence?.candidateCount ?? 0) : 0,
        topScore: method === "similarity" ? (confidence?.topScore ?? null) : 1,
        secondScore: method === "similarity" ? (confidence?.secondScore ?? null) : null,
        scoreGap: method === "similarity" ? (confidence?.scoreGap ?? null) : null,
        signals: method === "similarity" ? (confidence?.signals ?? null) : { exact: 1 },
      },
      navigation: clean(target.navigation || item.navigation),
      note: clean(target.note || target.remark || item.note || item.remark),
      correction: method === "similarity" ? true : !isFormatOnly,
      pending: false,
      candidates: [],
    };
  });
}

export default {
  matchStores,
  matchOne,
  evaluate,
  scoreNames,
  editDistance,
  MATCH_CONFIG,
  clean,
  formatCompareKey,
  businessStoreCode,
};
