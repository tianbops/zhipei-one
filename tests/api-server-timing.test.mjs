import assert from "node:assert/strict";
import { guard } from "../functions/api/_safe.js";

const ok = guard(async () => new Response(JSON.stringify({ success: true, value: 7 }), {
  status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
}));
const res = await ok({});
assert.equal(res.status, 200);
assert.equal(res.headers.get("Content-Type"), "application/json");
assert.equal(res.headers.get("Cache-Control"), "no-store");
assert.match(res.headers.get("Server-Timing") || "", /^app;dur=\d+(\.\d+)?$/);
assert.match(res.headers.get("X-ZP-Request-Id") || "", /^[0-9a-f-]{36}$/i);
assert.deepEqual(await res.json(), { success: true, value: 7 });

const fail = guard(async () => { throw new Error("test failure"); }, "TEST_FAILED");
const err = await fail({});
assert.equal(err.status, 500);
assert.match(err.headers.get("Server-Timing") || "", /^app;dur=\d+(\.\d+)?$/);
assert.ok(err.headers.get("X-ZP-Request-Id"));
assert.equal((await err.json()).code, "TEST_FAILED");

console.log("API_SERVER_TIMING: passed — success/error headers added without changing status or JSON payload");
