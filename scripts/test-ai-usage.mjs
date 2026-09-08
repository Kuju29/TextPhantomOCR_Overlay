const comparisonSummary = u => Object.fromEntries(["runtime","provider","model","requests","inputTokens","outputTokens","totalTokens","tokensReported","tokenStatus"].map(k => [k,u[k]]));
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyUsageSelectionBoundary, currentUsage, failureUsageDetails, normalizeUsageLedger, persistUsageSelectionBoundary, recordProviderGeneration, recordUsage, resetActiveUsage, usageHistoryRows, usageKey, usageRows, AI_USAGE_SESSION_LIMIT, AI_USAGE_DELTA_LIMIT } from "../src/shared/ai-usage.js";

let sequence = 0;
const opts = (now) => ({ now, id: () => `s${++sequence}` });
let ledger;
ledger = recordUsage(ledger, { runtime: "cloud", provider: "gemini", model: "A", engine: "runsextension", inputTokens: 10, outputTokens: 5, totalTokens: 15 }, opts(1));
ledger = recordUsage(ledger, { runtime: "cloud", provider: "gemini", model: "B", engine: "runsapi", inputTokens: null, outputTokens: null, totalTokens: null }, opts(2));
ledger = recordUsage(ledger, { runtime: "cloud", provider: "gemini", model: "A", engine: "runsextension", inputTokens: 8, outputTokens: 4, totalTokens: 12 }, opts(3));
assert.equal(ledger.models[usageKey("cloud", "gemini", "A")].sessions.length, 2);
assert.equal(ledger.models[usageKey("cloud", "gemini", "B")].sessions[0].totalTokens, null);
const beforeReset = ledger.models[ledger.active.selectionKey].sessions.length;
ledger = resetActiveUsage(ledger, opts(4));
assert.equal(ledger.models[ledger.active.selectionKey].sessions.length, beforeReset + 1);
assert.equal(ledger.models[ledger.active.selectionKey].sessions.at(-1).requests, 0);
assert.equal(ledger.models[ledger.active.selectionKey].sessions.at(-2).resetReason, "manual");
const historySnapshot = structuredClone(ledger);
const resetHistory = usageHistoryRows(ledger);
assert.deepEqual(ledger, historySnapshot, "reading History never mutates the ledger or active session");
assert.equal(resetHistory[0].current, true);
assert.equal(resetHistory[1].resetReason, "manual", "Reset retains the closed session in History");
assert.equal(resetHistory[1].inputTokens, 8);
assert.equal(resetHistory[1].outputTokens, 4);
assert.equal(resetHistory[1].totalTokens, 12);
assert.equal(resetHistory[1].extensionRequests, 1);
assert.equal(resetHistory[1].apiRequests, 0);
assert.ok(!("deltas" in resetHistory[1]) && !("traceId" in resetHistory[1]) && !("baseUrl" in resetHistory[1]),
  "History exposes counters, not private content or provenance identifiers");
let mixedHistory;
mixedHistory = recordUsage(mixedHistory, {
  runtime: "cloud", provider: "openrouter", model: "cloud-model", engine: "runsapi", totalTokens: 9,
}, opts(100));
mixedHistory = recordUsage(mixedHistory, {
  runtime: "local", provider: "ollama", model: "local-model", engine: "runsextension", totalTokens: null,
}, opts(200));
const mixedRows = usageHistoryRows(mixedHistory);
assert.deepEqual(mixedRows.map((row) => row.runtime), ["local", "cloud"],
  "History sorts sessions newest first across Local and Cloud models");
