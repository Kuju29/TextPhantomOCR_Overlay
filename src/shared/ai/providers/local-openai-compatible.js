import { localProviderUsage } from "../usage-values.js";
import { LocalAiError } from "../direct-local/error.js";
import { assertPrivateCredentialFreeEndpoint, localOpenAiBase } from "../direct-local/endpoint.js";
import { dispatchProviderRequest, getProviderJson } from "./local-transport-runtime.js";

export const OPENAI_CHAT_PATH = "/chat/completions";

export function openAiCompatibleCapabilityHints() {
  return { source: "runtime-metadata", protocol: "openai", known: false, recommendedMax: null,
    reason: "Runtime does not expose a portable capacity contract; use the safe scheduler fallback.", models: {} };
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
    payload: (request) => buildOpenAiCompatibleGeneration({ ...request, thinking: settings.thinking, includeUsage: settings.includeUsage }),
    buildUserContent: (text, dataUri) => dataUri
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: dataUri } }] : text,
    userImageFields: () => ({}), defaultThinking: "default", outputTokens: ({ standard }) => standard,
    thinkingApplied: (mode) => mode === "default" ? "provider_default" : mode,
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
    usage: (data) => localProviderUsage(data, "openai"),
    timing: () => ({ loadMs: null, promptEvalMs: null, evalMs: null, tokensPerSecond: null }),
  };
  adapter.generate = (request, context) => dispatchProviderRequest(adapter, request, context);
  adapter.listModels = async ({ signal = null, timeoutMs = 10000 } = {}) => {
    const modelsPath = safePath(settings.modelsPath, "/models");
    const data = await getProviderJson(`${base}${modelsPath}`, { signal, timeoutMs });
    const configuredPath = String(settings.modelsResponsePath || "").trim();
    const raw = configuredPath ? atPath(data, configuredPath) : data?.data;
    if (!Array.isArray(raw)) throw responseContractError(configuredPath || "data model array is missing");
    return { data, models: [...new Set(raw.map((item) => String(typeof item === "string" ? item : item?.id ?? "").trim()).filter(Boolean))],
      capability: openAiCompatibleCapabilityHints() };
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
