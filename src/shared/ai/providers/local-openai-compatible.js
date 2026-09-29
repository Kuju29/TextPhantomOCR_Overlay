import { localProviderUsage } from "../usage-values.js";
import { LocalAiError } from "../direct-local/error.js";
import { assertPrivateCredentialFreeEndpoint, localOpenAiBase } from "../direct-local/endpoint.js";
import { dispatchProviderRequest, getProviderJson } from "./local-transport-runtime.js";

export const OPENAI_CHAT_PATH = "/chat/completions";
// Sanity bound for malformed runtime metadata; it is not a model limit.
export const LOCAL_CONTEXT_METADATA_MAX = 100_000_000;

export function openAiCompatibleCapabilityHints(modelIds = [], nativeModels = null, listedModelIds = modelIds) {
  modelIds = Array.isArray(modelIds) ? modelIds : [];
  const listed = new Set(Array.isArray(listedModelIds) ? listedModelIds : []);
  const nativeById = new Map();
  const nativeByKey = new Map();
  const runtimeContexts = new Map();
  const loadedIds = new Set();
  const loadedOwners = new Map();
  const loadedStateKnown = new Set();
  const reasoningById = new Map();
  if (Array.isArray(nativeModels)) for (const entry of nativeModels) {
    if (!entry || typeof entry.type !== "string") continue;
    const nativeKey = typeof entry.key === "string" ? entry.key.trim() : "";
    if (nativeKey) nativeByKey.set(nativeKey, nativeByKey.has(nativeKey) ? null : entry);
    for (const id of [entry.key, ...(Array.isArray(entry.loaded_instances)
      ? entry.loaded_instances.map((instance) => instance?.id) : [])]) {
      if (typeof id !== "string" || !id.trim()) continue;
      const key = id.trim();
      nativeById.set(key, nativeById.has(key) && nativeById.get(key) !== entry.type
        ? "ambiguous" : entry.type);
      if (Array.isArray(entry.loaded_instances)) loadedStateKnown.add(key);
    }
    if (entry.type === "llm" && Array.isArray(entry.loaded_instances))
      for (const instance of entry.loaded_instances) {
        // Model maximum context is not the window selected when loading the
        // instance. Only an exact loaded instance ID proves its live window.
        const id = typeof instance?.id === "string" ? instance.id.trim() : "";
        if (id) {
          loadedIds.add(id);
          loadedOwners.set(id, (loadedOwners.get(id) || 0) + 1);
          const supported = entry.capabilities?.reasoning?.allowed_options;
          if (Array.isArray(supported)) {
            const known = new Set(["off", "on", "low", "medium", "high"]);
            const options = [...new Set(supported.filter(value => known.has(value)))];
            const unknownOption = supported.some(value => !known.has(value));
            // An empty native list proves non-reasoning. A nonempty list with
            // unfamiliar options cannot prove that Off works or Low is the
            // least effort. Preserve that uncertainty for the shared resolver.
            reasoningById.set(id, {
              supported: supported.length === 0 ? false : options.length ? true : null,
              mandatory: supported.length === 0 ? false : !options.includes("off"),
              control: supported.length === 0 ? "none" :
                !unknownOption && options.every(value => value === "off" || value === "on")
                  ? "toggle" : "levels",
              supported_efforts: options,
              ...(unknownOption && !options.includes("off") ? {minimum_unresolved: true} : {}),
              source: "lmstudio_native_loaded_instance",
            });
          }
        }
        const size = instance?.config?.context_length;
        if (!id || !Number.isSafeInteger(size) || size <= 0 || size > 100_000_000) continue;
        runtimeContexts.set(id, runtimeContexts.has(id) && runtimeContexts.get(id) !== size
          ? null : size);
      }
  }
  const models = Object.fromEntries(modelIds.map((id) => {
    const type = nativeById.get(id);
    const nativeEntry = nativeByKey.get(id);
    const exactLoaded = type === "llm" && loadedOwners.get(id) === 1 && loadedIds.has(id);
    const runtimeContext = exactLoaded ? runtimeContexts.get(id) : null;
    const maxContext = nativeEntry?.max_context_length;
    // LM Studio exposes downloaded keys in /v1/models only when JIT is on.
    // Its native list proves the key is an LLM and gives a maximum, not a
    // loaded context allocation. Request a bounded context on the real chat.
    const jitLoadable = type === "llm" && nativeEntry?.type === "llm" &&
      Array.isArray(nativeEntry.loaded_instances) && nativeEntry.loaded_instances.length === 0 &&
      listed.has(id) && Number.isSafeInteger(maxContext) && maxContext > 0 &&
      maxContext <= 100_000_000;
    // This is the model's proven capacity for planning. The actual JIT load
    // context is chosen per translation request from its prompt size.
    const requestedContext = jitLoadable ? maxContext : null;
    const downloadedOptions = nativeEntry?.capabilities?.reasoning?.allowed_options;
    const provenDownloadedOptions = jitLoadable && Array.isArray(downloadedOptions) &&
      downloadedOptions.length > 0 && downloadedOptions.every(value =>
        ["off", "on", "low", "medium", "high"].includes(value))
      ? [...new Set(downloadedOptions)] : null;
    const nonChat = Array.isArray(nativeModels) && type !== "llm";
    return [id, {
      recommendedMax: 1,
      // The OpenAI-compatible list may include merely downloaded models when
      // LM Studio JIT loading is enabled. Only the exact native instance ID
      // proves which model is already in memory.
      loaded: Array.isArray(nativeModels) && loadedStateKnown.has(id) &&
        (loadedOwners.get(id) || 0) <= 1 && type !== "ambiguous"
        ? exactLoaded : null,
      jitLoadable,
      ...(reasoningById.has(id) ? {reasoning:reasoningById.get(id)} :
        provenDownloadedOptions ? {reasoning: {
          supported: true, mandatory: !provenDownloadedOptions.includes("off"),
          control: provenDownloadedOptions.every(value => value === "off" || value === "on")
            ? "toggle" : "levels",
          supported_efforts: provenDownloadedOptions,
          source: "lmstudio_native_downloaded_model",
        }} : {}),
      ...(runtimeContext ? {
        contextLength: runtimeContext,
        limits: { contextTokens: runtimeContext, runtimeContextTokens: runtimeContext,
          source: "lmstudio_native_loaded_instance", scope: "runtime" },
      } : requestedContext ? {
        limits: { contextTokens: requestedContext, modelContextTokens: maxContext,
          source: "lmstudio_native_jit_request", scope: "request" },
      } : {}),
      reason: nonChat ? "LM Studio did not confirm this ID as a chat LLM"
        : "Chat generation is confirmed only by the first real translation",
      generation: {
        supported: nonChat ? false : null,
        source: Array.isArray(nativeModels) ? "lmstudio_native_model_type" : "openai_model_list",
        reason: nonChat ? "not_confirmed_chat_llm" : "chat_capability_unverified",
      },
    }];
  }));
  return { source: "openai_model_list", protocol: "openai", known: false, recommendedMax: null,
    reason: "The model list does not prove chat support or concurrency; the first real translation verifies generation.",
    nativeTypesAvailable: Array.isArray(nativeModels), models };
}

