// Browser-direct adapter for AI runtimes on the user's own PC/LAN.
// Translation is intentionally OpenAI-compatible: Ollama, LM Studio, LocalAI,
// Jan, text-generation-webui, vLLM, llama.cpp and compatible custom runtimes
// can all use the same request without TextPhantom learning model names.

import { applyMarkers, extractDirectParagraphs } from "./ai-markers.js";
import { isLocalAiProvider, isLocalHostUrl } from "./constants.js";

// Route matrix is pure/testable: API engine always remains API-owned; only the
// extension engine may talk directly to an explicitly local provider/URL.
export function shouldUseDirectLocalAi(engine, provider, baseUrl) {
  return String(engine || "extension") !== "api" &&
    (isLocalAiProvider(provider) || isLocalHostUrl(baseUrl));
}

export class LocalAiError extends Error {
  constructor(message, { code = "local_ai_error", status = 0, retryable = false, attempted = false } = {}) {
    super(message);
    this.name = "LocalAiError";
    this.code = code;
    this.status = Number(status) || 0;
    this.retryable = retryable === true;
    this.providerAttempts = attempted ? 1 : 0;
    this.generationAttempts = attempted ? 1 : 0;
  }
}

function assertPrivateCredentialFreeEndpoint(rawUrl) {
  const raw = String(rawUrl || "").trim();
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw new LocalAiError("Local AI endpoint is not a valid URL", { code: "invalid_local_endpoint" });
  }
  if (!isLocalHostUrl(raw) || !/^https?:$/.test(parsed.protocol)) {
    throw new LocalAiError("Local AI endpoints must stay on this PC or private LAN", {
      code: "local_endpoint_not_private",
    });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LocalAiError("Local AI endpoint cannot contain credentials, query text or a fragment", {
      code: "invalid_local_endpoint",
    });
  }
  return parsed;
}

export function localOpenAiBase(rawUrl) {
  const raw = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!raw || raw.toLowerCase() === "auto") {
    throw new LocalAiError("Local AI endpoint is missing", { code: "ai_endpoint_missing" });
  }
  let url;
  try { url = new URL(raw); } catch {
    throw new LocalAiError("Local AI endpoint is not a valid URL", { code: "invalid_local_endpoint" });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new LocalAiError("Local AI endpoint must use HTTP or HTTPS", { code: "invalid_local_endpoint" });
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") url.pathname = "/v1";
  else url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function responseText(data) {
  return String(
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.message?.content ??
    data?.response ??
    "",
  ).trim();
}

function safePath(data, path) {
  const parts = String(path || "").split(".").filter((part) => /^(?:[A-Za-z0-9_-]+|\*)$/.test(part));
  if (!parts.length || parts.length > 8) return undefined;
  const walk = (value, index) => {
    if (index >= parts.length) return value;
    const part = parts[index];
    if (part === "*") {
      if (!Array.isArray(value)) return undefined;
      return value.map((item) => walk(item, index + 1)).flat().filter((item) => item != null);
    }
    return value && typeof value === "object" ? walk(value[part], index + 1) : undefined;
  };
  return walk(data, 0);
}

function validatedAdapterPath(rawPath, fallback, field) {
  const raw = String(rawPath || "").trim();
  if (!raw) return fallback;
  if (!/^\/[A-Za-z0-9_./-]{1,160}$/.test(raw) || raw.includes("..") || /%2e/i.test(raw)) {
    throw new LocalAiError(`${field} is not a safe relative path`, { code: "invalid_local_endpoint" });
  }
  return raw;
}

function decodeTranslations(text, units) {
  // Custom/local servers may honour either TextPhantom's historical marker
  // contract or the newer JSON shape. Accept both losslessly; never guess.
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj?.translations)) {
      const byId = new Map(obj.translations.map((item) => [String(item?.id || ""), String(item?.text || "").trim()]));
      const translations = units.map((unit, index) => ({
        id: unit.id,
        text: byId.get(String(unit.id)) || byId.get(`P${index}`) || "",
      }));
      return { translations, responseShape: "json" };
    }
  } catch {
  }
  const direct = extractDirectParagraphs(text, units.length);
  if (!direct.parsed) {
    throw new LocalAiError("Local AI returned text without the required paragraph markers", {
      code: "invalid_model_output",
    });
  }
  return {
    translations: units.map((unit, index) => ({ id: unit.id, text: direct.parsed.paragraphs[index] || "" })),
    responseShape: "markers",
  };
}

