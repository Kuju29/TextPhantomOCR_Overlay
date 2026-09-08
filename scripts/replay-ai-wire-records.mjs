import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeTranslations } from "../src/shared/ai/direct-local/decode.js";
import { readProviderResponse } from "../src/shared/ai/providers/local-transport-runtime.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";

const root = process.argv[2] || process.env.TP_REPLAY_AI_WIRE_DIR;
if (!root) {
  throw new Error("usage: node scripts/replay-ai-wire-records.mjs <logs/ai-wire directory>");
}

const operationNames = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

assert.ok(operationNames.length, "replay input has no AI wire operations");
let recordCount = 0;
let wireAssemblies = 0;
let artifactComparisons = 0;
const engines = new Set();
const providers = new Set();

for (const operationName of operationNames) {
  const operationDir = path.join(root, operationName);
  const [identity, units, wireDocument, assembled, responseMeta, rawResponse] = await Promise.all([
    readFile(path.join(operationDir, "00_identity.json"), "utf8").then(JSON.parse),
    readFile(path.join(operationDir, "01_units.json"), "utf8").then(JSON.parse),
    readFile(path.join(operationDir, "03_wire_units.json"), "utf8").then(JSON.parse),
    readFile(path.join(operationDir, "05_provider_response.assembled.txt"), "utf8"),
    readFile(path.join(operationDir, "05_provider_response.meta.json"), "utf8")
      .then(JSON.parse).catch(() => null),
    readFile(path.join(operationDir, "05_provider_response.raw"), "utf8").catch(() => ""),
  ]);
  const wireUnits = Array.isArray(wireDocument) ? wireDocument : wireDocument.units;
  const nativeSchema = Array.isArray(wireDocument)
    ? true
    : wireDocument?.contract?.nativeSchema === true;

  assert.ok(Array.isArray(units) && units.length, `${operationName}: invalid source units`);
  assert.equal(wireUnits?.length, units.length, `${operationName}: wire/source count drift`);
  assert.equal(nativeSchema, true, `${operationName}: audit replay expected schema-object contract`);

  const adapter = identity.provider === "ollama"
    ? createOllamaAdapter({ baseUrl: "http://127.0.0.1:11434" })
    : createOpenAiCompatibleAdapter({ baseUrl: "http://127.0.0.1:1234/v1" });
  const wireRaw = identity.provider === "ollama"
    ? (Array.isArray(responseMeta?.chunks) ? responseMeta.chunks.join("") : rawResponse)
    : rawResponse;
  assert.ok(wireRaw, `${operationName}: no replayable raw/meta provider evidence`);
  const contentType = identity.provider === "ollama" ? "application/x-ndjson" : "text/event-stream";
  const replayResponse = new Response(wireRaw, { status: 200, headers: { "content-type": contentType } });
  const stream = await readProviderResponse(replayResponse, adapter, {
    expectedIds: wireUnits.map((item) => String(item.id)),
  });
  const replayAssembled = adapter.responseText(stream.data);
  assert.equal(replayAssembled.replace(/\r\n?/g, "\n"), assembled.replace(/\r\n?/g, "\n"),
    `${operationName}: adapter assembly drifted from recorded artifact`);
  wireAssemblies += 1;

  const decoded = decodeTranslations(replayAssembled, units, {
    structured: true,
    wireUnits,
  });
  assert.equal(decoded.translations.length, units.length,
    `${operationName}: decoded record count drift`);
  assert.deepEqual(decoded.translations.map((item) => item.id), units.map((item) => item.id),
    `${operationName}: decoded IDs no longer map to source IDs`);
  assert.ok(decoded.translations.every((item) => typeof item.text === "string" && item.text.trim()),
    `${operationName}: decoded response contains an empty translation`);

  const recordedParsed = JSON.parse(await readFile(path.join(operationDir, "06_parsed_records.json"), "utf8"));
  const recordedTranslations = Array.isArray(recordedParsed)
    ? recordedParsed : recordedParsed.translations;
  if (recordedTranslations) {
    assert.deepEqual(decoded.translations, recordedTranslations,
      `${operationName}: decoder output drifted from 06_parsed_records.json`);
  } else {
    const applied = JSON.parse(await readFile(path.join(operationDir, "08_apply_result.json"), "utf8"));
    assert.deepEqual(decoded.translations.map((item) => item.text),
      (applied.translations || []).map((item) => item.text),
      `${operationName}: decoded text drifted from 08_apply_result.json`);
  }
  artifactComparisons += 1;

  const terminal = JSON.parse(await readFile(path.join(operationDir, "11_terminal.json"), "utf8"));
  const decodedMissing = new Set((decoded.missing || []).map(String));
  if (terminal.state === "succeeded") assert.equal(decodedMissing.size, 0,
    `${operationName}: terminal claims success for incomplete decoded records`);
  if (terminal.complete === true)
    assert.equal(decodedMissing.size, 0,
      `${operationName}: terminal claims complete for missing decoded records`);
  artifactComparisons += 1;

  recordCount += units.length;
  engines.add(identity.engine);
  providers.add(identity.provider);
}

console.log(JSON.stringify({
  operations: operationNames.length,
  records: recordCount,
  engines: [...engines].sort(),
  providers: [...providers].sort(),
  wireAssemblies,
  artifactComparisons,
  providerCalls: 0,
}));