assert.equal(mixedRows[0].totalTokens, null, "unknown totals remain nullable in History");
assert.equal(mixedRows[1].apiRequests, 1);
ledger = recordUsage(ledger, { runtime: "local", provider: "ollama", model: "same", engine: "runsextension" }, opts(5));
ledger = recordUsage(ledger, { runtime: "cloud", provider: "openrouter", model: "same", engine: "runsapi" }, opts(6));
assert.ok(ledger.models[usageKey("local", "ollama", "same")]);
assert.ok(ledger.models[usageKey("cloud", "openrouter", "same")]);
assert.equal(usageRows({ broken: true }).length, 0);
let concurrent;
concurrent = recordUsage(concurrent, { runtime: "cloud", provider: "p", model: "new", startedAt: 20 }, opts(30));
concurrent = recordUsage(concurrent, { runtime: "cloud", provider: "p", model: "old", startedAt: 10 }, opts(40));
assert.equal(concurrent.active.selectionKey, usageKey("cloud", "p", "new"), "a late old-model reply cannot steal the active session");

let boundary;
boundary = recordUsage(boundary, { runtime: "cloud", provider: "gemini", model: "A", startedAt: 10 }, opts(20));
boundary = applyUsageSelectionBoundary(boundary, { runtime: "cloud", provider: "gemini", model: "B", reason: "model_switch" }, { now: 30 });
assert.equal(boundary.active, null, "selection boundary closes A immediately");
assert.equal(boundary.models[usageKey("cloud", "gemini", "A")].sessions[0].resetReason, "model_switch");
assert.equal(boundary.models[usageKey("cloud", "gemini", "B")], undefined, "selection alone never pollutes used-model rows");
assert.equal(usageRows(boundary).length, 1);
assert.deepEqual(comparisonSummary(currentUsage(boundary)), {
  runtime: "cloud", provider: "gemini", model: "B", requests: 0,
  inputTokens: null, outputTokens: null, totalTokens: 0,
  tokensReported: false, tokenStatus: "not_used",
}, "the selected model immediately renders a fresh zero comparison");
boundary = resetActiveUsage(boundary, opts(35));
assert.equal(boundary.models[usageKey("cloud", "gemini", "B")], undefined, "resetting unused B remains pending and hidden");
assert.equal(boundary.selection.pendingReset.at, 35);
boundary = normalizeUsageLedger(structuredClone(boundary));
assert.equal(boundary.selection.pendingReset.at, 35, "popup reload preserves pending B reset boundary");
boundary = recordUsage(boundary, { runtime: "cloud", provider: "gemini", model: "A", startedAt: 25, totalTokens: 3 }, opts(40));
assert.equal(boundary.active, null, "late A dispatched before B boundary is historical, never active");
assert.equal(boundary.selection.model, "B");
boundary = recordUsage(boundary, { runtime: "cloud", provider: "gemini", model: "B", startedAt: 41, totalTokens: 7 }, opts(50));
assert.equal(boundary.active.selectionKey, usageKey("cloud", "gemini", "B"));
assert.equal(boundary.models[boundary.active.selectionKey].sessions[0].startedAt, 35, "first real B use materializes its pending reset session");
assert.equal(currentUsage(boundary).requests, 1);
assert.equal(currentUsage(boundary).totalTokens, 7);
assert.equal(currentUsage(boundary).tokenStatus, "incomplete",
  "a provider total without input/output must be labelled incomplete, not silently complete");

