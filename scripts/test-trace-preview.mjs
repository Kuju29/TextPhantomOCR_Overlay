import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ||= webcrypto;
const { tracePreview, tracePreviewUnits } = await import("../src/shared/trace-preview.js");
const { setTracingEnabled, diagnosticPreviewsEnabled, diagnosticContentEnabled, note, flushTrace } = await import("../src/shared/trace.js");

const got = await tracePreview("😀".repeat(121));
assert.equal(got.chars, 121);
assert.equal(got.sha256.length, 64);
assert.deepEqual(Object.keys(got).sort(), ["chars", "sha256"]);

const units = await tracePreviewUnits([{ id: "source-A", text: "first" }, { id: "source-B", text: "second" }]);
assert.deepEqual(units.map(({ id, chars }) => [id, chars]), [["source-A", 5], ["source-B", 6]]);
assert(units.every((unit) => typeof unit.sha256 === "string" && !("preview" in unit)));

// Exercise an emitted compact trace, not just the metadata helper. Unique
// source/translation/prompt sentinels must never reach the shipment while
// hashes, counts and safe numeric AI diagnostics remain useful.
const SOURCE_SENTINEL = "SOURCE_SENTINEL_7f91f4";
const TRANSLATION_SENTINEL = "TRANSLATION_SENTINEL_981cab";
const PROMPT_SENTINEL = "PROMPT_SENTINEL_c140de";
const shipped = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  shipped.push(JSON.parse(options.body));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ok:true, session:"privacy-test"}) };
};
setTracingEnabled(true, () => "http://127.0.0.1:7860", "compact", "privacy-test");
assert.equal(diagnosticPreviewsEnabled(), true);
assert.equal(diagnosticContentEnabled(), false);
const safeUnits = await tracePreviewUnits([{ id: "P0", text: SOURCE_SENTINEL }]);
note("shared/ai/direct-local/generation.js", "privacyTest", {
  units: safeUnits,
  sourceText: SOURCE_SENTINEL,
  translation: TRANSLATION_SENTINEL,
  prompt: PROMPT_SENTINEL,
  requestedOutputTokens: 8192,
  inputTokens: 123,
  outputTokens: 45,
  totalTokens: 168,
  providerMs: 321,
  apiKey: "sk-this-must-never-ship",
});
await flushTrace();
setTracingEnabled(false);
globalThis.fetch = previousFetch;
assert.equal(shipped.length, 1);
const emitted = JSON.stringify(shipped[0]);
for (const sentinel of [SOURCE_SENTINEL, TRANSLATION_SENTINEL, PROMPT_SENTINEL, "sk-this-must-never-ship"]) {
  assert(!emitted.includes(sentinel), `compact trace leaked: ${sentinel}`);
}
const data = shipped[0].records[0].d;
assert.equal(data.units[0].chars, [...SOURCE_SENTINEL].length);
assert.equal(data.units[0].sha256.length, 64);
assert.equal(data.requestedOutputTokens, 8192);
assert.equal(data.inputTokens, 123);
assert.equal(data.outputTokens, 45);
assert.equal(data.totalTokens, 168);
assert.equal(data.providerMs, 321);
assert.equal(data.apiKey, "<redacted>");
console.log("trace preview tests passed");
