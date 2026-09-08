import { localProviderUsage } from "../usage-values.js";
import { LocalAiError } from "../direct-local/error.js";
import { assertPrivateCredentialFreeEndpoint } from "../direct-local/endpoint.js";
import { dispatchProviderRequest, getProviderJson } from "./local-transport-runtime.js";
import { defineLocalProvider } from "./local-spec.js";
import { SCHEMA_OBJECT_CONTRACT } from "../direct-local/output-contract.js";

export const localProvider = defineLocalProvider({
  id: "ollama",
  displayName: "Ollama",
  protocol: "ollama",
  baseUrl: "http://localhost:11434",
  modelsPath: "/api/tags",
  chatPath: "/api/chat",
  modelsResponsePath: "models.*.name",
  chatResponsePath: "message.content",
  auth: "none",
  thinking: { parameter: "think", off: false, on: true },
  capacity: "ollama-runtime",
  capabilityHints: ollamaCapabilityHints,
  create: createOllamaAdapter,
});

export const OLLAMA_CHAT_PATH = "/api/chat";
export const OLLAMA_TERMINAL_DRAIN_GRACE_MS = 2000;
// Discovery metadata only; generation must never load a model to inspect it.
const reasoningByEndpoint = new Map();

export function ollamaReasoningCapability(show = null) {
  const capabilities = Array.isArray(show?.capabilities) && show.capabilities.every((value) => typeof value === "string")
    ? show.capabilities : null;
  if (!capabilities) return { supported: null, control: "unknown", source: "ollama-api-show" };
  if (!capabilities.includes("thinking"))
    return { supported: false, control: "none", source: "ollama-api-show" };
  const families = [show?.model_info?.["general.architecture"], show?.details?.family,
    ...(Array.isArray(show?.details?.families) ? show.details.families : [])];
  const levelsOnly = families.some((family) => /^(?:gptoss|gpt-oss)$/i.test(String(family || "")));
  return { supported: true, mandatory: levelsOnly, control: levelsOnly ? "levels" : "boolean",
    ...(levelsOnly ? { levels: ["low", "medium", "high"] } : {}), source: "ollama-api-show" };
}

export function ollamaStructuredOutputCapability(show = null) {
  const capabilities = Array.isArray(show?.capabilities) &&
    show.capabilities.every((value) => typeof value === "string")
      ? show.capabilities : null;
  if (!capabilities) return { supported: null, contract: SCHEMA_OBJECT_CONTRACT,
    source: "ollama-api-show", reason: "model_capability_metadata_unavailable" };
  if (!capabilities.includes("completion")) return { supported: false,
    contract: SCHEMA_OBJECT_CONTRACT, source: "ollama-api-show",
    reason: "selected_model_is_not_a_completion_model" };
  return { supported: true, contract: SCHEMA_OBJECT_CONTRACT,
    source: "ollama-api-show", reason: "ollama_native_format_with_confirmed_completion_model" };
}

async function showOllamaModel(base, model, { signal, timeoutMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Ollama model metadata timed out")),
    Math.max(1000, Number(timeoutMs) || 10000));
  try {
    const response = await fetch(`${base}/api/show`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); }
}