function memoryText(ai) {
  const blocks = [];
  if (Array.isArray(ai?.glossary) && ai.glossary.length) {
    blocks.push(`GLOSSARY:\n${ai.glossary.slice(0, 80).map((x) => `${x?.src || ""} => ${x?.tgt || ""}`).join("\n")}`);
  }
  if (Array.isArray(ai?.characters) && ai.characters.length) {
    blocks.push(`CHARACTER SHEET:\n${ai.characters.slice(0, 40).map((x) => typeof x === "string" ? x : JSON.stringify(x)).join("\n")}`);
  }
  if (String(ai?.series_state || "").trim()) blocks.push(`SERIES STATE:\n${String(ai.series_state).trim()}`);
  if (Array.isArray(ai?.prev_context) && ai.prev_context.length) {
    blocks.push(`PREVIOUS CONTEXT:\n${ai.prev_context.slice(-20).map(String).join("\n")}`);
  }
  return blocks.join("\n\n");
}

export async function translateWithLocalOpenAi(units, {
  ai, systemText = "", imageDataUri = "", signal = null, timeoutMs = 300000,
} = {}) {
  if (signal?.aborted) {
    throw new LocalAiError("Local AI request was cancelled", { code: "cancelled" });
  }
  const model = String(ai?.model || "").trim();
  if (!model || model.toLowerCase() === "auto") {
    throw new LocalAiError("Select a model exposed by the Local AI runtime", { code: "local_model_missing" });
  }
  const adapter = ai?.local_adapter && typeof ai.local_adapter === "object" ? ai.local_adapter : {};
  const protocol = adapter.protocol === "ollama" ? "ollama" : "openai";
  const configuredBase = String(adapter.baseUrl || ai?.base_url || "");
  assertPrivateCredentialFreeEndpoint(configuredBase);
  const base = protocol === "ollama"
    ? (() => {
        const value = configuredBase.trim().replace(/\/+$/, "");
        if (!value) throw new LocalAiError("Local AI endpoint is missing", { code: "ai_endpoint_missing" });
        try {
          const parsed = new URL(value);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error();
          return parsed.toString().replace(/\/+$/, "");
        } catch { throw new LocalAiError("Local AI endpoint is not a valid HTTP URL", { code: "invalid_local_endpoint" }); }
      })()
    : localOpenAiBase(configuredBase);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Local AI request timed out")), Math.max(1000, Number(timeoutMs) || 300000));
  const notes = String(ai?.prompt || "").trim();
  const memory = memoryText(ai);
  const system = [String(systemText || "").trim(), notes ? `USER TRANSLATION NOTES:\n${notes}` : "", memory]
    .filter(Boolean).join("\n\n");
  const userText = applyMarkers(units.map((unit) => unit.text));
  const content = imageDataUri && protocol !== "ollama"
    ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: imageDataUri } }]
    : userText;
  const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      {
        role: "user", content,
        ...(protocol === "ollama" && imageDataUri
          ? { images: [String(imageDataUri).replace(/^data:image\/[^;]+;base64,/i, "")] }
          : {}),
      },
    ];
  // Use the installed model's own generation defaults. Sampling/reasoning
  // parameters vary across local runtimes and forcing temperature can make
  // reasoning or strict OpenAI-compatible models reject an otherwise valid
  // request.
  const body = { model, messages, stream: false };
  const configuredChatPath = String(adapter.chatPath || "").trim();
  const defaultChatPath = protocol === "ollama" ? "/api/chat" : "/chat/completions";
  const chatPath = validatedAdapterPath(configuredChatPath, defaultChatPath, "chatPath");
  let response;
  let raw = "";
  try {
    // Deliberately no Authorization header and no api_key field. A cloud key
    // stored for another provider must never cross into a Local AI request.
    response = await fetch(`${base}${chatPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    raw = String(await response.text()).slice(0, 2_000_000);
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = controller.signal.aborted;
    throw new LocalAiError(
      timedOut ? "Local AI request timed out" : "Could not connect to Local AI on this PC",
      { code: timedOut ? "local_ai_timeout" : "local_ai_unreachable", retryable: false, attempted: true },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(raw);
      detail = String(parsed?.error?.message || parsed?.message || "").slice(0, 300);
    } catch {
    }
    const modelMissing = response.status === 404
      && /\bmodel\b[\s\S]{0,80}\b(?:not found|missing|unknown|does not exist|not installed)\b|\b(?:not found|missing|unknown)\b[\s\S]{0,80}\bmodel\b/i.test(detail);
    throw new LocalAiError(`Local AI rejected the request (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, {
      code: modelMissing ? "local_model_not_found"
        : response.status === 404 ? "local_ai_endpoint_incompatible"
        : response.status >= 500 ? "local_ai_server_error" : "local_ai_http_error",
      status: response.status, attempted: true,
      retryable: false,
    });
  }
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new LocalAiError("Local AI returned invalid JSON", { code: "invalid_local_response", attempted: true });
  }
  const mapped = safePath(data, adapter.chatResponsePath);
  const text = String(mapped ?? responseText(data)).trim();
  if (!text) throw new LocalAiError("Local AI returned no text", { code: "invalid_model_output", attempted: true });
  let decoded;
  try { decoded = decodeTranslations(text, units); } catch (error) {
    error.providerAttempts = 1;
    error.generationAttempts = 1;
    throw error;
  }
  const missing = decoded.translations.filter((item) => !item.text).map((item) => item.id);
  return {
    schema: "tp.ai.result/1",
    translations: decoded.translations,
    missing,
    meta: {
      route: "direct-local",
      responseShape: decoded.responseShape,
      providerAttempts: 1,
      generationAttempts: 1,
      httpAttempts: 1,
      automaticContentRetry: false,
      automaticTransportRetry: false,
      modelFallback: false,
      schemaFallback: false,
    },
  };
}

