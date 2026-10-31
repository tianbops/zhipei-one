/**
 * Associate extracted business fields with the OCR lines that support them.
 * Evidence is advisory only: it never changes extraction, matching, or planning.
 * Store references point into ocr.lineEvidence to avoid duplicating OCR payloads.
 */
const compact = value => String(value ?? "").toUpperCase().replace(/[\s\p{P}\p{S}\u200b\uFEFF]/gu, "");
const digits = value => String(value ?? "").replace(/\D/g, "");

function fieldKey(value, kind) {
  if (kind === "date") return digits(value);
  return compact(value);
}

function matchesField(value, kind, text) {
  if (kind === "weight") {
    const target = Number(value);
    if (!Number.isFinite(target)) return false;
    const tokens = String(text ?? "").match(/\d+(?:[.,]\d+)?/g) || [];
    return tokens.some(token => {
      const parsed = Number(token.replace(",", "."));
      return Number.isFinite(parsed) && Math.abs(parsed - target) < 1e-9;
    });
  }
  const target = fieldKey(value, kind);
  return !!target && fieldKey(text, kind).includes(target);
}

function evidenceRef(line, lineIndex) {
  return {
    lineIndex,
    imageIndex: Number.isInteger(line?.imageIndex) && line.imageIndex > 0 ? line.imageIndex : null,
    score: line?.score != null && Number.isFinite(Number(line.score)) ? Number(line.score) : null,
  };
}

function findEvidence(value, kind, lines, limit = 3, allowAdjacent = false, maxAdjacentLines = 4) {
  if (value == null || value === "") return [];
  const matches = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const text = String(line?.text || "");
    if (!matchesField(value, kind, text)) continue;
    matches.push(evidenceRef(line, lineIndex));
    if (matches.length >= limit) break;
  }
  // Exact single-row matches always take precedence. Store-name fallback may
  // join 2-4 consecutive OCR rows, but never rows from different screenshots.
  if (matches.length || !allowAdjacent || kind !== "text" || maxAdjacentLines < 2) return matches;

  const target = fieldKey(value, kind);
  for (let start = 0; start < lines.length; start++) {
    const first = lines[start];
    const imageIndex = Number.isInteger(first?.imageIndex) && first.imageIndex > 0
      ? first.imageIndex
      : null;
    if (imageIndex == null) continue;

    let combined = "";
    const refs = [];
    for (let length = 1; length <= maxAdjacentLines && start + length <= lines.length; length++) {
      const lineIndex = start + length - 1;
      const line = lines[lineIndex];
      if (line?.imageIndex !== imageIndex) break;
      const key = fieldKey(line?.text, kind);
      if (!key) break;
      combined += key;
      refs.push(evidenceRef(line, lineIndex));
      if (length >= 2 && combined.includes(target)) {
        return refs.slice(0, limit);
      }
    }
  }
  return [];
}

function fieldRecord(field, value, kind, lines, manual = false) {
  if (value == null || value === "") return { field, value: null, source: "unavailable", evidence: [] };
  if (manual) return { field, value, source: "manual", evidence: [] };
  const evidence = findEvidence(value, kind, lines);
  return { field, value, source: evidence.length ? "ocr" : "unavailable", evidence };
}

export function associateFieldEvidence({ fields = {}, stores = [], lineEvidence = [], manualFields = [] } = {}) {
  const lines = Array.isArray(lineEvidence) ? lineEvidence.slice(0, 1000) : [];
  const manual = new Set(manualFields);
  const records = [
    fieldRecord("date", fields.date, "date", lines, manual.has("date")),
    fieldRecord("vehicle", fields.vehicle, "text", lines, manual.has("vehicle")),
    fieldRecord("driver", fields.driver, "text", lines, manual.has("driver")),
    fieldRecord("deliveryPerson", fields.deliveryPerson, "text", lines, manual.has("deliveryPerson")),
    fieldRecord("totalWeight", fields.totalWeight, "weight", lines, manual.has("totalWeight")),
  ];
  const storeRecords = (Array.isArray(stores) ? stores : []).slice(0, 500).map((store, index) => {
    const value = store?.rawName || store?.name || store?.storeId || "";
    const evidence = findEvidence(value, "text", lines, 4, true, 4);
    return {
      index: index + 1,
      rawName: store?.rawName || null,
      name: store?.name || null,
      storeId: store?.storeId || null,
      source: evidence.length ? "ocr" : "unavailable",
      evidence,
    };
  });
  return {
    version: 1,
    fields: records,
    stores: storeRecords,
    summary: {
      fieldCount: records.length,
      fieldsWithEvidence: records.filter(x => x.source === "ocr").length,
      storesWithEvidence: storeRecords.filter(x => x.source === "ocr").length,
      storesWithoutEvidence: storeRecords.filter(x => x.source !== "ocr").length,
    },
  };
}

export default { associateFieldEvidence };
