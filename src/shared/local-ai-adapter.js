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

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part :
    (part?.type === "text" || typeof part?.text === "string" ? String(part?.text || "") : "")).join("");
}

function responseText(data) {
  return contentText(
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

function unwrapKnownResponse(raw) {
  const text = String(raw || "").trim();
  const fenced = /^```(?:json)?[ \t]*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) return fenced[1].trim();
  const tagged = /^<AiTextFull>([\s\S]*)<\/AiTextFull>$/i.exec(text);
  return tagged ? tagged[1].trim() : text;
}

// JSON.parse silently keeps the last duplicate object key. Walk the bounded
// response with a real JSON grammar first so duplicates at any nesting depth
// remain observable. Strings/escapes are parsed as strings, never regex-scanned.
export function assertNoDuplicateJsonKeys(raw) {
  const source = String(raw || "");
  let at = 0;
  const ws = () => { while (/\s/.test(source[at] || "")) at += 1; };
  const stringToken = () => {
    if (source[at] !== '"') throw new SyntaxError("expected JSON string");
    const start = at++;
    while (at < source.length) {
      const ch = source[at++];
      if (ch === '"') return JSON.parse(source.slice(start, at));
      if (ch === "\\") {
        if (at >= source.length) throw new SyntaxError("incomplete JSON escape");
        if (source[at] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5))) throw new SyntaxError("invalid Unicode escape");
          at += 5;
        } else {
          if (!/["\\/bfnrt]/.test(source[at])) throw new SyntaxError("invalid JSON escape");
          at += 1;
        }
      } else if (ch.charCodeAt(0) < 0x20) throw new SyntaxError("control character in JSON string");
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const value = (depth = 0) => {
    if (depth > 128) throw new SyntaxError("JSON nesting is too deep");
    ws();
    const ch = source[at];
    if (ch === '"') { stringToken(); return; }
    if (ch === "{") {
      at += 1; ws();
      const keys = new Set();
      if (source[at] === "}") { at += 1; return; }
      while (true) {
        ws(); const key = stringToken(); ws();
        if (keys.has(key)) throw new LocalAiError(`Local AI JSON contains duplicate key: ${key}`, { code: "invalid_model_output" });
        keys.add(key);
        if (source[at++] !== ":") throw new SyntaxError("expected colon");
        value(depth + 1); ws();
        if (source[at] === "}") { at += 1; return; }
        if (source[at++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    if (ch === "[") {
      at += 1; ws();
      if (source[at] === "]") { at += 1; return; }
      while (true) {
        value(depth + 1); ws();
        if (source[at] === "]") { at += 1; return; }
        if (source[at++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    const tail = source.slice(at);
    const literal = /^(?:true|false|null)(?=\s|[,}\]]|$)/.exec(tail);
    if (literal) { at += literal[0].length; return; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s|[,}\]]|$)/.exec(tail);
    if (number) { at += number[0].length; return; }
    throw new SyntaxError("invalid JSON value");
  };
  value(); ws();
  if (at !== source.length) throw new SyntaxError("trailing JSON content");
}

function decodeTranslations(text, units, { structured = false } = {}) {
  // Custom/local servers may honour either TextPhantom's historical marker
  // contract or the newer JSON shape. Accept both losslessly; never guess.
  const unwrapped = unwrapKnownResponse(text);
  try {
    assertNoDuplicateJsonKeys(unwrapped);
    const obj = JSON.parse(unwrapped);
    if (Array.isArray(obj?.translations)) {
      const topKeys = Object.keys(obj).sort();
      if (topKeys.some((key) => !["memo", "translations"].includes(key)) ||
          typeof obj.memo !== "string" || obj.translations.length !== units.length) {
        throw new LocalAiError("Local AI returned JSON that does not match the translation schema", {
          code: "invalid_model_output",
        });
      }
      const translations = obj.translations.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item) ||
            Object.keys(item).some((key) => !["id", "text"].includes(key)) ||
            item.id !== `P${index}` || typeof item.text !== "string") {
          throw new LocalAiError("Local AI returned duplicate, missing, reordered or invalid translation entries", {
            code: "invalid_model_output",
          });
        }
        return { id: units[index].id, text: item.text.trim() };
      });
      return { translations, responseShape: "json", memo: obj.memo };
    }
  } catch (error) {
    if (error instanceof LocalAiError) throw error;
  }
  if (structured) {
    throw new LocalAiError("Local AI returned text instead of the required translation JSON", {
      code: "invalid_model_output",
    });
  }
  const direct = extractDirectParagraphs(unwrapped, units.length);
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

function glossaryText(entries, limit = 40) {
  if (!Array.isArray(entries)) return "";
  const seen = new Set();
  const lines = [];
  for (const entry of [...entries].reverse()) {
    const src = String(entry?.src || "").trim();
    const tgt = String(entry?.tgt || "").trim();
    if (!src || !tgt || src.length < 3 || seen.has(src)) continue;
    seen.add(src);
    lines.push(`  - ${src} → ${tgt}`);
    if (lines.length >= limit) break;
  }
  if (!lines.length) return "";
  return "TRANSLATION MEMORY (names, places, skills, items from earlier pages — use the SAME target wording for the SAME source term). This binds recurring names/terms only; everyday words and interjections are always free to follow the scene:\n" + lines.reverse().join("\n");
}

function characterText(characters, limit = 30) {
  if (!Array.isArray(characters)) return "";
  const lines = characters.slice(-limit).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const name = String(item.name || "").trim();
    if (!name) return [];
    const bits = [name];
    for (const key of ["gender", "speech", "note"]) {
      const value = String(item[key] || "").trim();
      if (value) bits.push(`${key}: ${value}`);
    }
    return [`  - ${bits.join(" | ")}`];
  });
  if (!lines.length) return "";
  return "CHARACTER SHEET (accumulated from earlier pages of this series — treat as ground truth):\n" +
    lines.join("\n") +
    "\nThis sheet is the ONLY proof of a character's gender (plus explicit text evidence). But a known gender is just PERMISSION, never a requirement: keep using gender markers (ครับ/ค่ะ, ผม/ดิฉัน) as little as possible even for listed characters — reach for one only when the line's register clearly calls for polite/formal speech, and stay gender-neutral otherwise. Anyone not listed — or listed as unknown — is always gender-neutral. Casual lines stay casual and particle-free; use the speech/note fields to keep each character's voice stable, not to add politeness.";
}

function previousContextText(entries, limit = 6) {
  if (!Array.isArray(entries)) return "";
  const lines = entries.slice(-limit).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const src = String(entry.src || "").trim().replace(/\n/g, " ");
    if (!src) return [];
    const who = String(entry.who || "").trim();
    return [(who ? `  [${who}] ${src}` : `  ${src}`).slice(0, 200)];
  });
  return lines.length ? "PREVIOUS PAGE (source text tail, context only — the conversation may continue from here; do NOT translate or output these lines):\n" + lines.join("\n") : "";
}

function memoryText(ai) {
  const blocks = [];
  const state = String(ai?.series_state || "").trim();
  if (state) blocks.push("STORY SO FAR (series bible from reading the whole chapter — background truth for tone, relationships and scene; NEVER restate or translate it in the output):\n" + state);
  blocks.push(characterText(ai?.characters));
  blocks.push(glossaryText(ai?.glossary));
  blocks.push(previousContextText(ai?.prev_context));
  return blocks.filter(Boolean).join("\n\n");
}

function composeCanonicalPrompt(plan, ai, hasImage) {
  const pieces = plan?.pieces || {};
  const systemBase = String(pieces.systemBase || "").trim();
  const builtIn = String(pieces.editableStyle || "").trim();
  const override = String(ai?.prompt || "").trim();
  const heading = String(pieces.seriesNotesHeading ||
    "SERIES NOTES (from the user — follow these even when they conflict with a rule above):").trim();
  const effectiveStyle = !override ? builtIn : override.toLowerCase().startsWith("target language")
    ? override : `${builtIn}\n\n${heading}\n${override}`;
  const blocks = [systemBase, effectiveStyle];
  if (hasImage) blocks.push(String(pieces.imageHint || "").trim());
  blocks.push(memoryText(ai));
  const structured = plan?.version === "translation-plan-1";
  blocks.push(String(structured ? pieces.structuredOutputContract : pieces.markerOutputContract || "").trim());
  return { system: blocks.filter(Boolean).join("\n\n"), structured };
}

const LEGACY_LOCAL_CONTRACT = "Output ONLY translated text. Keep every <<TP_Pn>> marker exactly once and in order.";

const LOCAL_TRANSLATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["translations", "memo"],
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
      },
    },
    memo: { type: "string" },
  },
};

export async function translateWithLocalOpenAi(units, {
  ai, canonicalPrompt = null, systemText = "", imageDataUri = "", signal = null, timeoutMs = 300000,
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
  // systemText is accepted only for older internal callers/tests. Production
  // direct-local jobs always provide canonicalPrompt; the legacy value is not
  // combined with ai.prompt because doing that recreated the old semantic bug.
  const composed = canonicalPrompt
    ? composeCanonicalPrompt(canonicalPrompt, ai, Boolean(imageDataUri))
    : { system: String(systemText || LEGACY_LOCAL_CONTRACT).trim(), structured: false };
  const system = composed.system;
  if (!system) throw new LocalAiError("Local AI canonical translation prompt is missing", { code: "local_prompt_unavailable" });
  const userText = String(canonicalPrompt?.pieces?.sourcePrefix || "Source (translate this):\n") +
    applyMarkers(units.map((unit) => unit.text));
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
  if (protocol === "ollama" && composed.structured) body.format = LOCAL_TRANSLATION_JSON_SCHEMA;
  // OpenAI-compatible local runtimes disagree on response_format support and
  // the adapter schema has no declared mapping for it. Their canonical route
  // therefore remains prompt-only strict; never send an undeclared field.
  const thinkingMode = ["off", "on"].includes(ai?.thinking) ? ai.thinking : "default";
  if (protocol === "ollama" && thinkingMode !== "default") {
    body.think = thinkingMode === "on";
  } else if (protocol === "openai" && thinkingMode !== "default" && adapter.thinking) {
    // OpenAI-compatible runtimes disagree on the field name and values. Only
    // an explicit custom-adapter declaration is authoritative enough to send
    // one; built-in presets deliberately omit it.
    body[adapter.thinking.parameter] = adapter.thinking[thinkingMode];
  }
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
  const text = contentText(mapped ?? responseText(data)).trim();
  if (!text) {
    const hadReasoning = Boolean(String(data?.message?.thinking || data?.message?.reasoning ||
      data?.choices?.[0]?.message?.reasoning_content || "").trim());
    const finishReason = String(data?.done_reason || data?.choices?.[0]?.finish_reason || "unknown").slice(0, 80);
    throw new LocalAiError(
      `Local AI returned no final answer${hadReasoning ? " (reasoning was produced but is not valid translation output)" : ""}; finish reason: ${finishReason}`,
      { code: hadReasoning ? "local_ai_thinking_no_answer" : "invalid_model_output", attempted: true },
    );
  }
  let decoded;
  try { decoded = decodeTranslations(text, units, { structured: composed.structured }); } catch (error) {
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
  const fetchLocalJson = async (requestPath, { optional = false } = {}) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Local AI model discovery timed out")),
      Math.max(1000, Number(timeoutMs) || 10000),
    );
    try {
      const response = await fetch(`${base}${requestPath}`, {
        method: "GET", headers: { Accept: "application/json" }, cache: "no-store",
        credentials: "omit", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) {
        if (optional) return null;
        throw new LocalAiError(`Local AI model discovery failed (HTTP ${response.status})`, {
          code: "local_models_http_error", status: response.status,
        });
      }
      try { return await response.json(); } catch {
        if (optional) return null;
        throw new LocalAiError("Local AI model list was not JSON", { code: "invalid_local_response" });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (optional) return null;
      if (error instanceof LocalAiError) throw error;
      throw new LocalAiError(
        controller.signal.aborted ? "Local AI model discovery timed out" : "Could not connect to Local AI on this PC",
        { code: controller.signal.aborted ? "local_ai_timeout" : "local_ai_unreachable" },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  };
  // /api/ps is metadata-only. It never invokes generation and Ollama may not
  // expose it on older/compatible servers, so failure must not hide /api/tags.
  const [data, runningData] = protocol === "ollama"
    ? await Promise.all([fetchLocalJson(path), fetchLocalJson("/api/ps", { optional: true })])
    : [await fetchLocalJson(path), null];
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
  return {
    ok: true, models, protocol, endpoint: base,
    capability: buildLocalAiCapabilityHints({ protocol, modelsData: data, runningData }),
  };
}

function boundedNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safeDetailText(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : null;
}

// Pure and exported so scheduler/UI consumers can rely on a small, stable
// metadata contract rather than Ollama's full response. In particular, this
// deliberately does not infer total host VRAM or server parallelism.
export function buildLocalAiCapabilityHints({ protocol = "openai", modelsData = null, runningData = null } = {}) {
  const normalizedProtocol = protocol === "ollama" ? "ollama" : "openai";
  if (normalizedProtocol !== "ollama") {
    return {
      source: "runtime-metadata", protocol: normalizedProtocol, known: false,
      recommendedMax: null,
      reason: "Runtime does not expose a portable capacity contract; use the safe scheduler fallback.",
      models: {},
    };
  }
  const installed = Array.isArray(modelsData?.models) ? modelsData.models : [];
  const running = Array.isArray(runningData?.models) ? runningData.models : [];
  const runningByName = new Map();
  for (const item of running) {
    const name = String(item?.name ?? item?.model ?? "").trim();
    if (name && !runningByName.has(name)) runningByName.set(name, item);
  }
  const modelNames = new Set(installed.map((item) => String(item?.name ?? item?.model ?? "").trim()).filter(Boolean));
  for (const name of runningByName.keys()) modelNames.add(name);
  const installedByName = new Map(installed.map((item) => [String(item?.name ?? item?.model ?? "").trim(), item]));
  const models = Object.create(null);
  for (const model of modelNames) {
    const tag = installedByName.get(model) || {};
    const active = runningByName.get(model) || null;
    const details = active?.details || tag?.details || {};
    const modelBytes = boundedNonNegativeInteger(active?.size ?? tag?.size);
    const vramBytes = boundedNonNegativeInteger(active?.size_vram);
    const contextLength = boundedNonNegativeInteger(active?.context_length);
    const gpuRatio = modelBytes > 0 && vramBytes != null ? vramBytes / modelBytes : null;
    const canTryTwo = Boolean(active) && modelBytes != null && modelBytes <= 8 * 1024 ** 3 &&
      gpuRatio != null && gpuRatio >= 0.9 && contextLength != null && contextLength <= 8192;
    models[model] = {
      model,
      modelBytes,
      vramBytes,
      contextLength,
      loaded: Boolean(active),
      details: {
        family: safeDetailText(details?.family),
        parameterSize: safeDetailText(details?.parameter_size),
        quantizationLevel: safeDetailText(details?.quantization_level),
        format: safeDetailText(details?.format),
      },
      recommendedMax: canTryTwo ? 2 : 1,
      reason: canTryTwo
        ? "Small model is loaded mostly on GPU with context at or below 8192; two requests may be tried as a conservative heuristic, not a runtime limit."
        : active
          ? "Model size, CPU/GPU split, or context does not justify parallel work; start with one request."
          : "Model is installed but runtime capacity is unknown; start with one request.",
    };
  }
  return {
    source: "ollama-api", protocol: "ollama", known: true,
    recommendedMax: 1,
    reason: "Ollama metadata does not prove spare capacity or safe parallelism; start with one request.",
    models,
  };
}