let completeUsage;
completeUsage = recordUsage(completeUsage, {
  runtime: "local", provider: "ollama", model: "qwen",
  inputTokens: 20, outputTokens: 5, totalTokens: 25,
}, opts(60));
assert.deepEqual(comparisonSummary(currentUsage(completeUsage, {
  runtime: "local", provider: "ollama", model: "qwen",
})), {
  runtime: "local", provider: "ollama", model: "qwen", requests: 1,
  inputTokens: 20, outputTokens: 5, totalTokens: 25,
  tokensReported: true, tokenStatus: "reported",
});
boundary = applyUsageSelectionBoundary(boundary, { runtime: "cloud", provider: "gemini", model: "C" }, { now: 60 });
boundary = applyUsageSelectionBoundary(boundary, { runtime: "local", provider: "ollama", model: "D", reason: "provider_switch" }, { now: 61 });
assert.equal(boundary.selection.selectionKey, usageKey("local", "ollama", "D"), "rapid A/B/C provider-model boundaries keep the latest selection");
assert.equal(boundary.models[usageKey("cloud", "gemini", "C")], undefined);
for (let i = 0; i < AI_USAGE_SESSION_LIMIT + 4; i++) {
  ledger = recordUsage(ledger, { runtime: "cloud", provider: "p", model: "cap", engine: "runsapi" }, opts(10 + i * 2));
  ledger = resetActiveUsage(ledger, opts(11 + i * 2));
}
assert.equal(ledger.models[usageKey("cloud", "p", "cap")].sessions.length, AI_USAGE_SESSION_LIMIT);
assert.equal(usageHistoryRows(ledger).filter((row) => row.model === "cap").length, AI_USAGE_SESSION_LIMIT,
  "History respects the retained per-model session limit");
const extensionFailure = failureUsageDetails({
  generationAttempts: 1,
  structuralDetails: { generationMeta: {
    provider: "openrouter", model: "charged-model", providerMs: 321,
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
  } },
});
assert.deepEqual(extensionFailure, {
  usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
  provider: "openrouter", model: "charged-model", inputTokens: 100, outputTokens: 25,
  totalTokens: 125, baseUrl: "", providerMs: 321, totalMs: Number.NaN, finishReason: "", generationAttempts: 1,
});
const fallbackEnvelope = {
  code: "invalid_model_output", generationAttempts: 1,
  provider: "auto", model: "auto",
  structuralDetails: {
    resolvedProvider: "openrouter",
    resolvedModel: "deepseek/deepseek-v4-flash-0731",
    generationMeta: {
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      finish_reason: "length",
    },
  },
};
const fallbackCharged = failureUsageDetails(fallbackEnvelope);
assert.equal(fallbackCharged.provider, "openrouter", "resolved provider wins over requested auto");
assert.equal(fallbackCharged.model, "deepseek/deepseek-v4-flash-0731", "resolved model wins over requested auto");
let fallbackLedger = recordUsage(undefined, {
  runtime: "cloud", provider: fallbackCharged.provider, model: fallbackCharged.model,
  engine: "runsextension", requests: 1, failures: 1,
  inputTokens: fallbackCharged.inputTokens, outputTokens: fallbackCharged.outputTokens,
  totalTokens: fallbackCharged.totalTokens,
}, opts(90));
assert.equal(fallbackLedger.models[usageKey("cloud", "openrouter", "deepseek/deepseek-v4-flash-0731")].sessions[0].totalTokens, 125);
const apiFailure = failureUsageDetails({
  generation_attempts: 2, generationMeta: {
    provider: "ollama", used_model: "local-model", provider_ms: 456, total_ms: 500,
    usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
  },
});
assert.equal(apiFailure.provider, "ollama");
assert.equal(apiFailure.model, "local-model");
assert.equal(apiFailure.totalTokens, 100);
assert.equal(apiFailure.generationAttempts, 2);
const laterBatchFailure = failureUsageDetails({
  generationAttempts: 2,
  generationMeta: {
    provider: "ollama", model: "qwen-batched", generationAttempts: 2,
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    accumulatedUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  },
  diagnostics: {
    completedBatchCount: 1,
    accumulatedUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  },
});
assert.equal(laterBatchFailure.inputTokens, 28);
assert.equal(laterBatchFailure.outputTokens, 13);
assert.equal(laterBatchFailure.totalTokens, 41,
  "completed-batch usage plus the failed generation is counted once despite mirrored diagnostics");
