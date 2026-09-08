import assert from "node:assert/strict";

import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { SCHEMA_OBJECT_CONTRACT } from "../src/shared/ai/direct-local/output-contract.js";

const originalFetch = globalThis.fetch;
const plan = {
  version: "translation-plan-2",
  pieces: {
    systemPolicy: "POLICY SENTINEL",
    editableStyle: "Target language: Thai\nSTYLE SENTINEL",
    targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
    sourceInputContract: "SOURCE CONTRACT SENTINEL",
    imageHint: "IMAGE SENTINEL",
    markerOutputContract: "MARKER OUTPUT SENTINEL",
    structuredOutputContract: "SCHEMA OUTPUT SENTINEL",
    seriesNotesHeading: "SERIES SENTINEL",
  },
};

function ai(modelCapabilities) {
  return {
    provider: "ollama",
    model: "qwen3.5:9b",
    base_url: "http://localhost:11434",
    local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
    prompt: "STYLE SENTINEL",
    promptMode: "replace",
    model_capabilities: modelCapabilities,
  };
}

async function run({ modelCapabilities, answer, units = [{ id: "g0", text: "原文" }] }) {
  const requests = [];
  const wire = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      model: "qwen3.5:9b",
      message: { role: "assistant", content: answer },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 20,
      eval_count: 10,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await translateWithLocalOpenAi(units, {
    ai: ai(modelCapabilities), canonicalPrompt: plan, targetLang: "th",
    wireTrace: async (stage, value) => wire.push({ stage, value }),
  });
  return { result, requests, wire };
}

try {
  const supportedCapabilities = {
    structuredOutput: {
      supported: true,
      contract: SCHEMA_OBJECT_CONTRACT,
      source: "ollama-api-show",
      reason: "ollama_format_schema_supported",
    },
  };
  const schema = await run({
    modelCapabilities: supportedCapabilities,
    units: [{ id: "g0", text: "一" }, { id: "g1", text: "二" }, { id: "g2", text: "三" }],
    answer: JSON.stringify({ P2: "สาม", P0: "หนึ่ง", P1: "สอง" }),
  });
  assert.equal(schema.requests.length, 1, "one image must issue exactly one provider request");
  const schemaBody = schema.requests[0].body;
  assert.deepEqual(schemaBody.format.required, ["P0", "P1", "P2"]);
  assert.deepEqual(Object.keys(schemaBody.format.properties), ["P0", "P1", "P2"]);
  assert.equal(schemaBody.format.additionalProperties, false);
  const schemaSystem = schemaBody.messages[0].content;
  const schemaUser = schemaBody.messages[1].content;
  assert.match(schemaSystem, /expert translator/);
  assert.match(schemaSystem, /TRANSLATION STYLE\nSTYLE SENTINEL/);
  assert.doesNotMatch(schemaSystem, /OUTPUT —|P0/);
  assert.match(schemaUser, /TRANSLATION TASK/);
  assert.match(schemaUser, /Translate every source unit into Thai \(ภาษาไทย\)\./);
  assert.doesNotMatch(schemaUser, /TRANSLATION STYLE\nSTYLE SENTINEL/);
  assert.match(schemaUser, /Return only the JSON object required by the supplied schema/);
  assert.doesNotMatch(schemaUser, /MARKER OUTPUT SENTINEL|compact record|<<TP_Pn:/,
    "schema user content must contain no marker-output grammar");
  assert.ok(schemaUser.endsWith("SOURCE TEXT\nP0:一\nP1:二\nP2:三"),
    "schema source must use plain attributable IDs without compact markers");
  assert.equal((schemaUser.match(/OUTPUT —/g) || []).length, 1,
    "provider must see exactly one chosen output-contract section in the user message");
  assert.deepEqual(schema.result.translations.map(({ id, text }) => ({ id, text })), [
    { id: "g0", text: "หนึ่ง" }, { id: "g1", text: "สอง" }, { id: "g2", text: "สาม" },
  ]);
  assert.equal(schema.result.meta.requestedContract, SCHEMA_OBJECT_CONTRACT);
  assert.equal(schema.result.meta.selectedContract, SCHEMA_OBJECT_CONTRACT);
  assert.equal(schema.result.meta.selectedContractKind, "schema_object");
  assert.equal(schema.result.meta.selectedContractReason, "ollama_format_schema_supported");
  assert.equal(schema.result.meta.capabilitySource, "ollama-api-show");
  const schemaSelection = schema.wire.find(({ stage }) => stage === "contractSelection")?.value;
  const schemaApplied = schema.wire.find(({ stage }) => stage === "contractApplied")?.value;
  assert.deepEqual(schemaSelection, {
    requested: SCHEMA_OBJECT_CONTRACT, selected: SCHEMA_OBJECT_CONTRACT,
    kind: "schema_object", reason: "ollama_format_schema_supported",
    capabilitySource: "ollama-api-show", provider: "ollama", model: "qwen3.5:9b",
    automaticRetry: false,
  });
  assert.equal(schemaApplied.selected, SCHEMA_OBJECT_CONTRACT);
  assert.equal(schemaApplied.applied, "schema-object-v1");
  assert.equal(schemaApplied.providerAttempts, 1);
  assert.equal(schemaApplied.automaticRetry, false);

  for (const [modelCapabilities, expectedReason] of [
    [{ structuredOutput: { supported: false, source: "catalogue" } }, "provider_model_schema_unsupported"],
    [{}, "provider_model_schema_unconfirmed"],
  ]) {
    const fallback = await run({ modelCapabilities, answer: "<<TP_P0:หนึ่ง>>" });
    assert.equal(fallback.requests.length, 1);
    const body = fallback.requests[0].body;
    assert.equal("format" in body, false, "fallback must not send Ollama format schema");
    assert.equal("response_format" in body, false);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    assert.match(system, /TRANSLATION STYLE\nSTYLE SENTINEL/);
    assert.doesNotMatch(system, /<<TP_Pn:|OUTPUT —/);
    assert.match(user, /<<TP_Pn:translated text>>/);
    assert.doesNotMatch(user, /SCHEMA OUTPUT SENTINEL|Return only one JSON object/,
      "fallback user content must contain no schema-output grammar");
    assert.equal((user.match(/OUTPUT —/g) || []).length, 1);
    assert.equal(fallback.result.meta.selectedContract, "tp.translation.compact-records/1");
    assert.equal(fallback.result.meta.selectedContractKind, "compact_records");
    assert.equal(fallback.result.meta.selectedContractReason, expectedReason);
    assert.equal(fallback.wire.find(({ stage }) => stage === "contractSelection").value.reason,
      expectedReason);
  }

  let malformedCalls = 0;
  globalThis.fetch = async () => {
    malformedCalls += 1;
    return new Response(JSON.stringify({ message: { content: '{"P0":"หนึ่ง"' }, done: true,
      done_reason: "stop" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "g0", text: "一" }], {
      ai: ai(supportedCapabilities), canonicalPrompt: plan, targetLang: "th",
    }),
    (error) => error?.code === "AI_OUTPUT_CONTRACT_MISMATCH" &&
      error?.diagnostics?.validatorSubtype === "invalid_json" &&
      error?.providerAttempts === 1,
    "malformed schema output must fail visibly without silently retrying as markers",
  );
  assert.equal(malformedCalls, 1, "schema failure must not turn one image into two provider requests");

  console.log("Schema routing integration passed: payload, prompt isolation, logs and one-request invariant.");
} finally {
  globalThis.fetch = originalFetch;
}
