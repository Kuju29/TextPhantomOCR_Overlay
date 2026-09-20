import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clearLocalAiPreflightInflightForTest,
  ensureLocalAiBatchReady,
} from "../src/background/local-ai-preflight.js";
import {
  translateWithLocalOpenAi,
} from "../src/shared/ai/direct-local/generation.js";
import {
  LOCAL_CAPABILITY_SNAPSHOTS_KEY,
  LOCAL_MODEL_VERIFICATION_VERSION,
  normalizeLocalConnectionIdentity,
} from "../src/shared/ai/direct-local/verification-snapshot.js";

const endpoint = "http://localhost:11434";
const model = "qwen3.5:9b";
const baseSettings = {
  aiProvider: "ollama",
  aiBaseUrl: endpoint,
  aiModel: model,
  aiLocalThinking: "off",
  aiThinking: "off",
  localAiAdapter: {
    version: 1,
    protocol: "ollama",
    baseUrl: endpoint,
    modelsPath: "/api/tags",
    chatPath: "/api/chat",
    modelsResponsePath: "models.*.name",
    chatResponsePath: "message.content",
    thinking: { parameter: "think", off: false, on: true },
  },
};
const capability = {
  source: "ollama-api",
  models: {
    [model]: {
      recommendedMax: 1,
      reasoning: { supported: true, control: "boolean", source: "ollama-api-show" },
      structuredOutput: {
        supported: true,
        contract: "tp.translation.schema-object/1",
        source: "ollama-api-show",
      },
      limits: { contextTokens: 8192, source: "ollama-api-ps" },
    },
  },
};

function storageHarness(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    get: async (keys) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, state[key]]),
    ),
    set: async (patch) => Object.assign(state, structuredClone(patch)),
  };
}