let batchedFailureLedger = recordUsage(undefined, {
  runtime: "local", provider: laterBatchFailure.provider, model: laterBatchFailure.model,
  engine: "runsextension", requests: laterBatchFailure.generationAttempts,
  failures: laterBatchFailure.generationAttempts,
  inputTokens: laterBatchFailure.inputTokens, outputTokens: laterBatchFailure.outputTokens,
  totalTokens: laterBatchFailure.totalTokens,
}, opts(96));
assert.equal(currentUsage(batchedFailureLedger, {
  runtime: "local", provider: "ollama", model: "qwen-batched",
}).totalTokens, 41, "the current Provider/Model usage UI session includes charged prior batches");
assert.equal(batchedFailureLedger.models[usageKey("local", "ollama", "qwen-batched")].sessions[0].requests, 2);
const missingFailure = failureUsageDetails({ generationAttempts: 1, structuralDetails: {} });
assert.equal(missingFailure.inputTokens, null);
assert.equal(missingFailure.outputTokens, null);
assert.equal(missingFailure.totalTokens, null);
let failedLedger;
for (const [engine, charged] of [["runsextension", extensionFailure], ["runsapi", apiFailure]]) {
  failedLedger = recordUsage(failedLedger, {
    runtime: charged.provider === "ollama" ? "local" : "cloud",
    provider: charged.provider, model: charged.model, engine,
    requests: charged.generationAttempts, failures: charged.generationAttempts,
    inputTokens: charged.inputTokens, outputTokens: charged.outputTokens, totalTokens: charged.totalTokens,
  }, opts(100 + sequence));
}
assert.equal(failedLedger.models[usageKey("cloud", "openrouter", "charged-model")].sessions[0].totalTokens, 125);
assert.equal(failedLedger.models[usageKey("cloud", "openrouter", "charged-model")].sessions[0].failures, 1);
assert.equal(failedLedger.models[usageKey("local", "ollama", "local-model")].sessions[0].totalTokens, 100);
assert.equal(failedLedger.models[usageKey("local", "ollama", "local-model")].sessions[0].failures, 2);

// Provider-generation provenance is deterministic and idempotent. These are
// the three charged generations from trace-20260902-211332.jsonl.
let provenanceLedger;
const tracedGenerations = [
  ["tmtk6husxt13o", 2087, 1986, 4073],
  ["tmtk6ih6uz8n0", 2218, 3312, 5530],
  ["tmtk6jrqdrrso", 2251, 2685, 4936],
];
for (const [traceId, inputTokens, outputTokens, totalTokens] of tracedGenerations) {
  provenanceLedger = recordProviderGeneration(provenanceLedger, {
    runtime: "cloud", provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731",
    engine: "runsextension", traceId, requestId: `request-${traceId}`,
    operationId: `operation-${traceId}`, reason: "provider_charged_failure",
    success: false, requests: 1, failures: 1, generationAttempts: 1,
    inputTokens, outputTokens, totalTokens,
  }, opts(300 + sequence));
}
const provenanceSession = provenanceLedger.models[
  usageKey("cloud", "openrouter", "deepseek/deepseek-v4-flash-0731")
].sessions[0];
assert.equal(provenanceSession.requests, 3);
assert.equal(provenanceSession.inputTokens, 6556);
assert.equal(provenanceSession.outputTokens, 7983);
assert.equal(provenanceSession.totalTokens, 14539);
assert.deepEqual(provenanceSession.deltas.map((delta) => delta.traceId), tracedGenerations.map(([id]) => id));
assert.ok(provenanceSession.deltas.every((delta) => delta.sessionId === provenanceSession.id));
assert.ok(provenanceSession.deltas.every((delta) => delta.reason === "provider_charged_failure"));

