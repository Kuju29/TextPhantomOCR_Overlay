import assert from "node:assert/strict";
import {
  activeOperationCount,
  contextOperationKey,
  joinActiveOperation,
  releaseActiveOperationForBatch,
} from "../src/background/active-operations.js";
import { createKeepalivePortLifecycle } from "../src/background/keepalive-port-lifecycle.js";

let cancelled = 0;
let lifecycle = createKeepalivePortLifecycle(() => cancelled++);
lifecycle.onMessage({ type: "TP_KEEPALIVE_GRACEFUL_STOP" });
lifecycle.onDisconnect();
assert.equal(cancelled, 0);
lifecycle = createKeepalivePortLifecycle(() => cancelled++);
lifecycle.onMessage({ type: "TP_KEEPALIVE_PAGE_UNLOAD" });
lifecycle.onDisconnect();
assert.equal(cancelled, 1);
lifecycle = createKeepalivePortLifecycle(() => cancelled++);
lifecycle.onDisconnect();
assert.equal(cancelled, 2);

const info = { menuItemId: "img_one", srcUrl: "https://x/a.jpg", frameId: 0 };
const key = contextOperationKey(info, { id: 7, url: "https://x/page" });
assert.notEqual(
  key,
  contextOperationKey(info, { id: 7, url: "https://x/page" }, { settingsEpoch: 1 }),
  "a changed AI profile is a different semantic payload",
);
let starts = 0;
let releaseStart;
const gate = new Promise((resolve) => { releaseStart = resolve; });
const first = joinActiveOperation(key, async () => { starts++; await gate; return "batch-a"; });
const repeated = joinActiveOperation(key, async () => { starts++; return "wrong"; });
assert.equal(first, repeated);
releaseStart();
assert.equal(await first, "batch-a");
assert.equal(starts, 1);
assert.equal(activeOperationCount(), 1);
const other = joinActiveOperation(
  contextOperationKey({ ...info, srcUrl: "https://x/b.jpg" }, { id: 7 }),
  async () => "batch-b",
);
assert.equal(await other, "batch-b");
assert.equal(activeOperationCount(), 2);
releaseActiveOperationForBatch("batch-b");
assert.equal(activeOperationCount(), 1, "finishing B must not cancel/release A");
releaseActiveOperationForBatch("batch-a");
assert.equal(activeOperationCount(), 0);
const failed = joinActiveOperation(key, async () => { starts++; throw new Error("terminal"); });
await assert.rejects(failed, /terminal/);
assert.equal(activeOperationCount(), 0);
await joinActiveOperation(key, async () => { starts++; return "batch-retry"; });
assert.equal(starts, 3);
releaseActiveOperationForBatch("batch-retry");

let finishFast;
const fast = joinActiveOperation("fast", async () => {
  finishFast = "batch-fast";
  releaseActiveOperationForBatch(finishFast);
  return finishFast;
});
await fast;
assert.equal(activeOperationCount(), 0, "a synchronous terminal result cannot leave a stale dedupe lease");

console.log("session keepalive and active-operation dedupe contracts: ok");