export async function discoverLocalModels(adapter = {}, { signal = null, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) {
    throw new LocalAiError("Local AI model discovery was cancelled", { code: "cancelled" });
  }
  const protocol = adapter?.protocol === "ollama" ? "ollama" : "openai";
  const configuredBase = String(adapter?.baseUrl || "").trim();
  assertPrivateCredentialFreeEndpoint(configuredBase);
  const base = protocol === "ollama"
    ? configuredBase.replace(/\/+$/, "")
    : localOpenAiBase(configuredBase);
  const configuredPath = String(adapter?.modelsPath || "").trim();
  const defaultPath = protocol === "ollama" ? "/api/tags" : "/models";
  const path = validatedAdapterPath(configuredPath, defaultPath, "modelsPath");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Local AI model discovery timed out")),
    Math.max(1000, Number(timeoutMs) || 10000),
  );
  let response;
  let data;
  try {
    response = await fetch(`${base}${path}`, {
      method: "GET", headers: { Accept: "application/json" }, cache: "no-store",
      credentials: "omit", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      throw new LocalAiError(`Local AI model discovery failed (HTTP ${response.status})`, {
        code: "local_models_http_error", status: response.status,
      });
    }
    try { data = await response.json(); } catch {
      throw new LocalAiError("Local AI model list was not JSON", { code: "invalid_local_response" });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof LocalAiError) throw error;
    throw new LocalAiError(
      controller.signal.aborted ? "Local AI model discovery timed out" : "Could not connect to Local AI on this PC",
      { code: controller.signal.aborted ? "local_ai_timeout" : "local_ai_unreachable" },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
  const mapped = safePath(data, adapter?.modelsResponsePath);
  const raw = Array.isArray(mapped) ? mapped
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
    : [];
  const models = [...new Set(raw.map((item) => String(
    typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model ?? "",
  ).trim()).filter(Boolean))];
  if (!models.length) {
    throw new LocalAiError("Local AI returned no usable model IDs", { code: "local_models_empty" });
  }
  return { ok: true, models, protocol, endpoint: base };
}
