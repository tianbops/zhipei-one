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
 * 对外契约（process.js / store-learn.js 依赖，保持不变）：
 *   clean / formatCompareKey / businessStoreCode / matchStores
 * 其中 formatCompareKey 保持「纯格式归一」语义不变，
 * 因其同时被去重与线路分段逻辑复用，不可篡改语义。
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
const stripGenericSuffix = s =>
  s.replace(/(?:分店|门店|专卖店|连锁店|便利店|超市|商场|广场|店)+$/g, "");

/** 剥离行政区前缀噪声 */
const stripRegionPrefix = s =>
  s.replace(/^(?:中国|广东省|深圳市|广州市|东莞市|佛山市|北京市|上海市|珠海市|中山市)/g, "");

/** 数字 / 序号字符 */
const DIGIT_SEQ = /[0-9０-９一二三四五六七八九十百]/g;

/* ================================================================
 * 第 2 层：基础相似度算法（纯函数，可单测）
 * ================================================================ */

/** Levenshtein 编辑距离（滚动数组 + 长度差提前退出） */
export function editDistance(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  if (Math.abs(la - lb) > 12) return Math.max(la, lb);
  let prev = new Uint16Array(lb + 1);
  let curr = new Uint16Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const t = prev; prev = curr; curr = t;
  }
  return prev[lb];
}

const editSim = (a, b) => {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a, b) / max : 1;
};

/** 字符 n-gram Jaccard 相似度（对局部顺序敏感） */
function ngramSet(s, n) {
  const out = new Set();
  if (s.length < n) { if (s) out.add(s); return out; }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}
const ngramSim = (a, b, n = 2) => {
  const A = ngramSet(a, n), B = ngramSet(b, n);
  if (!A.size && !B.size) return 1;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return common / (A.size + B.size - common || 1);
};

/** 最长公共子序列比率（顺序敏感，抗插入删除） */
function lcsRatio(a, b) {
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  let prev = new Uint16Array(lb + 1), curr = new Uint16Array(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = 0;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      curr[j] = ca === b.charCodeAt(j - 1)
        ? prev[j - 1] + 1
        : (prev[j] > curr[j - 1] ? prev[j] : curr[j - 1]);
    }
    const t = prev; prev = curr; curr = t;
  }
  return prev[lb] / Math.max(la, lb);
}

/**
 * 汉字拼音首字母（轻量内联映射，零依赖、不引入字典文件）
 * 仅作辅助信号，主判定不依赖它。
 */
const PY_PAIRS = "深s圳z广g州z北b京j上s海h天t津j重c庆q杭h南n宁n武w汉h成c都d西x安a长c沙s福f厦x门m昆k明m合h肥f济j郑z太t原y石s家j庄z哈h尔e滨b沈s阳y大d连l青q岛d苏s无w锡x常c波b温w嘉j兴x金h台t珠z中山东莞g佛汕头惠肇万w科k城c店华润r永辉超市沃玛星巴克罗l利发乐梅林龙岗坂田宝場场便二分号";
const PINYIN_MAP = (() => {
  const m = Object.create(null);
  for (let i = 0; i + 1 < PY_PAIRS.length; i += 2) {
    const ch = PY_PAIRS[i], py = PY_PAIRS[i + 1];
    if (/[a-z]/.test(py)) m[ch] = py;
  }
  return m;
})();
const pinyinKey = s =>
  [...s].map(ch => /[a-z0-9]/.test(ch) ? ch : (PINYIN_MAP[ch] || "")).join("");

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
  if (Math.min(A.length, B.length) >= 4 && (A.includes(B) || B.includes(A))) {
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

  const sa = A.replace(DIGIT_SEQ, "");
  const sb = B.replace(DIGIT_SEQ, "");
  if (sa !== sb) return null; // 差异不止来自数字，交由常规评分处理

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
    const isFormatOnly =
      formatCompareKey(rawName) === formatCompareKey(standard) ||
      identityFields(target).some(f => formatCompareKey(f) === formatCompareKey(rawName));

    return {
      ...item,
      rawName,
      storeId: clean(target.storeId),
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
