// Chooses where an AI translation runs — the user's own key, the on-device model, or the API — and runs it.
import { createLogger } from "../shared/logger.js";
import { API_PATHS } from "../shared/constants.js";
const log = createLogger("SW.ai-local");

const promptCache = new Map();
const promptAuditCache = new Map();

// Returns the system prompt for a language from the API, or null when it cannot be fetched.
export async function getSystemPrompt(base, lang, { wantMemo = false } = {}) {
  const key = `${base}|${lang}|memo=${wantMemo ? 1 : 0}`;
  if (promptCache.has(key)) return promptCache.get(key);
  try {
    const url =
      `${base.replace(/\/+$/, "")}${API_PATHS.AI_PROMPT_DEFAULT}` +
      `?lang=${encodeURIComponent(lang)}&want_memo=${wantMemo ? "1" : "0"}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = String(data?.system_text || "").trim();
    if (!text) throw new Error("response carried no system_text");
    promptCache.set(key, text);
    promptAuditCache.set(key, {
      promptVersion: String(data?.promptVersion || ""),
      promptHash: String(data?.promptHash || ""),
      promptChars: Number(data?.promptChars || 0),
      promptSource: String(data?.promptSource || "built_in"),
      systemPromptHash: String(data?.systemPromptHash || ""),
      systemPromptChars: Number(data?.systemPromptChars || text.length),
    });
    return text;
  } catch (e) {
    log.warn("could not fetch the system prompt; local AI is unavailable", {
      lang,
      error: e?.message || String(e),
    });
    return null;
  }
}

// Clears the cached system prompts and their audit metadata.
export function forgetPrompts() {
  promptCache.clear();
  promptAuditCache.clear();
}

// Returns the version and hash metadata for the prompt getSystemPrompt fetched.
export function getPromptAudit(base, lang, { wantMemo = false } = {}) {
  const key = `${base}|${lang}|memo=${wantMemo ? 1 : 0}`;
  return { ...(promptAuditCache.get(key) || {}) };
}

// Translates a LensDocument's units over the chosen route and returns the translations, misses and metadata.
export async function translateUnits(
  units,
  { route, ai, rate = null, unlimited = false, imageDataUri = "", targetLang, sourceLang, systemText, promptAudit = null, base = "", operationId = "", batchId = "", signal = null, traceId = "", trace = null },
) {
  if (!units.length) return { translations: [], missing: [], meta: { route, skipped: "no units" } };

  if (route === "server") {
    const apiBase = String(base || "").replace(/\/+$/, "");
    if (!apiBase) throw new Error("server AI route has no API base URL");
    const body = {
      schema: "tp.ai.request/1",
      operationId,
      ...(batchId ? { batchId } : {}),
      context: { tp_trace: traceId },
      units: units.map(({ id, text }) => ({ id, text })),
      targetLang,
      sourceLang,
      prompt: String(ai?.prompt || ""),
      provider: {
        id: String(ai?.provider || "auto"),
        model: String(ai?.model || "auto"),
        baseUrl: String(ai?.base_url || "auto"),
        apiKey: String(ai?.api_key || ""),
        thinking: String(ai?.thinking || "default"),
      },
      memory: {
        enabled: ai?.char_memory === true,
        glossary: Array.isArray(ai?.glossary) ? ai.glossary : [],
        characters: Array.isArray(ai?.characters) ? ai.characters : [],
        seriesState: String(ai?.series_state || ""),
        previousContext: Array.isArray(ai?.prev_context) ? ai.prev_context : [],
      },
      rate: rate && typeof rate === "object" ? rate : {},
      ...(imageDataUri ? { image: { dataUri: imageDataUri } } : {}),
    };
    const headers = { "Content-Type": "application/json" };
    if (operationId) headers["Idempotency-Key"] = operationId;
    // A local runtime is not a shared resource; the server verifies the caller
    // is on this machine before honouring it.
    if (unlimited) headers["X-TP-Local-Unlimited"] = "1";
    const started = performance.now();
    trace?.("text-only AI request", {
      units: units.length,
      chars: units.reduce((sum, unit) => sum + String(unit.text || "").length, 0),
      targetLang,
      pageImage: Boolean(imageDataUri),
      memoryEnabled: ai?.char_memory === true,
      glossaryItems: Array.isArray(ai?.glossary) ? ai.glossary.length : 0,
      characterItems: Array.isArray(ai?.characters) ? ai.characters.length : 0,
      previousContextItems: Array.isArray(ai?.prev_context) ? ai.prev_context.length : 0,
    });
    let res;
    try {
      res = await fetch(`${apiBase}${API_PATHS.AI_TRANSLATE_V1}`, {
        method: "POST",
        headers,
        cache: "no-store",
        signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      trace?.("text-only AI failed", {
        stage: error?.name === "AbortError" ? "cancelled" : "transport",
        failureKind: error?.name === "AbortError" ? "cancelled" : "network_error",
        errorType: error?.name || "Error",
        error: error?.message || String(error),
        ms: Math.round(performance.now() - started),
        automaticContentRetry: false,
        automaticTransportRetry: false,
        httpAttempts: 1,
        generationAttempts: 1,
        modelFallback: false,
        schemaFallback: false,
      });
      throw error;
    }
    if (!res.ok) {
      const detail = String(await res.text()).slice(0, 500);
      const invalidModelOutput = detail.includes("invalid_model_output");
      trace?.("text-only AI failed", {
        stage: "http",
        failureKind: invalidModelOutput ? "invalid_model_output" :
          (res.status === 429 ? "rate_limited" :
          (res.status >= 500 ? "server_or_provider" : "request_rejected")),
        status: res.status,
        detail,
        ms: Math.round(performance.now() - started),
        automaticContentRetry: false,
        automaticTransportRetry: false,
        httpAttempts: 1,
        providerHttpStatuses: [res.status],
        generationAttempts: 1,
        modelFallback: false,
        schemaFallback: false,
      });
      const error = new Error(`Text-only AI failed: HTTP ${res.status}${detail ? ` - ${detail}` : ""}`);
      error.status = res.status;
      // Retry-After is backpressure, not a failure detail: the lane narrows and pauses on it.
      const retryAfter = Number(res.headers.get("retry-after"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
      throw error;
    }
    const result = await res.json();
    if (result?.schema !== "tp.ai.result/1" || !Array.isArray(result?.translations)) {
      trace?.("text-only AI failed", {
        stage: "response_validation",
        failureKind: "invalid_result_schema",
        receivedSchema: String(result?.schema || ""),
        hasTranslations: Array.isArray(result?.translations),
        ms: Math.round(performance.now() - started),
        automaticContentRetry: false,
        automaticTransportRetry: false,
        httpAttempts: 1,
        providerHttpStatuses: [res.status],
        generationAttempts: 1,
        modelFallback: false,
        schemaFallback: false,
      });
      throw new Error("Text-only AI returned an invalid schema");
    }
    trace?.("text-only AI reply", {
      status: res.status,
      ms: Math.round(performance.now() - started),
      translations: result.translations.length,
      missing: Array.isArray(result.missing) ? result.missing.length : 0,
      missingIds: Array.isArray(result.missing) ? result.missing.map(String) : [],
      omittedIds: Array.isArray(result?.meta?.omittedIds) ? result.meta.omittedIds.map(String) : [],
      responseShape: String(result?.meta?.responseShape || ""),
      replayed: Boolean(result.replayed),
      promptVersion: String(result?.meta?.promptVersion || ""),
      promptHash: String(result?.meta?.promptHash || ""),
      promptChars: Number(result?.meta?.promptChars || 0),
      promptSource: String(result?.meta?.promptSource || ""),
      vision: Boolean(result?.meta?.vision),
      markersFound: Boolean(result?.meta?.markersFound),
      outputContract: String(result?.meta?.outputContract || ""),
      responseShape: String(result?.meta?.responseShape || ""),
      acceptedLosslessly: Boolean(result?.meta?.acceptedLosslessly),
      contentModified: Boolean(result?.meta?.contentModified),
      providerAttempts: Number(result?.meta?.providerAttempts || 0),
      generationAttempts: Number(result?.meta?.generationAttempts || 0),
      httpAttempts: Number(result?.meta?.httpAttempts || 0),
      providerHttpStatuses: Array.isArray(result?.meta?.providerHttpStatuses)
        ? result.meta.providerHttpStatuses : [res.status],
      automaticContentRetry: false,
      automaticTransportRetry: false,
      modelFallback: Boolean(result?.meta?.modelFallback),
      schemaFallback: Boolean(result?.meta?.schemaFallback),
      aiFlow: String(result?.meta?.aiFlow || ""),
      memoryCharacters: Array.isArray(result?.memoryDelta?.characters)
        ? result.memoryDelta.characters.length : 0,
      memoryGlossary: Array.isArray(result?.memoryDelta?.glossary)
        ? result.memoryDelta.glossary.length : 0,
    });
    return { ...result, meta: { ...(result.meta || {}), route: "server" } };
  }

  // The only route this build has is "server": prompt composition lives in
  // `/v1/ai/translate`, so there is nothing for the browser to compose. A
  // caller asking for anything else is a bug in the caller, not a reason to
  // quietly translate a page some other way.
  throw new Error(
    `unknown AI route ${JSON.stringify(route)}; this build only has "server"`,
  );
}

// No fallback: an AI failure is terminal for the image, so this always returns false.
export function shouldFallBackToServer(error) {
  void error;
  return false;
}
