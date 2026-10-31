import assert from "node:assert/strict";
import { associateFieldEvidence } from "../functions/api/waybills/_ocr-field-evidence.js";

// A store name split across two consecutive OCR rows in the same image
// should be associated with both source rows, retaining their own scores.
const sameImage = associateFieldEvidence({
  stores: [{ rawName: "重庆彩食鲜供应链有限公司" }],
  lineEvidence: [
    { imageIndex: 1, text: "重庆彩食鲜供应链", score: 0.91 },
    { imageIndex: 1, text: "有限公司", score: 0.87 }
  ]
});
const sameImageEvidence = sameImage.stores[0].evidence;
assert.equal(sameImage.stores[0].source, "ocr", "same-image adjacent rows should jointly support a store name");
assert.deepEqual(sameImageEvidence.map(x => x.lineIndex), [0, 1], "both source rows must be referenced");
assert.deepEqual(sameImageEvidence.map(x => x.imageIndex), [1, 1], "both references must retain image index");
assert.deepEqual(sameImageEvidence.map(x => x.score), [0.91, 0.87], "each source row must retain its own model score");

// Identical text split across different images must never be joined.
const crossImage = associateFieldEvidence({
  stores: [{ rawName: "重庆彩食鲜供应链有限公司" }],
  lineEvidence: [
    { imageIndex: 1, text: "重庆彩食鲜供应链", score: 0.91 },
    { imageIndex: 2, text: "有限公司", score: 0.87 }
  ]
});
assert.equal(crossImage.stores[0].source, "unavailable", "rows from different images must not be concatenated");

// Existing single-line evidence remains preferred and keeps its score.
const singleLine = associateFieldEvidence({
  stores: [{ rawName: "江北区鸿恩寺客服中心" }],
  lineEvidence: [
    { imageIndex: 3, text: "江北区鸿恩寺客服中心", score: 0.98 },
    { imageIndex: 3, text: "其他文字", score: 0.72 }
  ]
});
assert.equal(singleLine.stores[0].evidence.length, 1, "single-line match must not gain adjacent noise");
assert.equal(singleLine.stores[0].evidence[0].score, 0.98);

console.log("OCR adjacent-line field evidence tests passed.");
