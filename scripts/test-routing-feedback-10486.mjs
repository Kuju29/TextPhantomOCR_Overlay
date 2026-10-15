// .86 provider routing, extension side: the script-check verdict of an API
// answer that asked for it (meta.routingFeedback.token) rides on the next
// translate request; nothing is sent when the API did not ask.
import assert from "node:assert/strict";

const stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "2026.test" }) },
  storage: { local: {
    get(keys, callback) { callback(Array.isArray(keys) ? Object.fromEntries(keys.map((key) => [key, stored[key]])) : { ...keys, ...stored }); },
    set(value, callback) { Object.assign(stored, value); callback?.(); },
  } },
};

const feedback = await import("../src/background/ai/routing-feedback.js");
const { translateViaServer } = await import("../src/background/ai/transports/server.js");
const checks = [];
const token = (n) => n.toString(16).padStart(32, "0");

// Pure queue behaviour.
const reject = () => [{ id: "P0", decision: "reject" }];
const accept = () => [{ id: "P0", decision: "accept" }];
assert.equal(feedback.noteRoutingAnswer({ meta: {} }, [], "th"), null);
assert.equal(feedback.noteRoutingAnswer({ meta: { routingFeedback: { token: "../x" } } }, [], "th"), null);
assert.equal(feedback.noteRoutingAnswer({ meta: { routingFeedback: { token: token(1) } } }, [], "th", reject), "wrong_language");
assert.equal(feedback.noteRoutingAnswer({ meta: { routingFeedback: { token: token(2) } } }, [], "th", accept), "ok");
assert.deepEqual(feedback.takeRoutingFeedback(), [{ token: token(1), outcome: "wrong_language" }, { token: token(2), outcome: "ok" }]);
for (let i = 0; i < 80; i += 1) feedback.noteRoutingAnswer({ meta: { routingFeedback: { token: token(100 + i) } } }, [], "th", accept);
assert.equal(feedback.pendingRoutingFeedback(), 64);
assert.equal(feedback.takeRoutingFeedback().length, 32);
assert.equal(feedback.takeRoutingFeedback(99).length, 32);
assert.equal(feedback.pendingRoutingFeedback(), 0);
checks.push("only API-requested verdicts are queued; bounded queue; at most 32 per request");

// Transport: verdict of answer 1 is sent with request 2, not before.
const bodies = [];
let reply = null;
globalThis.fetch = async (url, init) => {
  bodies.push(JSON.parse(init.body));
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
};
const call = (units) => translateViaServer(units, {
  base: "https://api.test", targetLang: "th", sourceLang: "en", operationId: `op-${bodies.length}`,
  batchId: "batch-1", ai: { provider: "openrouter", model: "m/x", base_url: "https://openrouter.ai/api/v1",
    api_key: "k", thinking: "off" } });
const result = (text, tokenValue) => ({ schema: "tp.ai.result/1", translations: [{ id: "P0", text }], missing: [],
  meta: { provider: "openrouter", model: "m/x", generationAttempts: 1, providerAttempts: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ...(tokenValue ? { routingFeedback: { token: tokenValue } } : {}) } });

reply = result("This is English, not Thai at all.", token(7));
await call([{ id: "P0", text: "これは日本語です" }]);
assert.equal(bodies[0].routingFeedback, undefined);
reply = result("สวัสดีครับ", token(8));
await call([{ id: "P0", text: "こんにちは" }]);
assert.deepEqual(bodies[1].routingFeedback, [{ token: token(7), outcome: "wrong_language" }]);
reply = result("สวัสดีครับ", "");
await call([{ id: "P0", text: "こんにちは" }]);
assert.deepEqual(bodies[2].routingFeedback, [{ token: token(8), outcome: "ok" }]);
await call([{ id: "P0", text: "こんにちは" }]);
assert.equal(bodies[3].routingFeedback, undefined, "an API that did not ask gets nothing");
checks.push("transport: the target-script verdict of an answer rides on the next request only");

reply = result("สวัสดีครับ", token(9));
await call([{ id: "P0", text: "こんにちは" }]);
globalThis.fetch = async () => { throw new TypeError("network down"); };
await assert.rejects(call([{ id: "P0", text: "x" }]));
assert.equal(feedback.pendingRoutingFeedback(), 1, "feedback of a request that never reached the API is kept");
checks.push("feedback survives a request that failed before reaching the API");

console.log(JSON.stringify({ passed: checks.length, checks }));
