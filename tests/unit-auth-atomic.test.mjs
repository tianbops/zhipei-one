import assert from "node:assert/strict";
import { MiniRedis, makeUpstash } from "./_mini-redis.cjs";

const redis = new MiniRedis();
const originalFetch = global.fetch;
makeUpstash(redis);
let calls = 0;
const bridgedFetch = global.fetch;
global.fetch = async (...args) => { calls++; return bridgedFetch(...args); };

const { currentUser } = await import(new URL("../functions/api/_auth.js", import.meta.url).href);
const env = { UPSTASH_REDIS_REST_URL: "https://upstash.local", UPSTASH_REDIS_REST_TOKEN: "test" };
const req = token => ({ headers: { get: name => name === "authorization" ? (token ? "Bearer " + token : null) : null } });
const set = (key, value) => redis.command(["SET", "zp:" + key, JSON.stringify(value)]);

try {
  await set("session:valid", { userId: "u1", sessionVersion: 2 });
  await set("user:u1", { id: "u1", username: "driver", role: "user", sessionVersion: 2 });
  calls = 0;
  assert.deepEqual(await currentUser(req("valid"), env), { id: "u1", username: "driver", role: "user", sessionVersion: 2 });
  assert.equal(calls, 1, "session + user authentication must use one Redis REST round trip");

  await set("session:disabled", { userId: "u2", sessionVersion: 1 });
  await set("user:u2", { id: "u2", disabled: true, sessionVersion: 1 });
  assert.equal(await currentUser(req("disabled"), env), null, "disabled users remain rejected");

  await set("session:stale", { userId: "u3", sessionVersion: 1 });
  await set("user:u3", { id: "u3", sessionVersion: 2 });
  assert.equal(await currentUser(req("stale"), env), null, "session version mismatch remains rejected");

  await set("session:bad-json", "not-json");
  assert.equal(await currentUser(req("bad-json"), env), null, "malformed session remains rejected");
  assert.equal(await currentUser(req("missing"), env), null, "missing session remains rejected");
  assert.equal(await currentUser(req(null), env), null, "missing token avoids Redis");

  console.log("AUTH_ATOMIC: passed — one Redis REST round trip; disabled, stale, malformed and missing sessions rejected");
} finally {
  global.fetch = originalFetch;
}
