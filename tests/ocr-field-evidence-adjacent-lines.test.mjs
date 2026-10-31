import assert from "node:assert/strict";
import { associateFieldEvidence } from "../functions/api/waybills/_ocr-field-evidence.js";

const store = rawName => ({ stores: [{ rawName }] });

// Two consecutive rows in one image remain supported with row scores intact.
const two = associateFieldEvidence({
  ...store("重庆彩食鲜供应链有限公司"),
  lineEvidence: [
    { imageIndex: 1, text: "重庆彩食鲜供应链", score: 0.91 },
    { imageIndex: 1, text: "有限公司", score: 0.87 }
  ]
});
assert.equal(two.stores[0].source, "ocr");
assert.deepEqual(two.stores[0].evidence.map(x => x.lineIndex), [0, 1]);
assert.deepEqual(two.stores[0].evidence.map(x => x.imageIndex), [1, 1]);
assert.deepEqual(two.stores[0].evidence.map(x => x.score), [0.91, 0.87]);

// Three and four consecutive rows in the same image can jointly support a name.
const three = associateFieldEvidence({
  ...store("重庆彩食鲜供应链发展有限公司"),
  lineEvidence: [
    { imageIndex: 2, text: "重庆彩食鲜", score: 0.96 },
    { imageIndex: 2, text: "供应链发展", score: 0.94 },
    { imageIndex: 2, text: "有限公司", score: 0.92 }
  ]
});
assert.equal(three.stores[0].source, "ocr");
assert.deepEqual(three.stores[0].evidence.map(x => x.lineIndex), [0, 1, 2]);

const four = associateFieldEvidence({
  ...store("重庆中法供水有限公司花园新村"),
  lineEvidence: [
    { imageIndex: 3, text: "重庆中法供水", score: 0.96 },
    { imageIndex: 3, text: "有限公司", score: 0.95 },
    { imageIndex: 3, text: "花园", score: 0.94 },
    { imageIndex: 3, text: "新村", score: 0.93 }
  ]
});
assert.equal(four.stores[0].source, "ocr");
assert.deepEqual(four.stores[0].evidence.map(x => x.lineIndex), [0, 1, 2, 3]);

// Never join rows across screenshots.
const crossImage = associateFieldEvidence({
  ...store("重庆彩食鲜供应链有限公司"),
  lineEvidence: [
    { imageIndex: 1, text: "重庆彩食鲜供应链", score: 0.91 },
    { imageIndex: 2, text: "有限公司", score: 0.87 }
  ]
});
assert.equal(crossImage.stores[0].source, "unavailable");

// Never skip an intervening OCR row to manufacture a match.
const nonAdjacent = associateFieldEvidence({
  ...store("重庆彩食鲜供应链有限公司"),
  lineEvidence: [
    { imageIndex: 1, text: "重庆彩食鲜供应链", score: 0.91 },
    { imageIndex: 1, text: "其他门店名称", score: 0.88 },
    { imageIndex: 1, text: "有限公司", score: 0.87 }
  ]
});
assert.equal(nonAdjacent.stores[0].source, "unavailable");

// Exact single-row evidence remains preferred over adjacent candidates.
const singleLine = associateFieldEvidence({
  ...store("江北区鸿恩寺客服中心"),
  lineEvidence: [
    { imageIndex: 4, text: "江北区鸿恩寺客服中心", score: 0.98 },
    { imageIndex: 4, text: "其他文字", score: 0.72 }
  ]
});
assert.equal(singleLine.stores[0].evidence.length, 1);
assert.equal(singleLine.stores[0].evidence[0].score, 0.98);

// Five rows exceed the bounded fallback and must not be combined.
const five = associateFieldEvidence({
  ...store("甲乙丙丁戊己庚辛"),
  lineEvidence: [
    { imageIndex: 5, text: "甲乙", score: 0.9 },
    { imageIndex: 5, text: "丙丁", score: 0.9 },
    { imageIndex: 5, text: "戊", score: 0.9 },
    { imageIndex: 5, text: "己庚", score: 0.9 },
    { imageIndex: 5, text: "辛", score: 0.9 }
  ]
});
assert.equal(five.stores[0].source, "unavailable");

console.log("OCR adjacent-line field evidence tests passed.");
