import assert from "node:assert/strict";

globalThis.chrome = { runtime: { getManifest: () => ({ version: "test-build" }) } };
const requests = [];
let failFirst = true;
globalThis.fetch = async (_url, options) => {
  requests.push(JSON.parse(options.body));
  if (failFirst) {
    failFirst = false;
    throw new Error("lost ack");
  }
  return { ok: true, status: 200, headers: { get: () => null } };
};

const trace = await import("../src/shared/trace.js");
trace.setTracingEnabled(true, () => "http://local", "compact", "session-a");
trace.traceLine("worker.js", "run", "->", { attempt: 1 }, "t1");
await trace.flushTrace();
await trace.flushTrace();

assert.equal(requests.length, 2, "a lost ACK retains and resends the same batch");
assert.equal(requests[0].shipmentId, requests[1].shipmentId, "exact resend has stable shipment identity");
assert.match(requests[0].shipmentId, /^(?:[0-9a-f]{64}|fnv-[0-9a-f]+)$/);
assert.ok(requests[0].producerId, "payload identifies the worker producer");
assert.equal(requests[0].records[0].producerId, requests[0].producerId);

trace.traceRelay({
  t: Date.now(), n: 1, trace: "t2", side: "page", producerId: "page-context-a",
  tabId: 7, frameId: 3, file: "page.js", fn: "go", ev: "->",
});
await trace.flushTrace();
const relayed = requests.at(-1).records[0];
assert.equal(relayed.producerId, "page-context-a");
assert.equal(relayed.tabId, 7);
assert.equal(relayed.frameId, 3);

console.log("trace producer identity tests passed");