const beforeDuplicate = structuredClone(provenanceLedger);
provenanceLedger = recordProviderGeneration(provenanceLedger, {
  runtime: "cloud", provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731",
  engine: "runsapi", traceId: tracedGenerations[0][0], operationId: `operation-${tracedGenerations[0][0]}`,
  reason: "translation_success", totalTokens: 4073,
}, opts(999));
assert.deepEqual(provenanceLedger, beforeDuplicate, "the same provider generation cannot count twice across route/error handling");
assert.deepEqual(recordProviderGeneration(provenanceLedger, {
  runtime: "cloud", provider: "openrouter", model: "model-list", replayed: true,
  operationId: "replay", totalTokens: 99,
}, opts(1000)), provenanceLedger, "replayed responses do not count");
assert.deepEqual(recordProviderGeneration(provenanceLedger, {
  runtime: "cloud", provider: "openrouter", model: "cancelled", dispatched: false,
  operationId: "cancel-before-dispatch", totalTokens: 99,
}, opts(1001)), provenanceLedger, "cancellation before dispatch does not count");

const migrated = normalizeUsageLedger({
  version: 1, active: { selectionKey: "cloud|p|m", sessionId: "legacy" }, selection: null,
  models: { "cloud|p|m": { provider: "p", model: "m", runtime: "cloud", sessions: [{ id: "legacy", requests: 2 }] } },
});
assert.deepEqual(migrated.models["cloud|p|m"].sessions[0].deltas, [], "legacy sessions migrate with empty provenance");
assert.deepEqual(usageHistoryRows(undefined), [], "empty ledger renders an empty History");
const legacyHistory = usageHistoryRows(migrated);
assert.equal(legacyHistory.length, 1);
assert.equal(legacyHistory[0].requests, 2);
assert.equal(legacyHistory[0].inputTokens, null, "legacy missing token counters remain unknown, never zero");
assert.deepEqual(normalizeUsageLedger({ version: 1, models: { bad: { sessions: "corrupt" } } }).models, {}, "corrupt history is discarded");
let cappedDeltas;
for (let i = 0; i < AI_USAGE_DELTA_LIMIT + 3; i++) cappedDeltas = recordProviderGeneration(cappedDeltas, {
  runtime: "cloud", provider: "p", model: "delta-cap", operationId: `delta-${i}`, totalTokens: 1,
}, opts(1100 + i));
assert.equal(cappedDeltas.models[usageKey("cloud", "p", "delta-cap")].sessions[0].deltas.length, AI_USAGE_DELTA_LIMIT);
const localOrchestration = fs.readFileSync(new URL("../src/shared/ai/direct-local/generation.js", import.meta.url), "utf8");
const ollamaProvider = fs.readFileSync(new URL("../src/shared/ai/providers/local-ollama.js", import.meta.url), "utf8");
const compatibleProvider = fs.readFileSync(new URL("../src/shared/ai/providers/local-openai-compatible.js", import.meta.url), "utf8");
assert.doesNotMatch(localOrchestration, /prompt_eval_count|completion_tokens|eval_duration/,
  "prompt/decode orchestration must not know provider usage wire fields");
