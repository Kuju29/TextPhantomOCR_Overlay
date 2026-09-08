import assert from "node:assert/strict";

import {
  COMPACT_RECORDS_CONTRACT,
  SCHEMA_OBJECT_CONTRACT,
  exactOutputInstruction,
  selectLocalOutputContract,
  translationObjectSchema,
} from "../src/shared/ai/direct-local/output-contract.js";

const ids = ["P0", "P1", "P2"];
const schema = translationObjectSchema(ids);

assert.deepEqual(schema, {
  type: "object",
  properties: {
    P0: { type: "string", minLength: 1 },
    P1: { type: "string", minLength: 1 },
    P2: { type: "string", minLength: 1 },
  },
  required: ids,
  additionalProperties: false,
});
assert.throws(() => translationObjectSchema(["P0", "P2"]), /contiguous P0\.\.Pn/);

const supported = selectLocalOutputContract({
  provider: "ollama",
  model: "qwen3.5:9b",
  modelCapabilities: {
    structuredOutput: {
      supported: true,
      contract: SCHEMA_OBJECT_CONTRACT,
      source: "ollama-format",
      reason: "runtime_confirms_schema",
    },
  },
});
assert.equal(supported.kind, "schema_object");
assert.equal(supported.version, SCHEMA_OBJECT_CONTRACT);
assert.equal(supported.reason, "runtime_confirms_schema");
assert.equal(supported.capabilitySource, "ollama-format");

for (const [structuredOutput, reason] of [
  [{ supported: false, source: "catalogue" }, "provider_model_schema_unsupported"],
  [undefined, "provider_model_schema_unconfirmed"],
]) {
  const selected = selectLocalOutputContract({
    provider: "openai-compatible",
    model: "custom",
    modelCapabilities: structuredOutput ? { structuredOutput } : {},
  });
  assert.equal(selected.kind, "compact_records");
  assert.equal(selected.version, COMPACT_RECORDS_CONTRACT);
  assert.equal(selected.reason, reason);
}

const schemaPrompt = exactOutputInstruction(ids, supported, "th");
assert.match(schemaPrompt, /Return only the JSON object required by the supplied schema/);
assert.match(schemaPrompt, /P0, P1, P2/);
assert.doesNotMatch(schemaPrompt, /<<TP_|compact record|MARKER/i,
  "schema prompt must contain no marker-output grammar");

const compact = selectLocalOutputContract({
  provider: "openai-compatible",
  model: "unknown-model",
  modelCapabilities: {},
});
const compactPrompt = exactOutputInstruction(ids, compact, "th");
assert.match(compactPrompt, /<<TP_Pn:translated text>>/);
assert.doesNotMatch(compactPrompt, /JSON object|schema/i,
  "compact prompt must contain no schema-output grammar");

console.log("Schema output contract selection passed: exact object schema and isolated fallback grammar.");