function safePath(raw, fallback) {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  if (!/^\/[A-Za-z0-9_./-]{1,160}$/.test(value) || value.includes("..") || /%2e/i.test(value))
    throw new LocalAiError("chatPath is not a safe relative path", { code: "invalid_local_endpoint" });
  return value;
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function responseContractError(detail) {
  const error = new LocalAiError(`Ollama response contract failed: ${detail}`, {
    code: "local_provider_response_contract",
    attempted: true,
  });
  error.providerResponded = true;
  return error;
}

export function ollamaCapabilityHints(modelsData = null, runningData = null, reasoning = new Map(), structured = new Map()) {
  const installed = Array.isArray(modelsData?.models) ? modelsData.models : [];
  const running = Array.isArray(runningData?.models) ? runningData.models : [];
  const active = new Map(running.map((item) => [String(item?.name ?? item?.model ?? "").trim(), item]));
  const tags = new Map(installed.map((item) => [String(item?.name ?? item?.model ?? "").trim(), item]));
  const models = Object.create(null);
  for (const model of new Set([...tags.keys(), ...active.keys()])) {
    if (!model) continue;
    const tag = tags.get(model) || {}, loaded = active.get(model) || null, details = loaded?.details || tag?.details || {};
    const modelBytes = integer(loaded?.size ?? tag?.size), vramBytes = integer(loaded?.size_vram);
    const contextLength = integer(loaded?.context_length), gpuRatio = modelBytes > 0 && vramBytes != null ? vramBytes / modelBytes : null;
    const canTryTwo = Boolean(loaded) && modelBytes != null && modelBytes <= 8 * 1024 ** 3 && gpuRatio >= .9 && contextLength <= 8192;
    const short = (value) => String(value || "").trim().slice(0, 120) || null;
    models[model] = { model, modelBytes, vramBytes, contextLength, loaded: Boolean(loaded),
      limits: { ...(contextLength > 0 ? { contextTokens: contextLength } : {}),
        modelRevision: String(loaded?.digest || tag?.digest || '').slice(0,160),
        source: 'ollama-api-ps', scope: 'runtime' },
      reasoning: reasoning.get(model) || ollamaReasoningCapability(),
      structuredOutput: structured.get(model) || ollamaStructuredOutputCapability(),
      details: { family: short(details?.family), parameterSize: short(details?.parameter_size),
        quantizationLevel: short(details?.quantization_level), format: short(details?.format) },
      recommendedMax: canTryTwo ? 2 : 1,
      reason: canTryTwo ? "Small model is loaded mostly on GPU with context at or below 8192; two requests may be tried as a conservative heuristic, not a runtime limit."
        : loaded ? "Model size, CPU/GPU split, or context does not justify parallel work; start with one request."
          : "Model is installed but runtime capacity is unknown; start with one request." };
  }
  return { source: "ollama-api", protocol: "ollama", known: true, recommendedMax: 1,
    reason: "Ollama metadata does not prove spare capacity or safe parallelism; start with one request.", models };
}

export function createOllamaAdapter(settings = {}) {
  const configured = String(settings.baseUrl || "").trim();
  assertPrivateCredentialFreeEndpoint(configured);
  if (!configured) throw new LocalAiError("Local AI endpoint is missing", { code: "ai_endpoint_missing" });
  let base;
  try { const parsed = new URL(configured); if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    base = parsed.toString().replace(/\/+$/, ""); }
  catch { throw new LocalAiError("Local AI endpoint is not a valid HTTP URL", { code: "invalid_local_endpoint" }); }
  const path = safePath(settings.chatPath, OLLAMA_CHAT_PATH);
  const modelReasoning = (model) => reasoningByEndpoint.get(base)?.get(model);
  const adapter = {
    id: "ollama", streamMode: "ollama_ndjson", drainGraceMs: OLLAMA_TERMINAL_DRAIN_GRACE_MS,
    recordsDrainStatus: true, drainCancelReason: "textphantom_ollama_terminal_drain_timeout",
    incompleteUsageReason: ({ drainStatus }) => drainStatus === "timeout" ? "ollama_terminal_drain_timeout" : null,
    completionCancelReason: "textphantom_translation_complete",
    requestUrl: () => `${base}${path}`,
    headers: () => ({ "Content-Type": "application/json" }),
    payload: (request) => {
      const body = buildOllamaGeneration(request);
      const reasoning = modelReasoning(request.model);
      if (reasoning?.supported === false || reasoning?.control === "levels") delete body.think;
      return body;
    },
    buildUserContent: (text) => text,
    userImageFields: (dataUri) => dataUri ? { images: [String(dataUri).replace(/^data:image\/[^;]+;base64,/i, "")] } : {},
    defaultThinking: "off",
    outputTokens: ({ standard, thinkingMode }) => thinkingMode === "on" ? 8192 : standard,
    thinkingApplied: (mode, { model } = {}) => {
      const reasoning = modelReasoning(model);
      if (reasoning?.supported === false) return "unsupported";
      if (reasoning?.control === "levels") return "provider_default_levels";
      if (mode === "default") return "provider_default";
      // A request field is not evidence that the runtime honored it.
      return `requested_${mode}${reasoning?.control === "boolean" ? "" : "_unverified"}`;
    },
    isStreamingResponse: (response) => Boolean(response.body?.getReader) &&
      String(response.headers?.get?.("content-type") || "").toLowerCase().includes("ndjson"),
    normalizeLine: normalizeOllamaLine,
    emptyEnvelope: () => ({}),
    mergeEnvelope: (target, item) => Object.assign(target, item),
    finalizeEnvelope: (value, content) => ({ ...value, message: { ...(value.message || {}), content } }),
    finishReason: (data) => String(data?.done_reason || "unknown").slice(0, 80),
    terminalCompleted: ({ providerDone, normalFinish }) => providerDone && normalFinish,
    shouldDrainAfterCompletion: (providerDone) => !providerDone,
    responseText: (data) => {
      const value = data?.message?.content;
      if (value === undefined)
        throw responseContractError("message.content is missing");
      if (typeof value !== "string" && !Array.isArray(value))
        throw responseContractError("message.content is not text content");
      if (typeof value === "string") return value;
      return Array.isArray(value) ? value.map((part) => typeof part === "string" ? part : String(part?.text || "")).join("") : "";
    },
    responseReasoning: (data) => String(data?.message?.thinking || data?.message?.reasoning || ""),
    usage: (data) => localProviderUsage(data, "ollama"),
    timing: (data, outputTokens) => {
      const ms = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) / 1_000_000) : null;
      return { loadMs: ms(data?.load_duration), promptEvalMs: ms(data?.prompt_eval_duration), evalMs: ms(data?.eval_duration),
        tokensPerSecond: outputTokens != null && Number(data?.eval_duration) > 0
          ? Math.round((outputTokens * 1_000_000_000 / Number(data.eval_duration)) * 100) / 100 : null };
    },
  };
  adapter.generate = (request, context) => dispatchProviderRequest(adapter, request, context);
  adapter.listModels = async ({ signal = null, timeoutMs = 10000, model = "" } = {}) => {
    const reasoning = new Map();
    const structured = new Map();
    reasoningByEndpoint.set(base, reasoning);
    const modelsPath = safePath(settings.modelsPath, "/api/tags");
    const [data, running] = await Promise.all([
      getProviderJson(`${base}${modelsPath}`, { signal, timeoutMs }),
      getProviderJson(`${base}/api/ps`, { signal, timeoutMs, optional: true }),
    ]);
    if (!Array.isArray(data?.models)) throw responseContractError("models array is missing");
    const raw = data.models;
    const models = [...new Set(raw.map((item) => String(item?.name ?? "").trim()).filter(Boolean))];
    const requested = String(model || "").trim();
    const selected = requested && requested !== "auto" ? requested : models[0];
    if (selected) {
      const show = await showOllamaModel(base, selected, { signal, timeoutMs });
      reasoning.set(selected, ollamaReasoningCapability(show));
      structured.set(selected, ollamaStructuredOutputCapability(show));
    }
    const capability = ollamaCapabilityHints(data, running, reasoning, structured);
    if (selected && !capability.models[selected]) capability.models[selected] = {
      model: selected, reasoning: reasoning.get(selected), structuredOutput: structured.get(selected),
    };
    return { data, models, capability: { ...capability, baseUrl: base } };
  };
  return adapter;
}

export async function generateWithOllama(settings, request, context) {
  return dispatchProviderRequest(createOllamaAdapter(settings), request, context);
}

export function buildOllamaGeneration({ model, messages, outputTokens, thinkingMode, responseSchema = null }) {
  const body = { model, messages, stream: true, options: { num_predict: outputTokens } };
  if (responseSchema) body.format = responseSchema;
  if (thinkingMode !== "default") body.think = thinkingMode === "on";
  return body;
}

export function ollamaStreamFrame(item) {
  return {
    content: String(item?.message?.content || ""),
    reasoning: String(item?.message?.thinking || item?.message?.reasoning || ""),
    providerDone: item?.done === true,
  };
}

export function normalizeOllamaLine(line) {
  const value = String(line || "").trim();
  if (!value) return { kind: "empty" };
  let item;
  try { item = JSON.parse(value); }
  catch { return { kind: "malformed", subtype: "invalid_ndjson", chars: value.length }; }
  if (item?.error != null) {
    const code = typeof item.error === "object" ? item.error.code : null;
    return { kind: "provider_error", code: String(code || "provider_stream_error").slice(0, 80) };
  }
  return { kind: "data", item, ...ollamaStreamFrame(item) };
}
