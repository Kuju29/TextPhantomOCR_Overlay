import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tabMessages = [];
globalThis.chrome = {
  runtime: { sendMessage(_msg, cb) { cb?.(); }, get lastError() { return null; } },
  tabs: { sendMessage(_tab, msg, _opts, cb) { tabMessages.push(msg); cb?.({ ok: true }); } },
};

const {
  IMAGE_PHASES, batchMark, batchPassStats, batchProgressSnapshot, batchUpdateToast, ensureBatch, markImagePhase,
  restoreBatchSnapshot, serializeBatchSnapshot,
} = await import("../src/background/batches.js");

assert.deepEqual(IMAGE_PHASES, [
  "waiting", "scanning", "downloading", "lens", "grouping", "ai_queued",
  "ai_generating", "server_processing", "rendering", "done", "error", "cancelled",
]);
const batch = ensureBatch("progress-contract", 17, 0);
batch.items.set("a", { attempt: 1, status: "queued", payload: { context: { page_index: 0 } } });
assert.equal(batchPassStats(batch).total, 1, "an active item must never be reported as */0");
let snapshot = batchProgressSnapshot(batch, "Starting", 1000);
assert.equal(snapshot.active, 1);
assert.equal(snapshot.total, 1);
assert.equal(snapshot.items[0].phase, "waiting");
assert.equal(snapshot.items[0].label, "Image 1");
markImagePhase("progress-contract", "a", "ai_generating");
batchUpdateToast(batch, "AI is generating", true);
assert.match(String(tabMessages.filter((msg) => msg?.type === "TP_TOAST").at(-1)?.text), /0\/1.*AI is generating/,
  "the original compact toast must show both progress and the current image phase");
let item = batch.items.get("a");
assert.equal(item.status, "processing");
assert.ok(Number(item.phaseAt) > 0);
const phaseAt = item.phaseAt;
batchMark("progress-contract", "a", { lastError: "metadata only" });
assert.equal(batch.items.get("a").phaseAt, phaseAt);
batchMark("progress-contract", "a", { status: "inserting" });
assert.equal(batch.items.get("a").phase, "rendering", "legacy callers can advance a canonical item");
markImagePhase("progress-contract", "a", "error", { lastError: "quota exhausted" });
batchUpdateToast(batch, "Error", true);
assert.match(String(tabMessages.filter((msg) => msg?.type === "TP_TOAST").at(-1)?.text), /1\/1.*Error: quota exhausted/,
  "a terminal failure must keep a concise real error in the compact toast");
snapshot = batchProgressSnapshot(batch);
assert.equal(snapshot.active, 0);
assert.equal(snapshot.terminal, 1);
assert.equal(snapshot.items[0].error, "quota exhausted");
assert.equal(batchPassStats(batch).error, 1);
markImagePhase("progress-contract", "a", "rendering");
assert.equal(batch.items.get("a").phase, "error", "a late same-attempt update cannot reopen terminal work");
markImagePhase("progress-contract", "a", "server_processing", { attempt: 2 });
assert.equal(batch.items.get("a").phase, "server_processing", "a new attempt may reset terminal work");
assert.equal(batch.items.get("a").attempt, 2);

const encoded = serializeBatchSnapshot(batch);
assert.equal(encoded.items[0].payload, undefined, "persisted progress must not contain image bytes or request payloads");
const restored = restoreBatchSnapshot(encoded);
assert.ok(restored?.restored);
assert.equal(restored.items.get("a").phase, "server_processing");
restored.total2 = 0;
restored.pass = 2;
restored.items.get("a").attempt = 2;
const rebuilt = restoreBatchSnapshot(serializeBatchSnapshot(restored));
assert.equal(rebuilt.total2, 1, "restore rebuilds a missing total from current-attempt items");
assert.throws(() => markImagePhase("progress-contract", "a", "mystery"), /Unknown image phase/);

const multi = ensureBatch("progress-multi", 17, 0);
multi.total1 = 2;
multi.items.set("m1", { attempt: 1, status: "done", phase: "done", payload: { context: { page_index: 0 } } });
multi.items.set("m2", { attempt: 1, status: "processing", phase: "ai_generating", payload: { context: { page_index: 1 } } });
batchUpdateToast(multi, "AI is generating", true);
assert.match(String(tabMessages.filter((msg) => msg?.type === "TP_TOAST").at(-1)?.text), /1\/2.*Image 2: AI is generating/,
  "translate-all must show the current image and aggregate progress in the same compact toast");

const domUtils = await readFile(new URL("../src/content/dom-utils.js", import.meta.url), "utf8");
const messaging = await readFile(new URL("../src/content/messaging.js", import.meta.url), "utf8");
assert.doesNotMatch(domUtils, /ensureProgressPanel|progressEl|minWidth:\s*"220px"/,
  "the large second on-page progress panel must not return");
const batchHandler = messaging.slice(
  messaging.indexOf('if (type === "BATCH_STATUS_UPDATE")'),
  messaging.indexOf('if (type === "API_STATUS_UPDATE")'),
);
assert.doesNotMatch(batchHandler, /showToast|updateBatchProgress|queueProgressUpdate/,
  "batch telemetry must not create a second visual presenter on the page");
console.log("Batch progress contract tests passed.");
