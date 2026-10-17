// 10491: Manual (own API key) models are no longer probed when selected.
// The first real translation is the check. Deterministic model failures mark
// the exact provider + key + model so the next translation is not sent again;
// transient failures never mark; the mark clears on re-select / key change.
// Mock HTTP and storage only: no provider or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
globalThis.crypto ||= webcrypto;

const store = {};
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "test" }) },
  storage: { local: {
    get(keys, cb) {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(store);
      cb(Object.fromEntries(list.filter((key) => key in store).map((key) => [key, structuredClone(store[key])])));
    },
    set(values, cb) { Object.assign(store, structuredClone(values)); cb?.(); },
  } },
};

const { translateViaServer } = await import("../src/background/ai/transports/server.js");
const { imageErrorMessage } = await import("../src/background/error-message.js");
const blocks = await import("../src/shared/ai/manual-model-block.js");
const { createProviderMetaController } = await import("../src/popup/controllers/provider-meta-controller.js");
const { thinkingRecordForSelection } = await import("../src/popup/controllers/popup-ui-controller.js");
const { classifyThinkingState } = await import("../src/shared/thinking-state.js");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const KEY = "sk-or-fixture-not-a-key";
const ai = (over = {}) => ({ provider: "openrouter", model: "vendor/model-a", base_url: "https://openrouter.ai/api/v1",
  api_key: KEY, prompt: "STYLE", thinking: "minimum", char_memory: false, ...over });
const ok = () => new Response(JSON.stringify({ schema: "tp.ai.result/1", translations: [{ id: "P0", text: "สวัสดี" }],
  missing: [], meta: { resolvedProvider: "openrouter", resolvedModel: "vendor/model-a", generationAttempts: 1, providerAttempts: 1 } }), { status: 200 });
const failure = (status, code, upstreamStatus) => new Response(JSON.stringify({ detail: {
  code, message: "fixture", userMessage: "fixture", origin: "upstream_ai", stage: "provider_request",
  retryable: status >= 500 && ![402].includes(upstreamStatus), httpStatus: status, providerAttempts: 1,
  generationAttempts: 0, providerFailureKind: "http_status", upstreamStatus, requestDispatched: true } }), { status });
let calls = 0;
const send = (reply, over = {}) => {
  globalThis.fetch = async () => { calls++; return reply(); };
  return translateViaServer([{ id: "P0", text: "Hello" }], { base: "http://api.fixture", targetLang: "th",
    sourceLang: "en", operationId: crypto.randomUUID(), traceId: "trace-fixture", ai: ai(over) });
};
const reset = () => { for (const key of Object.keys(store)) delete store[key]; calls = 0; };

