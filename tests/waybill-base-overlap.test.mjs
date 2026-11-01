import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../functions/api/waybills/process.js", import.meta.url), "utf8");
const preflight = source.indexOf("const uploadBucket=!recognizedText&&files.length?env?.WAYBILL_FILES:null;");
const start = source.indexOf("const baseLookupStarted=Date.now();");
const indexPrepared = source.indexOf("getCachedRouteBaseIndex(user.id,routeId,data.version,data.stores)");
const ocr = source.indexOf("const ocrStarted=Date.now();");
const wait = source.indexOf("const baseResult=await baseLookupPromise;");
const extract = source.indexOf("const extractedStarted=Date.now();");

assert.ok(preflight >= 0 && preflight < start, "upload size and R2 availability must be checked before route-base lookup");
assert.ok(source.indexOf("if(files.length>WAYBILL_TEMP_MAX_FILES") < start, "invalid uploads must fail before spending the route-base read");
assert.ok(start >= 0, "route base lookup must be started");
assert.ok(ocr > start, "route base lookup must start before OCR begins");
assert.ok(indexPrepared > start && indexPrepared < ocr, "route-base MatchIndex must be prepared during the OCR wait");
assert.ok(wait > ocr, "route base lookup must be awaited after OCR work has started");
assert.ok(extract > wait, "matching inputs must not be extracted before route base is resolved");
assert.match(source, /isTempRoute\(routeId\)[\s\S]*?Promise\.resolve\(\{stores:\[\],available:false,error:null,elapsedMs:0,lookupMs:0,indexMs:0,index:null\}\)/,
  "temporary routes must retain the no-base fast path");
assert.match(source, /baseResult\.error&&baseResult\.error\?\.code!=="BASE_NOT_FOUND"/,
  "non-missing base errors must remain fatal");
assert.match(source, /baseResult\.stores;const baseAvailable=baseResult\.available;const baseMs=baseResult\.elapsedMs/,
  "the same base stores and elapsed time must feed existing planning and diagnostics");
assert.match(source, /matchStores\(extracted\.stores,baseStores,baseIndex\?\.matchIndex\)/,
  "the prepared matcher index must be reused for store matching");
assert.match(source, /splitByRouteBase\(extracted\.stores,baseIndex\|\|baseStores\)/,
  "the prepared identity keys must be reused for route-base segmentation");
assert.match(source, /baseWaitMs,baseOverlapMs/,
  "diagnostics must distinguish the residual wait from overlapped time");
assert.doesNotMatch(source, /baseStores=await base\(env,routeId\)/,
  "the route base must not be fetched serially after OCR");

console.log("✅ route base lookup overlaps OCR without changing matching order or error handling");
