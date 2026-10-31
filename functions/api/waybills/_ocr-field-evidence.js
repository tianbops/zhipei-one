/**
 * Associate extracted business fields with the OCR lines that support them.
 * Evidence is advisory only: it never changes extraction, matching, or planning.
 * Store references point into ocr.lineEvidence to avoid duplicating OCR payloads.
 */
const compact = value => String(value ?? "").toUpperCase().replace(/[\s\p{P}\p{S}\u200b\uFEFF]/gu, "");
const digits = value => String(value ?? "").replace(/\D/g, "");

function fieldKey(value, kind) {
  if (kind === "date" || kind === "weight") return digits(value);
  return compact(value);
}

function findEvidence(value, kind, lines, limit = 3) {
  const target = fieldKey(value, kind);
  if (!target) return [];
  const matches = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const text = String(line?.text || "");
    const haystack = fieldKey(text, kind);
    if (!haystack || !haystack.includes(target)) continue;
    matches.push({
      lineIndex,
      imageIndex: Number.isInteger(line.imageIndex) && line.imageIndex > 0 ? line.imageIndex : null,
    });
    if (matches.length >= limit) break;
  }
  return matches;
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
    const evidence = findEvidence(value, "text", lines, 2);
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
