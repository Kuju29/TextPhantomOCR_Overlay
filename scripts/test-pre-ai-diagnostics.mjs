import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diagnosticFingerprints } from "../src/background/pipeline/page-translation.js";

const units = Array.from({ length: 41 }, (_, index) => ({
  id: `P${index}`,
  text: `ข้อความ-${index}`,
  paragraphIds: [`p${index}`, `q${index}`],
}));

let calls = 0;
const disabled = await diagnosticFingerprints(units, {
  enabled: false,
  digest: async (...args) => { calls += 1; return crypto.subtle.digest(...args); },
});
assert.equal(disabled, null);
assert.equal(calls, 0, "trace-off must perform zero diagnostic digests");

globalThis.__tpTraceFingerprintKey = new Uint8Array(32).fill(7);
let active = 0;
let peak = 0;
const digest = async (...args) => {
  calls += 1;
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 1));
  try { return await crypto.subtle.digest(...args); }
  finally { active -= 1; }
};
const actual = await diagnosticFingerprints(units, { enabled: true, digest });
assert.equal(calls, units.length + 1);
assert(peak > 1 && peak <= 16, `digest concurrency must be bounded at 16; saw ${peak}`);

const encoder = new TextEncoder();
const oldFingerprint = async (value) => {
  const source = encoder.encode(String(value || ""));
  const keyed = new Uint8Array(globalThis.__tpTraceFingerprintKey.length + source.length);
  keyed.set(globalThis.__tpTraceFingerprintKey);
  keyed.set(source, globalThis.__tpTraceFingerprintKey.length);
  const result = await crypto.subtle.digest("SHA-256", keyed);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const expectedSource = [];
for (const unit of units) expectedSource.push(await oldFingerprint(unit.text));
const expectedPartition = await oldFingerprint(JSON.stringify(
  units.map((unit) => [String(unit.id), unit.paragraphIds.map(String)]),
));
assert.deepEqual(actual.source, expectedSource, "bounded work must preserve fingerprint order and value");
assert.equal(actual.partition, expectedPartition, "partition fingerprint must remain byte-identical");

const source = await readFile(new URL("../src/background/pipeline/page-translation.js", import.meta.url), "utf8");
for (const field of ["fingerprintMs", "workloadOpenMs", "checkpointPreparedMs",
  "checkpointDispatchMs", "pageTranslationToTransportHandoffMs"])
  assert(source.includes(field), `missing pre-provider timing field ${field}`);
assert(!/aiPreProviderTiming[\s\S]{0,900}(?:text|prompt|content)\s*:/.test(source),
  "pre-provider timing event must not include content fields");

console.log("Pre-AI diagnostics: trace-off zero digests; trace-on fingerprints equivalent, ordered and concurrency-bounded; timing fields sanitized.");