// A batch started with the popup closed must perform one metadata-only live
// discovery, then carry the exact model controls into the generation settings
// and durable snapshot. Connect/preflight must not load or generate with a model.
{
  clearLocalAiPreflightInflightForTest();
  const store = storageHarness();
  let discoverCalls = 0;
  const result = await ensureLocalAiBatchReady(baseSettings, {
    get: store.get,
    set: store.set,
    emitTrace: () => {},
    discover: async (_adapter, options) => {
      discoverCalls += 1;
      assert.equal(options.provider, "ollama");
      assert.equal(options.model, model);
      assert.equal(options.thinking, "off");
      assert.equal(options.verifySelected, true);
      return {
        ok: true,
        models: [model],
        capability,
        selectedModelVerification: {
          model,
          status: "passed",
          elapsedMs: 12,
          metadataOnly: true,
          evidence: "ollama-api-show",
        },
      };
    },
  });
  assert.equal(discoverCalls, 1);
  assert.equal(result.audit.source, "live_metadata");
  assert.equal(result.settings.aiModelCapabilities.reasoning.control, "boolean");
  assert.equal(result.settings.aiModelCapabilities.structuredOutput.supported, true);
  assert.equal(store.state.aiLocalCapabilityHint.model, model);
  const identity = normalizeLocalConnectionIdentity("ollama", endpoint);
  const snapshot = store.state[LOCAL_CAPABILITY_SNAPSHOTS_KEY][identity];
  assert.equal(snapshot.verifiedModel, model);
  assert.equal(snapshot.verifiedThinking, "off");
  assert.equal(snapshot.verificationStatus, "passed");
  assert.equal(snapshot.metadataOnly, true);
  assert.equal(snapshot.verificationEvidence, "ollama-api-show");

  // The capability discovered by the metadata gate must reach the first real
  // generation. The first translation is intentionally the first generation.
  const originalFetch = globalThis.fetch;
  let generationBody = null;
  globalThis.fetch = async (_url, init) => {
    generationBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      model,
      message: { content: '{"P0":"สวัสดี"}' },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 20,
      eval_count: 5,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const answer = await translateWithLocalOpenAi([{ id: "g0", text: "Hello" }], {
      targetLang: "th",
      canonicalPrompt: {
        version: "translation-plan-3",
        pieces: {
          systemPolicy: "Translate accurately.",
          editableStyle: "Use natural Thai.",
          targetLanguageInstruction: "Target language: Thai.",
          sourceInputContract: "Read every source record.",
          imageHint: "No image.",
          markerOutputContract: "Return exact marker records.",
          structuredOutputContract: "Return the exact schema object.",
          seriesNotesHeading: "Series notes",
        },
      },
      ai: {
        provider: "ollama",
        model,
        base_url: endpoint,
        local_adapter: baseSettings.localAiAdapter,
        model_capabilities: result.settings.aiModelCapabilities,
        thinking: "off",
        prompt: "Use natural Thai.",
        promptMode: "replace",
      },
    });
    assert.equal(answer.translations[0].text, "สวัสดี");
    assert.equal(generationBody.think, false,
      "metadata discovery must apply exact native think:false on the first real generation");
    assert.equal(typeof generationBody.format, "object",
      "metadata discovery must apply the selected model's native schema capability");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const cached = await ensureLocalAiBatchReady(baseSettings, {
    get: store.get,
    set: store.set,
    emitTrace: () => {},
    discover: async () => {
      discoverCalls += 1;
      throw new Error("fresh exact metadata snapshot should avoid another discovery");
    },
  });
  assert.equal(discoverCalls, 1);
  assert.equal(cached.audit.source, "fresh_snapshot");
  assert.equal(cached.settings.aiModelCapabilities.reasoning.supported, true);

  delete store.state[LOCAL_CAPABILITY_SNAPSHOTS_KEY][identity].verificationVersion;
  const upgraded = await ensureLocalAiBatchReady(baseSettings, {
    get: store.get, set: store.set, emitTrace: () => {},
    discover: async () => {
      discoverCalls += 1;
      return { models: [model], capability,
        selectedModelVerification: { model, status: "passed" } };
    },
  });
  assert.equal(discoverCalls, 2, "an older metadata schema requires a fresh metadata check");
  assert.equal(upgraded.audit.source, "live_metadata");
  assert.equal(store.state[LOCAL_CAPABILITY_SNAPSHOTS_KEY][identity].verificationVersion,
    LOCAL_MODEL_VERIFICATION_VERSION);
}

// Availability metadata is independent from the user's reasoning preference.
// Changing Off/On/Lowest must not repeat Local discovery or load the model.
{
  clearLocalAiPreflightInflightForTest();
  const identity = normalizeLocalConnectionIdentity("ollama", endpoint);
  const store = storageHarness({
    [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: {
      [identity]: {
        identity,
        provider: "ollama",
        endpoint,
        models: [model],
        capability,
        verifiedModel: model,
        verifiedThinking: "off",
        metadataOnly: true,
        verificationStatus: "passed",
        verificationVersion: LOCAL_MODEL_VERIFICATION_VERSION,
        checkedAt: Date.now(),
      },
    },
  });
  let calls = 0;
  const onSettings = { ...baseSettings, aiLocalThinking: "on", aiThinking: "on" };
  const result = await ensureLocalAiBatchReady(onSettings, {
    get: store.get,
    set: store.set,
    emitTrace: () => {},
    discover: async () => {
      calls += 1;
      throw new Error("reasoning preference must not invalidate model availability");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.audit.source, "fresh_snapshot");
  assert.equal(result.settings.aiModelCapabilities.reasoning.control, "boolean");
}

// All images must be stopped before enqueue when the exact selected model is
// unavailable; do not let every image discover the same failure independently.
{
  clearLocalAiPreflightInflightForTest();
  const store = storageHarness();
  await assert.rejects(
    ensureLocalAiBatchReady(baseSettings, {
      get: store.get,
      set: store.set,
      emitTrace: () => {},
      discover: async () => ({
        ok: true,
        models: ["another-model"],
        capability: { models: {} },
        selectedModelVerification: { model, status: "model_unavailable" },
      }),
    }),
    (error) => {
      assert.equal(error.code, "LOCAL_MODEL_UNAVAILABLE");
      assert.equal(error.requestDispatched, false);
      assert.equal(error.providerAttempts, 0);
      assert.equal(error.profileValidationStage, "local_model_preflight");
      return true;
    },
  );
  assert.equal(store.state.aiLocalCapabilityHint, null,
    "failed automatic verification must clear stale active capabilities");
}

// Simultaneous start paths coalesce into one metadata discovery.
{
  clearLocalAiPreflightInflightForTest();
  const store = storageHarness();
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const discover = async () => {
    calls += 1;
    await wait;
    return {
      ok: true,
      models: [model],
      capability,
      selectedModelVerification: { model, status: "passed" },
    };
  };
  const firstSettings = { ...baseSettings, aiPrompt: "Translate as prose.", aiMemoryMode: "off" };
  const secondSettings = { ...baseSettings, aiPrompt: "Translate as verse.", aiMemoryMode: "full" };
  const first = ensureLocalAiBatchReady(firstSettings, {
    get: store.get, set: store.set, discover, emitTrace: () => {}, force: true,
  });
  const second = ensureLocalAiBatchReady(secondSettings, {
    get: store.get, set: store.set, discover, emitTrace: () => {}, force: true,
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.settings.aiModelCapabilities.reasoning.control, "boolean");
  assert.equal(b.settings.aiModelCapabilities.reasoning.control, "boolean");
  assert.equal(a.settings.aiPrompt, firstSettings.aiPrompt);
  assert.equal(b.settings.aiPrompt, secondSettings.aiPrompt);
  assert.equal(a.settings.aiMemoryMode, "off");
  assert.equal(b.settings.aiMemoryMode, "full");
  assert.notEqual(a, b);
  a.settings.aiLocalCapabilityHint.modelCapabilities.reasoning.control = "changed";
  a.settings.aiModelCapabilities.reasoning.control = "changed";
  a.audit.source = "changed";
  assert.equal(b.settings.aiLocalCapabilityHint.modelCapabilities.reasoning.control, "boolean");
  assert.equal(b.settings.aiModelCapabilities.reasoning.control, "boolean");
  assert.equal(b.audit.source, "live_metadata");
}

const contextMenu = await readFile(
  new URL("../src/background/context-menu.js", import.meta.url),
  "utf8",
);
assert.match(contextMenu, /ensureLocalAiBatchReady\(settings/);
assert.ok(
  contextMenu.indexOf("ensureLocalAiBatchReady(settings") <
    contextMenu.indexOf("const batchId = crypto.randomUUID()"),
  "Local verification must complete before the batch and per-image jobs exist",
);

console.log("Background Local AI preflight passed: metadata-only readiness is shared and first translation is first generation.");