await test("selecting a Manual model sends no generation request and does not wait for a test", async () => {
  const requests = [], messages = [];
  const val = (value = "") => ({ value });
  const els = { mode: val("lens_text"), sources: val("ai"), lang: val("th"), apiUrl: val("http://api.fixture"),
    aiProvider: val("openrouter"), aiBaseUrl: val(""), aiKey: val(KEY), aiModel: val("vendor/model-a"),
    aiModelWrap: {}, aiProviderWrap: {}, aiKeyWrap: { style: {} } };
  const state = { aiMetaSeq: 0, desiredAiModel: "vendor/model-a", lastAiResolve: null, aiModelBlocked: true, modelDirty: true };
  const reasoning = { supported: true, mandatory: false, control: "levels", supported_efforts: ["none", "low", "high"] };
  const controller = createProviderMetaController({ els, state,
    api: { fetchJson: async (url, body) => { requests.push(url);
      if (!url.endsWith("/ai/resolve")) throw new Error(`unexpected ${url}`);
      return { provider: "openrouter", backend_supported: true, provider_protocol: "openai_chat_completions",
        key_status: "valid", models_verified: true, models_source: "live", models: ["vendor/model-a", "vendor/model-b"],
        model: body.model, requested_model: body.model, model_status: "available",
        model_candidates: ["vendor/model-a", "vendor/model-b"].map((id) => ({ id, eligibility: "usable" })),
        model_capabilities: { reasoning, vision: { supported: true } } }; } },
    constants: { paths: { AI_RESOLVE: "/ai/resolve" }, metaTimeout: 100 },
    provider: { isLocal: () => false, label: (x) => x, protocolLabel: () => "chat" },
    profile: { saveModelCapabilities: async () => {}, activateResolvedModel: async () => {} },
    normalizeUrl: (x) => x,
    setModelOptions: (rows, { keepValue = "" } = {}) => { els.aiModel.options = rows.map((row) => row.id || row);
      els.aiModel.value = els.aiModel.options.includes(keepValue) ? keepValue : ""; },
    setFieldMessage: (_wrap, _type, text) => messages.push(text), toggleUi: () => {} });
  reset();
  await controller.refresh();
  assert.deepEqual(requests, ["http://api.fixture/ai/resolve"], "only the catalogue is read");
  assert.equal(state.aiModelBlocked, false, "Translate is not held for a model test");
  assert.doesNotMatch(messages.join(" "), /Testing selected model|Explicit test/);
  // AI think and image support come from the already-loaded catalogue record.
  const record = thinkingRecordForSelection({ local: false, provider: "openrouter", model: "vendor/model-a",
    credential: KEY, resolved: state.lastAiResolve, resolvedCredential: KEY });
  assert.equal(classifyThinkingState(record.reasoning, { fresh: record.fresh }), "controllable");
  assert.equal(state.lastAiResolve.model_capabilities.vision.supported, true);
  // 10488 rule kept: an unknown/failed catalogue stays "loading", never "default".
  for (const resolved of [null, { ...state.lastAiResolve, models_verified: false, model_capabilities: {} }]) {
    const pending = thinkingRecordForSelection({ local: false, provider: "openrouter", model: "vendor/model-a",
      credential: KEY, resolved, resolvedCredential: KEY });
    assert.equal(classifyThinkingState(pending.reasoning, { fresh: pending.fresh }), "loading");
  }
  for (const path of ["src/popup/controllers/provider-meta-controller.js", "src/shared/constants.js", "src/popup/popup.js"])
    assert.doesNotMatch(read(path), /AI_PROBE|probeSelected|\/ai\/probe|Testing selected model/, path);
  // 2026.10.16.3: the API answers /ai/probe again ONLY as a no-cost stub for
  // the 2026.9.27.26 popup: it reads no body and calls no provider.
  const aiRoutes = read("api/backend/api/routes/ai.py");
  assert.match(aiRoutes, /@router\.post\("\/ai\/probe"\)\nasync def probe_compat\(\) -> dict:[\s\S]*?return \{"ok": False, "status": "not_tested", "model_capabilities": \{\}\}/);
  assert.doesNotMatch(aiRoutes, /import probe|ai_probe|probe\.probe\(/);
});

await test("a deterministic first-translation failure marks the model; the next one is not sent", async () => {
  for (const [code, upstream] of [["provider_model_not_found", 404], ["provider_model_access_denied", 403],
    ["billing_required", 402], ["provider_region_unsupported", 400], ["provider_http", 403], ["provider_auth_failed", 401]]) {
    reset();
    const first = await send(() => failure(502, code, upstream)).catch((e) => e);
    assert.equal(first.code, code); assert.equal(first.manualModelMarked, true, code); assert.equal(calls, 1);
    const second = await send(ok).catch((e) => e);
    assert.equal(calls, 1, `${code}: the marked model must not be sent again`);
    assert.equal(second.code, code); assert.equal(second.requestDispatched, false); assert.equal(second.providerAttempts, 0);
    // The page shows the same message for the original failure and the stopped retry.
    assert.equal(imageErrorMessage({}, second).message, imageErrorMessage({}, first).message, code);
    // Another model or another key for the same provider is unaffected.
    assert.ok(await send(ok, { model: "vendor/model-b" }));
    assert.ok(await send(ok, { api_key: "sk-or-other-fixture-key" }));
    assert.equal(calls, 3);
    assert.doesNotMatch(JSON.stringify(store), new RegExp(KEY), "the mark never stores the key");
  }
});

await test("transient failures (429, 408, 5xx, timeout, transport) never mark the model", async () => {
  for (const [status, code, upstream] of [[429, "provider_rate_limited", 429], [502, "provider_quota_exhausted", 429],
    [502, "provider_timeout", 504], [502, "provider_http", 503], [502, "provider_transport", undefined],
    [502, "ai_provider_stalled", undefined], [503, "server_busy", undefined], [502, "provider_http", 408]]) {
    reset();
    const first = await send(() => failure(status, code, upstream)).catch((e) => e);
    assert.equal(first.code, code); assert.notEqual(first.manualModelMarked, true, `${code}/${upstream}`);
    assert.ok(await send(ok), `${code}/${upstream}: the next translation is sent`);
    assert.equal(calls, 2);
  }
  reset();
  globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
  await translateViaServer([{ id: "P0", text: "Hello" }], { base: "http://api.fixture", targetLang: "th",
    sourceLang: "en", operationId: crypto.randomUUID(), ai: ai() }).catch(() => {});
  assert.deepEqual(store[blocks.MANUAL_MODEL_BLOCKS_KEY] || {}, {});
});

await test("Paid, Login and Local are outside the Manual mark", async () => {
  for (const over of [{ provider: "paid", api_key: "" }, { provider: "login", api_key: "" },
    { provider: "ollama", base_url: "http://127.0.0.1:11434", api_key: "" },
    { provider: "openai", base_url: "http://localhost:8000/v1" }]) {
    reset();
    await send(() => failure(502, "provider_model_not_found", 404), over).catch(() => {});
    assert.deepEqual(store[blocks.MANUAL_MODEL_BLOCKS_KEY] || {}, {}, JSON.stringify(over));
  }
});

await test("the mark clears when the model is selected again or the key/provider changes", async () => {
  reset();
  await send(() => failure(502, "provider_model_not_found", 404)).catch(() => {});
  const selection = { provider: "openrouter", apiKey: KEY, model: "vendor/model-a" };
  assert.ok(await blocks.manualModelBlock(selection));
  assert.equal(await blocks.clearManualModelBlock({ provider: "openrouter", model: "vendor/model-a" }), true);
  assert.equal(await blocks.manualModelBlock(selection), null);
  assert.ok(await send(ok)); assert.equal(calls, 2, "after re-selecting, the first translation is the check again");
  await send(() => failure(502, "provider_model_access_denied", 403)).catch(() => {});
  assert.equal(await blocks.clearManualModelBlocks(), true);
  assert.equal(await blocks.manualModelBlock(selection), null);
  const events = read("src/popup/controllers/popup-event-controller.js");
  assert.match(events, /els\.aiKey\.addEventListener\("input"[\s\S]{0,400}clearManualModelBlocks\(\)/);
  assert.match(events, /if \(provider !== previousProvider\) void clearManualModelBlocks\(\)/);
  assert.match(events, /await clearManualModelBlock\(\{ provider: providerAtSelection, model: nextModel \}\)[\s\S]{0,400}providerMetaController\.refresh\(\)/);
  assert.match(events, /changes\[MANUAL_MODEL_BLOCKS_KEY\]\) void providerMetaController\.refreshBlock/);
});

await test("the popup shows the page's message for a marked model and keeps it selectable", async () => {
  reset();
  const first = await send(() => failure(502, "provider_model_access_denied", 403)).catch((e) => e);
  const page = imageErrorMessage({}, first).message;
  const messages = [];
  const val = (value = "") => ({ value });
  const els = { mode: val("lens_text"), sources: val("ai"), lang: val("th"), apiUrl: val("http://api.fixture"),
    aiProvider: val("openrouter"), aiBaseUrl: val("https://openrouter.ai/api/v1"), aiKey: val(KEY),
    aiModel: val("vendor/model-a"), aiModelWrap: {}, aiProviderWrap: {}, aiKeyWrap: { style: {} } };
  const state = { aiMetaSeq: 0, desiredAiModel: "vendor/model-a", lastAiResolve: null, aiModelBlocked: false, modelDirty: true };
  const controller = createProviderMetaController({ els, state,
    api: { fetchJson: async (_url, body) => ({ provider: "openrouter", backend_supported: true, key_status: "valid",
      models_verified: true, models_source: "live", models: ["vendor/model-a"], model: body.model, model_status: "available",
      model_candidates: [{ id: "vendor/model-a", eligibility: "usable" }], model_capabilities: {} }) },
    constants: { paths: { AI_RESOLVE: "/ai/resolve" }, metaTimeout: 100 },
    provider: { isLocal: () => false, label: (x) => x, protocolLabel: () => "chat" },
    profile: { saveModelCapabilities: async () => {}, activateResolvedModel: async () => {} }, normalizeUrl: (x) => x,
    setModelOptions: (rows, { keepValue = "" } = {}) => { els.aiModel.options = rows.map((row) => row.id || row);
      els.aiModel.value = els.aiModel.options.includes(keepValue) ? keepValue : ""; },
    setFieldMessage: (_wrap, type, text) => messages.push({ type, text }), toggleUi: () => {} });
  await controller.refresh();
  assert.deepEqual(els.aiModel.options, ["vendor/model-a"], "the marked model stays in the picker so it can be re-selected");
  assert.equal(state.aiModelBlocked, true);
  const shown = messages.at(-1);
  assert.equal(shown.type, "error");
  const [userMessage, code] = page.split(" · ");
  assert.ok(shown.text.includes(`✕ ${userMessage} · ${code}`), shown.text);
  await blocks.clearManualModelBlock({ provider: "openrouter", model: "vendor/model-a" });
  await controller.refreshBlock();
  assert.equal(state.aiModelBlocked, false);
});

console.log(JSON.stringify({ suite: "manual-no-probe-10491", passed: checks }));
