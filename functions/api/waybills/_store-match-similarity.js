/**
 * 智配One · 门店匹配引擎 v2 —— 第 2 层：基础相似度算法
 * ------------------------------------------------------------------
 * 本文件由 _store-match.js 按职责拆分而来（P1-1g，函数体零改写）。
 * 纯函数集合：编辑距离 / n-gram Jaccard / LCS / 拼音首字母，可独立单测。
 */

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

export const editSim = (a, b) => {
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
export const ngramSim = (a, b, n = 2) => {
  const A = ngramSet(a, n), B = ngramSet(b, n);
  if (!A.size && !B.size) return 1;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return common / (A.size + B.size - common || 1);
};

/** 最长公共子序列比率（顺序敏感，抗插入删除） */
export function lcsRatio(a, b) {
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
export const pinyinKey = s =>
  [...s].map(ch => /[a-z0-9]/.test(ch) ? ch : (PINYIN_MAP[ch] || "")).join("");