function safePath(raw, fallback) {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  if (!/^\/[A-Za-z0-9_./-]{1,160}$/.test(value) || value.includes("..") || /%2e/i.test(value))
    throw new LocalAiError("chatPath is not a safe relative path", { code: "invalid_local_endpoint" });
  return value;
}

function atPath(data, rawPath) {
  const parts = String(rawPath || "").split(".").filter((part) => /^(?:[A-Za-z0-9_-]+|\*)$/.test(part));
  if (!parts.length || parts.length > 8) return undefined;
  const walk = (value, index) => index >= parts.length ? value : parts[index] === "*"
    ? (Array.isArray(value) ? value.map((item) => walk(item, index + 1)).flat().filter((item) => item != null) : undefined)
    : value && typeof value === "object" ? walk(value[parts[index]], index + 1) : undefined;
  return walk(data, 0);
}

function responseContractError(detail) {
  const error = new LocalAiError(`Local OpenAI-compatible response contract failed: ${detail}`, {
    code: "local_provider_response_contract",
    attempted: true,
  });
  error.providerResponded = true;
  return error;
}

export function createOpenAiCompatibleAdapter(settings = {}) {
  const configured = String(settings.baseUrl || "");
  assertPrivateCredentialFreeEndpoint(configured);
  const base = localOpenAiBase(configured), path = safePath(settings.chatPath, OPENAI_CHAT_PATH);
  const adapter = {
    id: "openai", streamMode: "openai_sse", drainGraceMs: 0, recordsDrainStatus: false,
    drainCancelReason: "textphantom_translation_complete", completionCancelReason: "textphantom_translation_complete",
    requestUrl: () => `${base}${path}`,
    headers: () => ({ "Content-Type": "application/json" }),
    payload: (request) => {
      const mode = String(request.thinkingMode || "default");
      const reasoning = request.thinkingCapability;
      // Direct adapter callers can pass the user's Lowest intent. Unknown
      // model-specific controls leave the runtime in charge and report that
      // result; no user-supplied mapping proves which effort is lowest.
      const concreteMode = mode === "minimum" ? "default" : mode;
      // OpenAI-compatible chat is only a wire format. A model list and a
      // user-supplied parameter mapping do not prove that this runtime/model
      // actually honors Off. Never silently turn an explicit effort selection
      // into an omitted parameter and thus the provider's thinking default.
      const knownPlainModel = settings.id === "lmstudio" && reasoning?.supported === false &&
        reasoning?.source === "lmstudio_native_loaded_instance";
      const missingControl = concreteMode !== "off" && concreteMode !== "default" &&
        (!settings.thinking || !Object.prototype.hasOwnProperty.call(settings.thinking, concreteMode));
      if ((concreteMode === "off" && !knownPlainModel) || missingControl)
        throw new LocalAiError("This Local AI runtime has not verified the selected Thinking control for this model", {
          code: "local_model_thinking_unsupported", attempted: false, retryable: false,
        });
      return buildOpenAiCompatibleGeneration({ ...request, thinkingMode: concreteMode,
        thinking: knownPlainModel ? null : settings.thinking, includeUsage: settings.includeUsage });
    },
    // LM Studio's own response identifies the model that generated the answer.
    // Its model list can contain another model selected by the user, so never
    // accept a different execution identity under the selected model's plan.
    assertResponseModel: settings.id === "lmstudio" ? (data, requestedModel) => {
      const reportedModel = typeof data?.model === "string" ? data.model.trim() : "";
      const selectedModel = String(requestedModel || "").trim();
      if (!reportedModel || !selectedModel || reportedModel === selectedModel) return;
      const safeLabel = value => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
      const error = new LocalAiError(
        `LM Studio returned ${safeLabel(reportedModel)} instead of ${safeLabel(selectedModel)}. Check the loaded model in LM Studio and reconnect.`,
        { code: "local_model_identity_mismatch", attempted: true, retryable: false,
          diagnostics: { validatorSubtype: "provider_model_mismatch",
            requestedModel: safeLabel(selectedModel), reportedModel: safeLabel(reportedModel) } },
      );
      error.providerResponded = true;
      throw error;
    } : null,
    buildUserContent: (text, dataUri) => dataUri
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: dataUri } }] : text,
    userImageFields: () => ({}), defaultThinking: "default", outputTokens: ({ standard }) => standard,
    thinkingApplied: (mode, { payload = null, reasoning = null } = {}) => {
      if (mode === "minimum") return "provider_managed_unverified";
      if (mode === "default") return "provider_default";
      if (mode === "off" && settings.id === "lmstudio" && reasoning?.supported === false &&
          reasoning?.source === "lmstudio_native_loaded_instance")
        return "not_applicable_non_reasoning_model";
      const parameter = String(settings.thinking?.parameter || "");
      return parameter && payload && Object.prototype.hasOwnProperty.call(payload, parameter)
        ? `requested_${mode}` : "unverified";
    },
    isStreamingResponse: (response) => Boolean(response.body?.getReader) &&
      String(response.headers?.get?.("content-type") || "").toLowerCase().includes("event-stream"),
    normalizeLine: normalizeOpenAiLine,
    emptyEnvelope: () => ({}), mergeEnvelope: (target, item) => {
      const previous = target.choices?.[0];
      const usage = { ...(target.usage || {}), ...(item.usage || {}) };
      for (const field of ["prompt_tokens_details", "completion_tokens_details"])
        if (target.usage?.[field] || item.usage?.[field])
          usage[field] = { ...(target.usage?.[field] || {}), ...(item.usage?.[field] || {}) };
      Object.assign(target, item);
      if (previous && !item.choices?.length) target.choices = [previous];
      else if (previous?.finish_reason && !target.choices?.[0]?.finish_reason)
        target.choices[0].finish_reason = previous.finish_reason;
      if (Object.keys(usage).length) target.usage = usage;
    },
    finalizeEnvelope: (value, content) => ({ ...value, choices: [{ ...(value.choices?.[0] || {}), message: { content } }] }),
    finishReason: (data) => String(data?.choices?.[0]?.finish_reason || data?.done_reason || "unknown").slice(0, 80),
    terminalCompleted: ({ terminal, normalFinish }) => terminal || normalFinish,
    shouldDrainAfterCompletion: () => false,
    responseText: (data) => {
      const configuredPath = String(settings.chatResponsePath || "").trim();
      const value = configuredPath
        ? atPath(data, configuredPath)
        : data?.choices?.[0]?.message?.content;
      if (value === undefined)
        throw responseContractError(configuredPath || "choices.0.message.content is missing");
      if (typeof value !== "string" && !Array.isArray(value))
        throw responseContractError("configured chat response is not text content");
      return contentPartsText(value);
    },
    responseReasoning: (data) => contentPartsText(data?.choices?.[0]?.message?.reasoning_content
      ?? data?.choices?.[0]?.message?.reasoning ?? ""),
    usage: (data) => localProviderUsage(data, "openai", {
      llamaCacheTimings: settings.id === "llamacpp" || settings.id === "llamafile",
    }),
    timing: () => ({ loadMs: null, promptEvalMs: null, evalMs: null, tokensPerSecond: null }),
  };
  adapter.generate = (request, context) => dispatchProviderRequest(adapter, request, context);
  adapter.listModels = async ({ signal = null, timeoutMs = 10000 } = {}) => {
    const modelsPath = safePath(settings.modelsPath, "/models");
    const data = await getProviderJson(`${base}${modelsPath}`, { signal, timeoutMs });
    const configuredPath = String(settings.modelsResponsePath || "").trim();
    const raw = configuredPath ? atPath(data, configuredPath) : data?.data;
    if (!Array.isArray(raw)) throw responseContractError(configuredPath || "data model array is missing");
    const listed = [...new Set(raw.map((item) => String(typeof item === "string" ? item : item?.id ?? "").trim()).filter(Boolean))];
    // LM Studio's /v1/models can list embedding models too. Its native list
    // exposes explicit types; only exact model IDs are matched. A native API
    // that is unavailable leaves support unverified, never guessed by name.
    let nativeModels = null;
    let nativeMetadataStatus = settings.id === "lmstudio" ? "unavailable" : "not_applicable";
    if (settings.id === "lmstudio" && base.endsWith("/v1")) {
      try {
        const native = await getProviderJson(`${base.slice(0, -3)}/api/v1/models`,
          { signal, timeoutMs, optional: true });
        if (Array.isArray(native?.models)) {
          nativeModels = native.models;
          nativeMetadataStatus = "verified_loaded_instances";
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // This optional endpoint is absent on some runtimes. Do not label
        // listed models as chat-capable when their native types are unknown.
      }
    }
    // The OpenAI-compatible list is not a complete downloaded-model catalog
    // when JIT loading is disabled. Native metadata identifies downloaded
    // chat LLMs even before they have a loaded instance. Show them in the
    // picker; verification below still forbids generation until loaded.
    const catalog = Array.isArray(nativeModels)
      ? [...new Set([...listed, ...nativeModels.filter(entry => entry?.type === "llm")
        .map(entry => String(entry.key || "").trim()).filter(Boolean)])]
      : listed;
    const capability = openAiCompatibleCapabilityHints(catalog, nativeModels, listed);
    capability.nativeMetadataStatus = nativeMetadataStatus;
    if (settings.id === "vllm" || settings.id === "llamacpp") {
      // OpenAI-compatible is only a wire format. Read numeric runtime
      // metadata for the exact selected model, never a similarly named row
      // and never a generic maximum guessed from the provider name.
      const rowsById = new Map();
      const nativeRows = Array.isArray(data?.data) ? data.data : raw;
      for (const row of nativeRows) {
        const id = typeof row?.id === "string" ? row.id.trim() : "";
        if (id) rowsById.set(id, [...(rowsById.get(id) || []), row]);
      }
      let llamaContext = null;
      if (settings.id === "llamacpp" && rowsById.size === 1 &&
          [...rowsById.values()][0]?.length === 1 &&
          !Number.isSafeInteger([...rowsById.values()][0][0]?.meta?.n_ctx) &&
          base.endsWith("/v1")) {
        // llama.cpp's meta.n_ctx_train is a training limit, not the loaded
        // server window. /props reports the actual active n_ctx.
        try {
          const props = await getProviderJson(`${base.slice(0, -3)}/props`,
            { signal, timeoutMs, optional: true });
          const runtime = props?.default_generation_settings?.n_ctx;
          if (Number.isSafeInteger(runtime) && runtime > 0 && runtime <= LOCAL_CONTEXT_METADATA_MAX)
            llamaContext = runtime;
        } catch (error) {
          if (signal?.aborted) throw error;
          // Older deployments may not expose /props. The active window then
          // stays unknown; n_ctx_train is never substituted for it.
        }
      }
      for (const id of listed) {
        const matches = rowsById.get(id);
        if (matches?.length !== 1) continue;
        const value = settings.id === "vllm" ? matches[0].max_model_len :
          matches[0]?.meta?.n_ctx ?? (rowsById.size === 1 ? llamaContext : null);
        if (!Number.isSafeInteger(value) || value <= 0 || value > LOCAL_CONTEXT_METADATA_MAX) continue;
        capability.models[id].limits = {contextTokens:value,
          ...(settings.id === "llamacpp" ? {runtimeContextTokens:value} : {modelContextTokens:value}),
          source:settings.id === "llamacpp" ? "llamacpp_runtime_models_or_props" : "vllm_runtime_models",
          scope:"runtime"};
      }
    }
    if (settings.id === "koboldcpp" && listed.length === 1 && raw.length === 1 &&
        base.endsWith("/v1")) {
      // The native endpoint describes this loaded server, without a model ID.
      // Multiple /v1/models rows cannot safely share its context allocation.
      let native = null;
      try {
        native = await getProviderJson(`${base.slice(0, -3)}/api/extra/true_max_context_length`,
          { signal, timeoutMs, optional: true });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      const context = native?.value;
      if (Number.isSafeInteger(context) && context > 0 && context <= LOCAL_CONTEXT_METADATA_MAX)
        capability.models[listed[0]].limits = {
          contextTokens: context, runtimeContextTokens: context,
          source: "koboldcpp-api-extra-true-max-context-length", scope: "runtime",
        };
    }
    const models = catalog.filter((id) => capability.models[id]?.generation?.supported !== false);
    const selectableModels = settings.id === "lmstudio"
      ? [...models.filter(id => capability.models[id]?.loaded === true &&
          Number.isSafeInteger(capability.models[id]?.limits?.runtimeContextTokens)),
        ...models.filter(id => capability.models[id]?.jitLoadable === true)]
      : models;
    return { data, models, listedModels: listed, selectableModels, capability };
  };
  return adapter;
}

export async function generateWithOpenAiCompatible(settings, request, context) {
  return dispatchProviderRequest(createOpenAiCompatibleAdapter(settings), request, context);
}

export function buildOpenAiCompatibleGeneration({ model, messages, outputTokens, thinkingMode, thinking, responseSchema = null, includeUsage = false }) {
  const body = { model, messages, stream: true, max_tokens: outputTokens };
  if (includeUsage) body.stream_options = { include_usage: true };
  if (responseSchema) body.response_format = { type: "json_schema", json_schema: {
    name: "textphantom_translations", strict: true, schema: responseSchema,
  } };
  if (thinkingMode !== "default" && thinking) body[thinking.parameter] = thinking[thinkingMode];
  return body;
}

function contentPartsText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    return part && (part.type === "text" || typeof part.text === "string")
      ? String(part.text || "") : "";
  }).join("");
}

export function openAiStreamFrame(item) {
  const choice = item?.choices?.[0];
  return {
    content: contentPartsText(choice?.delta?.content ?? choice?.message?.content ?? ""),
    reasoning: contentPartsText(choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? ""),
    providerDone: false,
  };
}

export function normalizeOpenAiLine(line) {
  let value = String(line || "").trim();
  if (!value) return { kind: "empty" };
  if (value.startsWith(":")) return { kind: "empty" };
  // SSE event metadata is legal before a data line. It does not contain
  // translated text or indicate successful completion by itself.
  if (/^(?:event|id|retry):/.test(value)) return { kind: "empty" };
  if (!value.startsWith("data:")) return { kind: "malformed", subtype: "sse_non_data_line", chars: value.length };
  value = value.slice(5).trim();
  if (value === "[DONE]") return { kind: "terminal" };
  let item;
  try { item = JSON.parse(value); }
  catch { return { kind: "malformed", subtype: "invalid_sse_json", chars: value.length }; }
  if (item?.error != null) {
    const code = typeof item.error === "object" ? item.error.code : null;
    return { kind: "provider_error", code: String(code || "provider_stream_error").slice(0, 80) };
  }
  return { kind: "data", item, ...openAiStreamFrame(item) };
}
