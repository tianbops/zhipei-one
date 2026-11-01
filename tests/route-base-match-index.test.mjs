import assert from "node:assert/strict";
import { matchStores, formatCompareKey } from "../functions/api/waybills/_store-match.js";
import { readFileSync } from "node:fs";
import { baseIdentityNames, createRouteBaseIndex, getCachedRouteBaseIndex, splitByRouteBase } from "../functions/api/waybills/_process-plan.js";

const baseApi = readFileSync(new URL("../functions/api/base.js", import.meta.url), "utf8");
const confirmApi = readFileSync(new URL("../functions/api/waybills/confirm.js", import.meta.url), "utf8");
const routesApi = readFileSync(new URL("../functions/api/routes.js", import.meta.url), "utf8");
assert.match(baseApi, /version:\(old\.version\|\|1\)\+1/, "manual base updates must increment the cache version");
assert.match(confirmApi, /base\.version=\(Number\(base\.version\)\|\|1\)\+1/, "learning confirmation must increment the cache version");
assert.match(confirmApi, /redis\.call\("SET",KEYS\[4\],ARGV\[3\]\)/, "learning confirmation must atomically persist the versioned base snapshot");
assert.match(routesApi, /const base=\{routeId:id,version:1,updatedAt:now/, "new route bases must begin at version 1");


function legacySplitByRouteBase(items, baseStores) {
  const bases = Array.isArray(baseStores) ? baseStores : [];
  if (!bases.length) return items;
  return items.flatMap(item => {
    const rawName = String(item?.rawName || item?.name || "").trim();
    const rawKey = formatCompareKey(rawName);
    const hits = [];
    for (const store of bases) {
      for (const name of baseIdentityNames(store)) {
        const key = formatCompareKey(name);
        if (key.length >= 4 && rawKey.includes(key)) hits.push({ store, name, key, pos: rawKey.indexOf(key) });
      }
    }
    const unique = new Map();
    for (const hit of hits) {
      const id = String(hit.store?.storeId || "").trim() || hit.key;
      const old = unique.get(id);
      if (!old || hit.key.length > old.key.length) unique.set(id, hit);
    }
    const candidates = [...unique.values()].sort((a, b) => b.key.length - a.key.length || a.pos - b.pos);
    const selected = [];
    for (const candidate of candidates) {
      const start = candidate.pos, end = start + candidate.key.length;
      const overlaps = selected.some(hit => start < hit.pos + hit.key.length && hit.pos < end);
      if (!overlaps) selected.push(candidate);
    }
    selected.sort((a, b) => a.pos - b.pos || b.key.length - a.key.length);
    if (selected.length < 2) return [item];
    return selected.map((hit, index) => ({
      ...item, rawName: hit.name, name: hit.name,
      storeId: String(hit.store?.storeId || "").trim() || null,
      extractionMethod: "route-base-segment",
      extractionSegment: index + 1,
      extractionSegments: selected.length
    }));
  });
}

const baseStores = [
  { storeId: "S001", name: "渝北JM03131谊品生鲜长安锦绣城店", originalName: "谊品生鲜长安锦绣城店", aliases: ["长安锦绣城谊品"], businessStoreCode: "JM03131", routeOrder: 1, navigation: "nav-1" },
  { storeId: "S002", name: "江北重庆三峡融资担保集团有限公司", originalName: "重庆三峡融资担保集团有限公司", aliases: ["三峡融资担保"], routeOrder: 2 },
  { storeId: "S003", name: "渝北格意东和春天店", originalName: "格意东和春天店", aliases: [], routeOrder: 3 },
  { storeId: "S004", name: "江北沁园Q568东方家园店", originalName: "沁园东方家园店", aliases: ["东方家园沁园"], businessStoreCode: "Q568", routeOrder: 4 },
  { storeId: "S005", name: "江北重庆三峡融资担保集团有限公司（支部）", originalName: "重庆三峡融资担保集团有限公司（支部）", aliases: [], routeOrder: 5 }
];
const items = [
  { rawName: "渝北JM03131谊品生鲜长安锦绣城店" },
  { rawName: "三峡融资担保" },
  { rawName: "格意东和春天店" },
  { rawName: "江北沁园Q568东方家园店" },
  { rawName: "完全无关的门店名称" },
  { rawName: "渝北JM03131谊品生鲜长安锦绣城店（重复）" }
];

const ordinary = matchStores(items, baseStores);
const routeIndex = createRouteBaseIndex(baseStores);
assert.ok(
  routeIndex.matchIndex.scoringStores.every(entry => entry.fields.every(field => field.normalized === null && field.pinyin === null)),
  "building the reusable matcher index must not eagerly normalize candidate names"
);
const compiled = matchStores(items, routeIndex.stores, routeIndex.matchIndex);
assert.ok(
  routeIndex.matchIndex.scoringStores.every(entry => entry.fields.every(field => typeof field.normalized === "string" && typeof field.pinyin === "string")),
  "fuzzy matching should lazily prepare candidate normalization and pinyin once"
);
assert.deepStrictEqual(compiled, ordinary, "compiled MatchIndex must preserve every match field and result");
assert.strictEqual(routeIndex.matchIndex.stores, baseStores, "route index must reference the exact base snapshot");
assert.equal(routeIndex.matchIndex.byId.size, baseStores.length, "the standard identity map must be prebuilt");
assert.ok(routeIndex.matchIndex.scoringStores.every(entry => entry.fields.every(field => typeof field.normalized === "string")), "normalized candidate names must be precomputed");

const segmentItems = [
  { rawName: "渝北JM03131谊品生鲜长安锦绣城店-江北重庆三峡融资担保集团有限公司" },
  { rawName: "普通门店名称，不应拆分" }
];
assert.deepStrictEqual(
  splitByRouteBase(segmentItems, routeIndex),
  splitByRouteBase(segmentItems, baseStores),
  "precomputed route-base segmentation must preserve the original split result"
);

for (const store of baseStores) {
  for (const name of [store.name, store.originalName, ...(store.aliases || [])]) {
    assert.ok(routeIndex.knownKeys.has(formatCompareKey(name)), "all existing identity names must remain known for OCR edge checks");
  }
}

const aliasOnlyBase = [
  { storeId: "ALIAS-SHORT", name: "重庆市渝北区长安锦绣城谊品生鲜店", originalName: "长安锦绣城谊品生鲜店", aliases: ["锦绣城店"], routeOrder: 1 },
  { storeId: "FULL-NAME", name: "重庆江北区三峡融资担保集团有限公司", originalName: "三峡融资担保集团有限公司", aliases: [], routeOrder: 2 }
];
const aliasOnlyItems = [
  { rawName: "锦绣城店 / 重庆江北区三峡融资担保集团有限公司", sourceLine: "alias + full name" }
];
const oldAliasSplit = legacySplitByRouteBase(aliasOnlyItems, aliasOnlyBase);
const indexedAliasSplit = splitByRouteBase(aliasOnlyItems, createRouteBaseIndex(aliasOnlyBase));
assert.deepStrictEqual(indexedAliasSplit, oldAliasSplit, "the compiled splitter must retain short alias hits just like the old all-identities scan");
assert.equal(indexedAliasSplit.length, 2, "two distinct route-base stores must be recovered when one appears only by a short alias");
assert.deepStrictEqual(indexedAliasSplit.map(item => item.storeId), ["ALIAS-SHORT", "FULL-NAME"], "short alias matching must retain each correct store identity");

const aliasVariants = [
  { rawName: "锦绣城店 / 重庆江北区三峡融资担保集团有限公司" },
  { rawName: "长安锦绣城谊品生鲜店 / 三峡融资担保集团有限公司" },
  { rawName: "锦绣城店 / 三峡融资担保集团有限公司" },
  { rawName: "完全无关的识别文本" }
];
assert.deepStrictEqual(
  splitByRouteBase(aliasVariants, createRouteBaseIndex(aliasOnlyBase)),
  legacySplitByRouteBase(aliasVariants, aliasOnlyBase),
  "all-name/alias segmentation must remain byte-for-byte behaviorally equivalent to the previous splitter"
);

const cached = getCachedRouteBaseIndex("user-1", "route-1", 7, baseStores);
assert.strictEqual(getCachedRouteBaseIndex("user-1", "route-1", 7, baseStores), cached, "same user/route/version should reuse the compiled index");
assert.notStrictEqual(getCachedRouteBaseIndex("user-2", "route-1", 7, baseStores), cached, "different users must not share cache entries");
assert.notStrictEqual(getCachedRouteBaseIndex("user-1", "route-2", 7, baseStores), cached, "different routes must not share cache entries");
assert.notStrictEqual(getCachedRouteBaseIndex("user-1", "route-1", 8, baseStores), cached, "a new base version must invalidate the old index");
assert.notStrictEqual(getCachedRouteBaseIndex("user-1", "route-no-version", undefined, baseStores), getCachedRouteBaseIndex("user-1", "route-no-version", undefined, baseStores), "unversioned legacy bases must not be cached");

const evictionSeed = getCachedRouteBaseIndex("cache-user", "eviction-seed", 1, baseStores);
for (let i = 0; i < 16; i++) getCachedRouteBaseIndex("cache-user", "eviction-route-" + i, 1, baseStores);
assert.notStrictEqual(getCachedRouteBaseIndex("cache-user", "eviction-seed", 1, baseStores), evictionSeed, "the isolate-local LRU cache must evict beyond 16 entries");

console.log("✅ route-base MatchIndex parity, version isolation, and 16-entry LRU passed");
