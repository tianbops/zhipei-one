import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../functions/api/waybills/process.js", import.meta.url), "utf8");
const start = source.indexOf("const baseLookupStarted=Date.now();");
const ocr = source.indexOf("const ocrStarted=Date.now();");
const wait = source.indexOf("const baseResult=await baseLookupPromise;");
const extract = source.indexOf("const extractedStarted=Date.now();");

assert.ok(start >= 0, "route base lookup must be started");
assert.ok(ocr > start, "route base lookup must start before OCR begins");
assert.ok(wait > ocr, "route base lookup must be awaited after OCR work has started");
assert.ok(extract > wait, "matching inputs must not be extracted before route base is resolved");
assert.match(source, /isTempRoute\\(routeId\\)[\\s\\S]*?Promise\\.resolve\\(\\{stores:\\[\\],available:false,error:null,elapsedMs:0\\}\\)/,
  "temporary routes must retain the no-base fast path");
assert.match(source, /baseResult\\.error&&baseResult\\.error\\?\\.code!=="BASE_NOT_FOUND"/,
  "non-missing base errors must remain fatal");
assert.match(source, /baseResult\\.stores;const baseAvailable=baseResult\\.available;const baseMs=baseResult\\.elapsedMs/,
  "the same base stores and elapsed time must feed existing planning and diagnostics");
assert.doesNotMatch(source, /baseStores=await base\\(env,routeId\\)/,
  "the route base must not be fetched serially after OCR");

console.log("✅ route base lookup overlaps OCR without changing matching order or error handling");