assert.match(ollamaProvider, /localProviderUsage/);
const usageValues = fs.readFileSync(new URL("../src/shared/ai/usage-values.js", import.meta.url), "utf8");
assert.match(usageValues, /prompt_eval_count/);
assert.match(compatibleProvider, /localProviderUsage/);
assert.match(usageValues, /prompt_tokens/);
assert.match(usageValues, /completion_tokens/);
const serverTranslation = fs.readFileSync(new URL("../src/background/pipeline/server-translation.js", import.meta.url), "utf8");
assert.doesNotMatch(serverTranslation, /PROVIDER_BACKPRESSURE_MAX_WAIT_MS|stayed rate limited for 90s/);
assert.match(serverTranslation, /await\s+waitForRetry\(\s*code\s*===\s*"server_busy"\s*\?\s*serverRetryMs\s*:\s*retryAfterMs\s*,\s*ctrl\.signal\s*,?\s*\)/);
assert.match(serverTranslation, /engine: "runsapi"/);
assert.match(serverTranslation, /const charged = failureUsageDetails\(error\)/);
const directTransport = fs.readFileSync(new URL("../src/background/ai/transports/direct-local.js", import.meta.url), "utf8");
const serverTransport = fs.readFileSync(new URL("../src/background/ai/transports/server.js", import.meta.url), "utf8");
assert.match(directTransport, /engine: "runsextension"/);
assert.match(directTransport, /requestedOutputTokens/);
assert.match(directTransport, /finishReason/);
assert.match(serverTransport, /failureUsageDetails\(detailObject\)/);
assert.doesNotMatch(directTransport + serverTransport, /persistUsageEvent/, "runtime uses the canonical provider-generation boundary");
assert.doesNotMatch(serverTranslation, /persistUsageEvent/, "runsapi uses the canonical provider-generation boundary");
const popupSource = fs.readFileSync(new URL("../src/popup/popup.js", import.meta.url), "utf8");
assert.doesNotMatch(popupSource, /recordProviderGeneration|persistProviderGeneration/, "popup/model discovery never records translation usage");
const probeSource = fs.readFileSync(new URL("../api/backend/ai/probe.py", import.meta.url), "utf8");
assert.doesNotMatch(probeSource, /aiUsageV1|recordProviderGeneration|persistProviderGeneration/, "provider probe is explicitly outside translation usage");
const popupControllerUrl = new URL("../src/popup/controllers/ai-usage-controller.js", import.meta.url);
if (fs.existsSync(popupControllerUrl)) {
  const controller = await import(popupControllerUrl.href);
  assert.equal(typeof controller.createAiUsageController, "function",
    "usage controller must expose an injectable state-transition boundary");
  const events = [];
  const ui = [];
  const usageController = controller.createAiUsageController({
    persistBoundary: async (target) => events.push(["persist", target]),
    readCurrentUsage: (_ledger, target) => ({ ...target, requests: 0, totalTokens: 0 }),
    renderUsage: (value) => ui.push(value),
  });
  await usageController.select({ runtime: "cloud", provider: "gemini", model: "B", reason: "model_switch" });
  assert.deepEqual(ui.at(-1), {
    runtime: "cloud", provider: "gemini", model: "B", reason: "model_switch",
    requests: 0, totalTokens: 0,
  });
  assert.equal(events[0][0], "persist");
  assert.equal(typeof usageController.reset, "function");
} else {
  // Transitional contract: retain the current integration guards until the
  // controller extraction exists. The branch above becomes authoritative as
  // soon as the target module is introduced.
  assert.match(popupSource, /aiProvider\?\.addEventListener\("change", async \(\) => \{[\s\S]*?const provider[\s\S]*?persistUsageSelectionBoundary[\s\S]*?state\.aiMetaSeq/s,
    "provider boundary is called before the first asynchronous provider-change work");
  assert.match(popupSource, /const provider[\s\S]*?setFieldMessage\(els\.aiProviderWrap, "", ""\)[\s\S]*?persistUsageSelectionBoundary/s,
    "provider help is cleared synchronously before boundary persistence or awaits");
  assert.match(popupSource, /renderZeroUsage\(usageTarget\)[\s\S]*?persistUsageSelectionBoundary/s,
    "new selection renders zero before asynchronous persistence");
  assert.match(popupSource, /aiModel\.addEventListener\("change", async \(\) => \{[\s\S]*?state\.desiredAiModel[\s\S]*?persistUsageSelectionBoundary[\s\S]*?await flushPromptForLang/s,
    "model boundary is called before the first await");
  assert.match(popupSource, /currentUsage\(/, "popup renders only the current selection");
  assert.doesNotMatch(popupSource, /rows\.map|Previous requests|Prior sessions/,
    "popup does not render usage history cards");
}
const popupHtml = fs.readFileSync(new URL("../src/popup/popup.html", import.meta.url), "utf8");
const usageViewSource = fs.readFileSync(new URL("../src/popup/controllers/usage-view-controller.js", import.meta.url), "utf8");
assert.ok(popupHtml.indexOf('id="ai-usage-wrap"') < popupHtml.indexOf('id="ai-provider-wrap"'), "usage strip is above Provider");
assert.ok(popupHtml.indexOf('id="ai-usage-reset"') < popupHtml.indexOf('id="ai-usage-history"'),
  "History is immediately beside Reset");
assert.match(popupHtml, /<dialog[^>]+id="ai-usage-history-dialog"[^>]+aria-labelledby="ai-usage-history-title"/,
  "History uses an accessible native dialog");
assert.match(usageViewSource, /const openHistory = async \(\)[\s\S]*?await renderHistory\(\)[\s\S]*?showModal/,
  "History renders before opening");
assert.match(usageViewSource, /typeof dialog\.showModal === "function"[\s\S]*?dialog\.setAttribute\("open", ""\)/,
  "History has a compatible fallback when showModal is unavailable");
assert.doesNotMatch(usageViewSource, /openHistory[\s\S]{0,800}(?:persistUsageReset|persistUsageSelectionBoundary)/,
  "opening History does not reset usage or create a selection boundary");
assert.doesNotMatch(popupHtml, /Remove time\/RPM delays for this local AI|ai-local-unlimited/);
const settingsSource = fs.readFileSync(new URL("../src/shared/settings.js", import.meta.url), "utf8");
const contextMenuSource = fs.readFileSync(new URL("../src/background/context-menu.js", import.meta.url), "utf8");
assert.doesNotMatch(settingsSource, /aiLocalUnlimited/, "legacy false setting is ignored");
assert.doesNotMatch(contextMenuSource, /aiLocalUnlimited/, "Local pacing bypass no longer depends on legacy storage");

// Exercise the real runsextension persistence path, including router-resolved
// identity and secure provider+URL runtime classification.
const savedChrome = globalThis.chrome;
const savedFetch = globalThis.fetch;
const stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "test" }) },
  storage: { local: {
    get(keys, callback) {
      if (Array.isArray(keys)) callback(Object.fromEntries(keys.map((key) => [key, stored[key]])));
      else callback({ ...keys, ...stored });
    },
    set(patch, callback) { Object.assign(stored, patch); callback?.(); },
  } },
};
await persistUsageSelectionBoundary({ runtime: "cloud", provider: "gemini", model: "popup-B", reason: "model_switch" });
assert.equal(stored.aiUsageV1.selection.model, "popup-B", "popup call-level boundary persists through chrome.storage");
assert.equal(stored.aiUsageV1.models[usageKey("cloud", "gemini", "popup-B")], undefined);
await Promise.all([
  persistUsageSelectionBoundary({ runtime: "cloud", provider: "gemini", model: "A", reason: "model_switch" }),
  persistUsageSelectionBoundary({ runtime: "cloud", provider: "gemini", model: "B", reason: "model_switch" }),
  persistUsageSelectionBoundary({ runtime: "cloud", provider: "gemini", model: "A", reason: "model_switch" }),
]);
assert.equal(stored.aiUsageV1.selection.model, "A", "rapid A→B→A persistence preserves the latest boundary");
const { translateUnits } = await import("../src/background/ai/translation-service.js");
try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    schema: "tp.ai.result/1", translations: [{ id: "P0", text: "ok" }],
    meta: { resolvedProvider: "openai", resolvedModel: "router-local-model",
      provider: "openai", model: "requested-model", base_url: "http://localhost:1234/v1",
      generationAttempts: 3, providerAttempts: 3,
      usage: { inputTokens: 15, outputTokens: 6, totalTokens: 21 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await translateUnits([{ id: "P0", text: "source" }], {
    route: "server", base: "https://textphantom.test", ai: {
      provider: "auto", model: "auto", base_url: "auto", prompt: "full style",
    }, targetLang: "th", sourceLang: "auto",
  });
  const backgroundBatchSession = stored.aiUsageV1.models[usageKey("local", "openai", "router-local-model")].sessions[0];
  assert.equal(backgroundBatchSession.totalTokens, 21,
    "success ledger uses resolved model and exact localhost classification");
  assert.equal(backgroundBatchSession.requests, 3,
    "background usage records all three Local provider generations for a 24-unit page");

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: {
    code: "provider_transport", generationAttempts: 2, providerAttempts: 2,
    structuralDetails: { resolvedProvider: "ollama", resolvedModel: "failed-later-model",
      resolvedBaseUrl: "http://localhost:11434", accumulatedUsage: {
        inputTokens: 12, outputTokens: 5, totalTokens: 17,
      } },
  } }), { status: 502, headers: { "Content-Type": "application/json" } });
  await assert.rejects(translateUnits([{ id: "P0", text: "source" }], {
    route: "server", base: "https://textphantom.test",
    ai: { provider: "ollama", model: "failed-later-model", base_url: "http://localhost:11434", prompt: "full style" },
    targetLang: "th", sourceLang: "auto",
  }));
  const failedLaterSession = stored.aiUsageV1.models[usageKey("local", "ollama", "failed-later-model")].sessions[0];
  assert.equal(failedLaterSession.requests, 2);
  assert.equal(failedLaterSession.totalTokens, 17,
    "background failure ledger preserves completed-batch usage without double counting");

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: {
    code: "invalid_model_output", generationAttempts: 1,
    structuralDetails: { resolvedProvider: "openai", resolvedModel: "evil-host-model",
      resolvedBaseUrl: "http://evil-localhost.example/v1",
      generationMeta: { usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } } },
  } }), { status: 502, headers: { "Content-Type": "application/json" } });
  await assert.rejects(translateUnits([{ id: "P0", text: "source" }], {
    route: "server", base: "https://textphantom.test",
    ai: { provider: "openai", model: "requested", base_url: "http://evil-localhost.example/v1", prompt: "full style" },
    targetLang: "th", sourceLang: "auto",
  }));
  const requestedCloud = stored.aiUsageV1.models[usageKey("cloud", "openai", "requested")].sessions[0];
  assert.equal(requestedCloud.totalTokens, 11, "failure ledger rejects hostname substring spoofing");
  assert.equal(requestedCloud.deltas.at(-1).resolvedModel, "evil-host-model",
    "requested alias grouping retains actual serving identity");
  assert.equal(stored.aiUsageV1.models[usageKey("local", "openai", "requested")], undefined,
    "spoofed hostname must never be classified as Local");

  globalThis.fetch = async () => new Response(JSON.stringify({
    schema: "wrong", meta: { resolvedProvider: "openai", resolvedModel: "suffix-spoof-model",
      base_url: "http://127.0.0.1.attacker.example/v1", generationAttempts: 1,
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(translateUnits([{ id: "P0", text: "source" }], {
    route: "server", base: "https://textphantom.test",
    ai: { provider: "openai", model: "requested", base_url: "http://127.0.0.1.attacker.example/v1", prompt: "full style" },
    targetLang: "th", sourceLang: "auto",
  }));
  const requestedCloudAfter = stored.aiUsageV1.models[usageKey("cloud", "openai", "requested")].sessions[0];
  assert.equal(requestedCloudAfter.totalTokens, 24, "both provider invocations are retained under requested alias");
  assert.equal(requestedCloudAfter.deltas.at(-1).totalTokens, 13,
    "invalid-schema ledger rejects numeric hostname suffix spoofing");
  assert.equal(requestedCloudAfter.deltas.at(-1).resolvedModel, "suffix-spoof-model");
  assert.equal(stored.aiUsageV1.models[usageKey("local", "openai", "requested")], undefined);
} finally {
  globalThis.fetch = savedFetch;
  globalThis.chrome = savedChrome;
}
console.log("ai usage ledger/session, telemetry and backpressure contracts: ok");
