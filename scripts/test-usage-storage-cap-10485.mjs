/** .10485 usage ledger: model count cap (LRU, active kept, dedupe remembered); a full storage.local evicts old
 * receipts/history and retries once, and never blocks translation. */
import assert from "node:assert/strict";
import { recordProviderGeneration, normalizeUsageLedger, persistProviderGeneration, flushUsageReceiptJournal,
  setUsageStorageObserver, usageKey, AI_USAGE_MODEL_LIMIT, AI_USAGE_RECEIPT_PREFIX, AI_USAGE_STORAGE_KEY } from "../src/shared/ai-usage.js";

// 1. Model cap with LRU eviction.
let ledger;
for (let i = 0; i < AI_USAGE_MODEL_LIMIT + 8; i++)
  ledger = recordProviderGeneration(ledger, { runtime: "cloud", provider: "p", model: `m${i}`, engine: "runsextension",
    receiptId: `r${i}`, inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { now: 1000 + i, id: () => `s${i}` });
assert.equal(Object.keys(ledger.models).length, AI_USAGE_MODEL_LIMIT);
assert.ok(!ledger.models[usageKey("cloud", "p", "m0")], "least recently used model evicted");
assert.ok(ledger.models[usageKey("cloud", "p", `m${AI_USAGE_MODEL_LIMIT + 7}`)], "newest model kept");
assert.equal(ledger.active.selectionKey, usageKey("cloud", "p", `m${AI_USAGE_MODEL_LIMIT + 7}`));
const replay = recordProviderGeneration(ledger, { runtime: "cloud", provider: "p", model: "m0", engine: "runsextension",
  receiptId: "r0", inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { now: 5000, id: () => "replay" });
assert.ok(!replay.models[usageKey("cloud", "p", "m0")], "evicted model's replayed receipt is deduplicated, not re-counted");
// Legacy oversized ledgers are capped on read and keep the active model even if it is the oldest.
const legacy = structuredClone(ledger);
for (let i = 0; i < 10; i++) legacy.models[`x|old|${i}`] = { provider: "old", model: `${i}`, runtime: "cloud",
  sessions: [{ id: `o${i}`, startedAt: 1, deltas: [] }] };
legacy.active = { selectionKey: "x|old|0", sessionId: "o0" };
const capped = normalizeUsageLedger(legacy);
assert.equal(Object.keys(capped.models).length, AI_USAGE_MODEL_LIMIT);
assert.ok(capped.models["x|old|0"], "active model survives the cap");

// 2. Quota: receipt write fails once -> oldest receipts/ledger history evicted, retried, translation continues.
const stored = {}; let quotaBytes = Infinity; const notes = [];
const bytes = () => Buffer.byteLength(JSON.stringify(stored));
globalThis.chrome = { runtime: { lastError: null, getManifest: () => ({ version: "test" }) }, storage: { local: {
  get(keys, cb) { cb(keys == null ? structuredClone(stored) : Array.isArray(keys)
    ? Object.fromEntries(keys.filter(k => k in stored).map(k => [k, structuredClone(stored[k])])) : { ...keys, ...structuredClone(stored) }); },
  set(patch, cb) {
    const before = { ...stored }; Object.assign(stored, structuredClone(patch));
    if (bytes() > quotaBytes) { for (const k of Object.keys(stored)) delete stored[k]; Object.assign(stored, before);
      globalThis.chrome.runtime.lastError = { message: "QUOTA_BYTES quota exceeded" }; cb?.(); globalThis.chrome.runtime.lastError = null; return; }
    cb?.();
  },
  remove(keys, cb) { for (const k of [].concat(keys)) delete stored[k]; cb?.(); },
} } };
setUsageStorageObserver((event, detail) => notes.push({ event, detail }));
stored[AI_USAGE_STORAGE_KEY] = ledger;
for (let i = 0; i < 20; i++) stored[`${AI_USAGE_RECEIPT_PREFIX}old-${i}`] = { version: 1, nonce: `old-${i}`, storedAt: i, sequence: i,
  event: { pending: true, operationId: `old-op-${i}`, provider: "p", model: "x", engine: "runsextension", pad: "y".repeat(2000) } };
quotaBytes = bytes() + 200; // a new ~1 KB receipt does not fit
const traces = [];
const ok = await persistProviderGeneration({ pending: true, operationId: "new-op", provider: "p", model: "m1", engine: "runsextension",
  runtime: "cloud", pad: "z".repeat(600) }, { emitTrace: (name, row) => traces.push({ name, row }) });
assert.equal(ok.operationId, "new-op", "request path resolves");
assert.ok(notes.some(n => n.event === "usage_storage_relieved"), "relief traced");
assert.ok(traces.some(t => t.row.event === "usage_storage_relieved"));
const receipts = Object.keys(stored).filter(k => k.startsWith(AI_USAGE_RECEIPT_PREFIX));
assert.ok(!receipts.includes(`${AI_USAGE_RECEIPT_PREFIX}old-0`), "oldest receipt evicted");
assert.ok(receipts.some(k => stored[k].event.operationId === "new-op"), "new receipt stored after retry");
assert.ok(Object.keys(stored[AI_USAGE_STORAGE_KEY].models).length < AI_USAGE_MODEL_LIMIT, "ledger history trimmed");
assert.ok(stored[AI_USAGE_STORAGE_KEY].pendingOverflow > 0, "dropped receipts mark usage incomplete");

// 3. Storage stays full: translation still proceeds without a durable receipt (traced, no throw).
quotaBytes = 0;
const skipped = await persistProviderGeneration({ operationId: "full-op", provider: "p", model: "m1", engine: "runsextension",
  runtime: "cloud", inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { emitTrace: (name, row) => traces.push({ name, row }) });
assert.equal(skipped.operationId, "full-op");
assert.ok(notes.some(n => n.event === "usage_receipt_skipped"));
assert.ok(traces.some(t => t.row.event === "usage_receipt_skipped"));

// 4. Non-quota storage errors still surface (no silent fallback).
globalThis.chrome.storage.local.set = (_patch, cb) => { globalThis.chrome.runtime.lastError = { message: "IO error" }; cb?.(); globalThis.chrome.runtime.lastError = null; };
await assert.rejects(persistProviderGeneration({ operationId: "io-op", provider: "p", model: "m1", engine: "runsextension" }), /IO error/);
quotaBytes = Infinity;
setUsageStorageObserver(null);
await flushUsageReceiptJournal({ recover: true }).catch(() => {});
console.log("PASS .10485 usage: 32-model LRU cap with dedupe memory, quota relief evicts oldest receipts/history and retries once, full storage never blocks translation");
