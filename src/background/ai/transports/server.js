import {requireConversationApi} from "../../../shared/ai/conversation/support.js";
import "../../../shared/diagnostic-schema.js";
import { repairRunPath } from "../../repair/client.js";
import { workloadSelection } from "../../../shared/ai/workload/contract.js";
import {
  API_PATHS,
  engineApiPath,
  isLocalAiTarget,
} from "../../../shared/constants.js";
import {
  failureUsageDetails,
  persistProviderGeneration,
} from "../../../shared/ai-usage.js";
import { AI_PROMPT_MODE, normalizeAiPrompt } from "../../../shared/ai-prompt-policy.js";
import { beginApiRequest, noteApiActivity, noteApiSuccess } from "../../api.js";

/** Read only the negotiated transport envelope; model output is never reparsed here. */
export async function readAiStream(response, onDelta) {
  const reader = response.body?.getReader?.();
  const invalid = message => Object.assign(new Error(message), {code:"invalid_ai_stream"});
  if (!reader) throw invalid("AI stream has no readable body");
  const decoder = new TextDecoder();
  let pending = "", sequence = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      pending += decoder.decode(value, {stream:!done});
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw invalid("AI stream contains invalid NDJSON"); }
        if (event?.schema !== "tp.ai.stream/1" || event.sequence !== ++sequence)
          throw invalid("AI stream schema or sequence mismatch");
        if (event.type === "delta" && typeof event.text === "string") {
          onDelta?.(event.text);
        } else if (event.type === "result" && event.body && typeof event.body === "object") {
          return {status:200, body:event.body};
        } else if (event.type === "error" && Number.isInteger(event.status) && event.status >= 400 && event.status <= 599 && event.body && typeof event.body === "object") {
          return {status:event.status, body:event.body};
        } else throw invalid("AI stream contains an invalid event");
      }
      if (done) throw invalid("AI stream ended without a result or error event");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sourceChars(units) {
  return units.reduce((sum, unit) => sum + Array.from(String(unit?.text || "")).length, 0);
}

function runtimeFor(provider, baseUrl) {
  return isLocalAiTarget(provider, baseUrl) ? "local" : "cloud";
}

/**
 * Send one extension-owned translation generation through the API server.
 *
 * This transport deliberately does not repair, retry, or select a fallback.
 * Those policies remain owned by the extension orchestration layer.
 */
export async function translateViaServer(
  units,
  {
    ai,
    rate = null,
    unlimited = false,
    imageDataUri = "",
    targetLang,
    sourceLang,
    base = "",
    operationId = "",
    batchId = "",
    imageId = "",
    jobId = "",
    signal = null,
    traceId = "",
    tabSession = "",
    trace = null,
    capabilities = null,
    wireTrace = null,
    repairClaim = null,
    onProgress = null,
  } = {},
) {
  const promptMode = AI_PROMPT_MODE;
  const prompt = normalizeAiPrompt(ai?.prompt);
  const usageStartedAt = Date.now();
  const apiBase = String(base || "").replace(/\/+$/, "");
  if (!apiBase) throw new Error("server AI route has no API base URL");

  requireConversationApi(ai, capabilities);
  const outputSelection = workloadSelection(ai || {}, "server");
  const body = {
    schema: "tp.ai.request/1",
    translationMode: ai?.translation_mode === "conversation" ? "conversation" : "independent",
    conversation: {...(ai?.conversation || {}), ...(repairClaim ? {branch:"repair"} : {})},
    operationId,
    ...(batchId ? { batchId } : {}),
    context: {
      tp_trace: traceId,
      ...(tabSession ? { tp_tab_session: String(tabSession) } : {}),
    },
    units: units.map(({ id, text }) => ({ id, text })),
    pageContext: Array.isArray(ai?.page_context) ? ai.page_context : [],
    sourceContext: Array.isArray(ai?.source_context) ? ai.source_context : [],
    targetLang,
    sourceLang,
    repair: { owner: "extension", enabled: false },
    prompt,
    prompt_mode: promptMode,
    ...(ai?.workload?.version === 1 ? { workload: ai.workload } : {}),
    provider: {
      id: String(ai?.provider || "auto"),
      model: String(ai?.model || "auto"),
      baseUrl: String(ai?.base_url || "auto"),
      apiKey: String(ai?.api_key || ""),
      thinking: String(ai?.thinking || "minimum"),
      ...(outputSelection.contract ? { outputContract: outputSelection.contract } : {}),
      modelCapabilities: outputSelection.caps,
    },
    memory: {
      ...(["off", "terms", "full"].includes(ai?.memory_mode) ? { mode: ai.memory_mode } : {}),
      styleExamples: ai?.translation_mode === "conversation" ? false : ai?.style_examples !== false,
      enabled: ai?.char_memory === true,
      glossary: Array.isArray(ai?.glossary) ? ai.glossary : [],
      characters: Array.isArray(ai?.characters) ? ai.characters : [],
      seriesState: String(ai?.series_state || ""),
      previousContext: Array.isArray(ai?.prev_context) ? ai.prev_context : [],
    },
    rate: rate && typeof rate === "object" ? rate : {},
    ...(imageDataUri ? { image: { dataUri: imageDataUri } } : {}),
  };

  if (ai?.repair_reason === "wrong_target_script") body.repair.reason = ai.repair_reason;

  const requestPath = repairClaim
    ? repairRunPath(repairClaim.runId, `tasks/${encodeURIComponent(repairClaim.taskId)}/translate`)
    : engineApiPath(capabilities, API_PATHS.ENGINE_EXTENSION_AI_TRANSLATE, API_PATHS.AI_TRANSLATE_V1);
  const progressiveRequested = body.translationMode === "conversation" && !repairClaim;
  const requestId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    ...(progressiveRequested ? {Accept:"application/x-ndjson"} : {}),
    ...(repairClaim ? { "X-TP-Run-Token": repairClaim.token } : {}),
    "X-TP-Request-Id": requestId,
    ...(jobId ? { "X-TP-Job-Id": String(jobId) } : {}),
    ...(imageId ? { "X-TP-Image-Id": String(imageId) } : {}),
    ...(batchId ? { "X-TP-Batch-Id": String(batchId) } : {}),
    ...(traceId ? { "X-TP-Trace-Id": String(traceId) } : {}),
  };
  try {
    const version = String(chrome?.runtime?.getManifest?.()?.version || "");
    if (version) headers["X-TP-Client-Version"] = version;
  } catch {}
  if (operationId) headers["Idempotency-Key"] = operationId;
  if (unlimited) headers["X-TP-Local-Unlimited"] = "1";

  const started = performance.now();
  await wireTrace?.("providerRequest", { url: `${apiBase}${requestPath}`,
    method: "POST", headers, body });
  trace?.("text-only AI request", {
    units: units.length,
    chars: sourceChars(units),
    targetLang,
    pageImage: Boolean(imageDataUri),
    memoryEnabled: ai?.char_memory === true,
    glossaryItems: Array.isArray(ai?.glossary) ? ai.glossary.length : 0,
    characterItems: Array.isArray(ai?.characters) ? ai.characters.length : 0,
    previousContextItems: Array.isArray(ai?.prev_context)
      ? ai.prev_context.length
      : 0,
    capabilityForwarded: Object.keys(body.provider.modelCapabilities).length > 0,
  });

  let res, httpStarted = null, headersAt = null, usageTiming = null;
  let httpAttempts = 0;
  const emitTiming = (reason, extra = {}) => trace?.("requestTiming", {
    schema: "tp.audit/1", event: "request_timing", reason,
    scope: { operationId, requestId, imageId, batchId, jobId, traceId },
    timing: { elapsedMs: performance.now() - started, httpAttempts,
      ...(usageTiming || {}), ...extra },
  });
  const progress = state => { try { onProgress?.({state}); } catch {} };
  const persistResponseUsage = async (details, options = {}) => {
    const usageCallbackStarted = performance.now();
    let commitTiming = null, failed = true;
    try {
      const value = await persistProviderGeneration(details, { ...options,
        onTiming: timing => { commitTiming = timing; options.onTiming?.(timing); } });
      failed = false;
      return value;
    } finally {
      // Isolate the post-response callback from pre-dispatch durable intent and
      // HTTP. This includes queueing, persistence and its trace callback only.
      try { trace?.("requestTiming", {
        schema:"tp.audit/1", event:"usage_commit_timing", reason:failed ? "failed" : "success",
        scope:{operationId,requestId,imageId,batchId,jobId,traceId},
        timing:{...(commitTiming || {}), usageCallbackMs:Math.max(0,performance.now()-usageCallbackStarted)},
      }); } catch {}
    }
  };
  let streamedBody = null;
  const readResponseBody = async () => {
    try {
      const raw = streamedBody !== null ? streamedBody : String(await res.text());
      const bodyCompleteAt = performance.now();
      emitTiming("response_complete", {httpMs:bodyCompleteAt-httpStarted,
        headersMs:headersAt-httpStarted, bodyMs:bodyCompleteAt-headersAt});
      return raw;
    } catch (error) {
      emitTiming("body_failed", {httpMs:performance.now()-httpStarted, bodyMs:performance.now()-headersAt});
      throw error;
    }
  };
  const finishApiRequest = beginApiRequest(apiBase);
  try {
    noteApiActivity(apiBase);
    const path = requestPath;
    trace?.("text-only AI request ready", {
      provider: body.provider.id,
      model: body.provider.model,
      units: body.units.length,
      ms: Math.round(performance.now() - started),
    });
    signal?.throwIfAborted?.();
    progress("usage_pending"); emitTiming("usage_pending");
    await persistProviderGeneration({ pending: true, operationId,
      provider: ai?.provider, model: ai?.model, engine: "runsextension",
      runtime: runtimeFor(ai?.provider, ai?.base_url) },
      { onTiming: value => { usageTiming = value; } });
    if (signal?.aborted) {
      await persistProviderGeneration({operationId, engine:"runsextension", resolvePending:true});
      throw signal.reason || new DOMException("Aborted", "AbortError");
    }
    const requestBody = JSON.stringify(body);
    progress("sending_request");
    httpStarted = performance.now(); httpAttempts = 1;
    const pendingResponse = fetch(`${apiBase}${path}`, {
      method: "POST",
      headers,
      cache: "no-store",
      priority: "high",
      signal,
      body: requestBody,
    });
    progress("http_wait");
    emitTiming("http_started");
    res = await pendingResponse;
    headersAt = performance.now();
    progress("response_headers");
    emitTiming("http_headers", {status:res.status, headersMs: headersAt-httpStarted});
    // fetch() resolves when response headers are available. The JSON body is
    // buffered below, so this is not a provider-stream first-token signal.
    trace?.("text-only AI response headers", {
      status: res.status,
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    finishApiRequest();
    const cancelled = signal?.aborted === true || error?.name === "AbortError";
    emitTiming(cancelled ? "cancelled" : httpAttempts ? "http_failed" : "persistence_failed");
    trace?.("text-only AI failed", {
      stage: cancelled ? "cancelled" : httpAttempts ? "transport" : "persistence",
      failureKind: cancelled ? "cancelled" : httpAttempts ? "network_error" : "storage_error",
      errorType: error?.name || "Error",
      ms: Math.round(performance.now() - started),
      automaticContentRetry: false,
      automaticTransportRetry: false,
      httpAttempts,
      generationAttempts: httpAttempts ? null : 0,
      providerAttempts: null,
      usageStatus: httpAttempts ? "unconfirmed_transport" : "not_dispatched",
      modelFallback: false,
      schemaFallback: false,
    });
    if (cancelled) {
      // DOMException.code is read-only in browsers. Do not mask AbortError with
      // a TypeError while annotating cancellation evidence.
      throw Object.assign(new Error("The operation was cancelled", {cause:error}), {
        name:"AbortError", code:"cancelled", requestDispatched:httpAttempts>0,
        generationAttempts:httpAttempts ? null : 0,
      });
    }
    throw error;
  }
  finishApiRequest();

  if (res.ok && progressiveRequested && !res.headers.get("content-type")?.includes("application/x-ndjson")) {
    // A successful full-body response cannot silently satisfy a negotiated
    // progressive request. Do not resend it: the old server may have generated.
    await res.body?.cancel?.().catch(() => {});
    emitTiming("stream_unsupported", {httpMs:performance.now()-httpStarted});
    trace?.("text-only AI failed", {
      stage:"response_stream", failureKind:"ai_stream_unsupported", httpAttempts:1,
      generationAttempts:null, requestDispatched:null, usageStatus:"unconfirmed_transport",
      automaticContentRetry:false, automaticTransportRetry:false,
      modelFallback:false, schemaFallback:false,
    });
    throw Object.assign(new Error("This API did not return the requested translation stream. Update the API."), {
      code:"ai_stream_unsupported", status:res.status, origin:"api", category:"configuration",
      stage:"response_stream", retryable:false, generationAttempts:null,
    });
  }

  if (res.ok && res.headers.get("content-type")?.includes("application/x-ndjson")) {
    let terminal, receivedDelta = false;
    try {
      terminal = await readAiStream(res, text => {
        receivedDelta = true;
        try { onProgress?.({state:"translation_delta", text}); } catch {}
      });
    } catch (error) {
      // A broken envelope cannot invent final provider usage. Keep its durable
      // pending receipt unresolved and distinguish known content from headers.
      if (receivedDelta) error.requestDispatched = true;
      error.generationAttempts = receivedDelta ? 1 : null;
      error.stage = "response_stream";
      emitTiming("stream_failed", {httpMs:performance.now()-httpStarted});
      trace?.("text-only AI failed", {
        stage:"response_stream", failureKind:error?.code || "stream_interrupted",
        httpAttempts:1, generationAttempts:error.generationAttempts,
        requestDispatched:receivedDelta ? true : null,
        usageStatus:"unconfirmed_transport", automaticContentRetry:false,
        automaticTransportRetry:false, modelFallback:false, schemaFallback:false,
      });
      throw error;
    }
    streamedBody = JSON.stringify(terminal.body);
    if (terminal.status >= 400) {
      // Reuse the same typed error/accounting path as a normal HTTP error.
      res = {ok:false, status:terminal.status, headers:res.headers};
    }
  }

  if (!res.ok) {
    const rawText = await readResponseBody();
    await wireTrace?.("providerResponse", { mode: "body", status: res.status, raw: rawText });
    await wireTrace?.("providerAssembled", { text: rawText, complete: true,
      source: "extension_api_http_body" });
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {}
    const detailObject =
      parsed && typeof parsed === "object"
        ? parsed.detail && typeof parsed.detail === "object"
          ? parsed.detail
          : parsed
        : null;
    const detailText = detailObject
      ? String(
          detailObject.message ||
            detailObject.error ||
            detailObject.code ||
            rawText,
        ).slice(0, 500)
      : rawText.slice(0, 500);
    const code = String(detailObject?.code || detailObject?.error || "");
    const providerAttempts = Number(detailObject?.providerAttempts || 0);
    const charged = failureUsageDetails(detailObject);
    const generationAttempts = Number(
      detailObject?.generationAttempts ??
        charged.generationAttempts ??
        providerAttempts,
    );
    const invalidModelOutput =
      code === "invalid_model_output" ||
      rawText.includes("invalid_model_output");
    const headerRetryAfter = Number(res.headers.get("retry-after"));
    const bodyRetryAfterMs = Number(detailObject?.retryAfterMs || 0);
    const retryAfterMs =
      bodyRetryAfterMs > 0
        ? bodyRetryAfterMs
        : Number.isFinite(headerRetryAfter) && headerRetryAfter > 0
          ? headerRetryAfter * 1000
          : 0;
    trace?.("text-only AI failed", {
      stage: "http",
      failureKind: invalidModelOutput
        ? "invalid_model_output"
        : code === "rate_gate_busy" || code === "local_rate_gate_busy"
          ? "rate_gate_busy"
          : code === "server_busy"
            ? "server_busy"
            : code === "provider_rate_limited"
              ? "provider_rate_limited"
              : res.status === 429
                ? "rate_limited"
                : res.status >= 500
                  ? "server_or_provider"
                  : "request_rejected",
      status: res.status,
      code,
      retryAfterMs,
      providerAttempts,
      ms: Math.round(performance.now() - started),
      automaticContentRetry: false,
      automaticTransportRetry: false,
      httpAttempts: 1,
      apiHttpStatus: res.status,
      providerHttpStatuses: Number.isInteger(detailObject?.upstreamStatus) ? [detailObject.upstreamStatus] : [],
      generationAttempts,
      modelFallback: false,
      schemaFallback: false,
    });
    const error = new Error(
      `Text-only AI failed: HTTP ${res.status}${detailText ? ` - ${detailText}` : ""}`,
    );
    error.status = res.status;
    if (["api", "client", "upstream_ai"].includes(detailObject?.origin)) error.origin = detailObject.origin;
    if (code === "ai_conversation_origin_invalid") {
      error.stage = "conversation_mapping";
      error.category = "input";
      error.retryable = false;
      const v = detailObject?.validation;
      if (v && /^conversation\.origins(?:\.[a-zA-Z0-9]+)*$/.test(String(v.field || "")))
        error.validation = {field: String(v.field).slice(0,120), reason: String(v.reason || "invalid").slice(0,80)};
    }
    error.code = code;
    error.retryAfterMs = retryAfterMs;
    error.providerAttempts = providerAttempts;
    error.generationAttempts = generationAttempts;
    // Preserve only typed, additive API provenance for later bounded repair.
    // Never derive upstream status/finality from response text or outer status.
    if (detailObject?.providerFailureKind === "http_status")
      error.providerFailureKind = "http_status";
    if (Number.isInteger(detailObject?.upstreamStatus))
      error.upstreamStatus = detailObject.upstreamStatus;
    if (typeof detailObject?.requestDispatched === "boolean")
      error.requestDispatched = detailObject.requestDispatched;
    if (generationAttempts === 0 && (detailObject?.requestDispatched === false ||
        detailObject?.generationAttempts === 0 || (res.status >= 400 && res.status < 500)))
      await persistResponseUsage({ operationId, engine: "runsextension", resolvePending: true });
    if (generationAttempts > 0)
      await persistResponseUsage(
        {
          runtime: runtimeFor(
            charged.provider || ai?.provider,
            charged.baseUrl || ai?.base_url,
          ),
          provider:
            charged.provider ||
            detailObject?.provider ||
            ai?.provider ||
            "unknown",
          model: charged.model || detailObject?.model || ai?.model || "unknown",
          requestedModel: ai?.model,
          engine: "runsextension",
          requests: generationAttempts,
          failures: generationAttempts,
          generationAttempts,
          reason: "provider_charged_failure",
          operationId,
          requestId,
          traceId,
          startedAt: usageStartedAt,
          usage: charged.usage,
          inputTokens: charged.inputTokens,
          outputTokens: charged.outputTokens,
          totalTokens: charged.totalTokens,
          sourceChars: sourceChars(units),
          jobId, batchId, imageCount: imageId || imageDataUri ? 1 : 0,
          providerMs: charged.providerMs,
          totalMs: Number.isFinite(charged.totalMs)
            ? charged.totalMs
            : Math.round(performance.now() - started),
        },
        { emitTrace: trace },
      );
    throw error;
  }

  noteApiSuccess(apiBase);
  const rawResponse = await readResponseBody();
  progress("validating");
  await wireTrace?.("providerResponse", { mode: "body", status: res.status, raw: rawResponse });
  await wireTrace?.("providerAssembled", { text: rawResponse, complete: true,
    source: "extension_api_http_body" });
  let result;
  try { result = rawResponse ? JSON.parse(rawResponse) : null; }
  catch { result = null; }
  if (
    result?.schema !== "tp.ai.result/1" ||
    !Array.isArray(result?.translations)
  ) {
    const charged = failureUsageDetails(result?.meta || result);
    const generationAttempts = Math.max(0, charged.generationAttempts || Number(result?.meta?.generationAttempts) || 0);
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
      generationAttempts,
      modelFallback: false,
      schemaFallback: false,
    });
    if (generationAttempts > 0) await persistResponseUsage(
      {
        runtime: runtimeFor(
          charged.provider || result?.meta?.provider || ai?.provider,
          charged.baseUrl ||
            result?.meta?.baseUrl ||
            result?.meta?.base_url ||
            ai?.base_url,
        ),
        provider:
          charged.provider ||
          result?.meta?.provider ||
          ai?.provider ||
          "unknown",
        model: charged.model || result?.meta?.model || ai?.model || "unknown",
        requestedModel: ai?.model,
        engine: "runsextension",
        requests: generationAttempts,
        failures: generationAttempts,
        generationAttempts,
        reason: "provider_charged_failure",
        operationId,
        requestId,
        traceId,
        replayed: Boolean(result?.replayed),
        startedAt: usageStartedAt,
        usage: charged.usage,
        inputTokens: charged.inputTokens,
        outputTokens: charged.outputTokens,
        totalTokens: charged.totalTokens,
        sourceChars: sourceChars(units),
        jobId, batchId, imageCount: imageId || imageDataUri ? 1 : 0,
        providerMs: charged.providerMs,
        totalMs: Number.isFinite(charged.totalMs)
          ? charged.totalMs
          : Math.round(performance.now() - started),
      },
      { emitTrace: trace },
    );
    const error = new Error("Text-only AI returned an invalid schema");
    error.code = "invalid_result_schema";
    error.status = res.status;
    error.providerAttempts = Number(result?.meta?.providerAttempts || 0);
    error.generationAttempts = generationAttempts;
    throw error;
  }

  if (result.meta?.conversation) {
    const evidence = globalThis.TPAuditSchema.sanitizeConversation(result.meta.conversation);
    if (evidence) trace?.("AI conversation path", evidence);
  }
  if (result.meta?.cacheCoordination) {
    const evidence = globalThis.TPAuditSchema.sanitizeCacheCoordination({...result.meta.cacheCoordination,operationId});
    if (evidence) trace?.("cacheCoordination", evidence);
  }
  trace?.("text-only AI reply", {
    targetLang: String(targetLang || ""),
    status: res.status,
    ms: Math.round(performance.now() - started),
    translations: result.translations.length,
    missing: Array.isArray(result.missing) ? result.missing.length : 0,
    missingIds: Array.isArray(result.missing) ? result.missing.map(String) : [],
    omittedIds: Array.isArray(result?.meta?.omittedIds)
      ? result.meta.omittedIds.map(String)
      : [],
    declinedIds: Array.isArray(result?.meta?.declinedIds)
      ? result.meta.declinedIds.map(String)
      : [],
    responseShape: String(result?.meta?.responseShape || ""),
    replayed: Boolean(result.replayed),
    promptVersion: String(result?.meta?.promptVersion || ""),
    promptSource: String(result?.meta?.promptSource || ""),
    userPromptPresent: Boolean(result?.meta?.userPromptPresent),
    userPromptChars: Number(result?.meta?.userPromptChars || 0),
    promptMode: String(result?.meta?.promptMode || ""),
    effectiveStyleChars: Number(result?.meta?.effectiveStyleChars || 0),
    effectiveStyleFingerprint: String(
      result?.meta?.effectiveStyleFingerprint || "",
    ),
    effectiveSystemPromptChars: Number(
      result?.meta?.effectiveSystemPromptChars || 0,
    ),
    effectiveSystemPromptFingerprint: String(
      result?.meta?.effectiveSystemPromptFingerprint || "",
    ),
    vision: Boolean(result?.meta?.vision),
    markersFound: Boolean(result?.meta?.markersFound),
    outputContract: String(result?.meta?.outputContract || ""),
    acceptedLosslessly: Boolean(result?.meta?.acceptedLosslessly),
    contentModified: Boolean(result?.meta?.contentModified),
    providerAttempts: Number(result?.meta?.providerAttempts || 0),
    generationAttempts: Number(result?.meta?.generationAttempts || 0),
    httpAttempts: Number(result?.meta?.httpAttempts || 0),
    providerHttpStatuses: Array.isArray(result?.meta?.providerHttpStatuses)
      ? result.meta.providerHttpStatuses
      : [res.status],
    automaticContentRetry: false,
    automaticTransportRetry: false,
    modelFallback: Boolean(result?.meta?.modelFallback),
    schemaFallback: Boolean(result?.meta?.schemaFallback),
    aiFlow: String(result?.meta?.aiFlow || ""),
    memoryCharacters: Array.isArray(result?.memoryDelta?.characters)
      ? result.memoryDelta.characters.length
      : 0,
    memoryGlossary: Array.isArray(result?.memoryDelta?.glossary)
      ? result.memoryDelta.glossary.length
      : 0,
  });
  await wireTrace?.("parsedRecords", result.translations);
  await wireTrace?.("providerValidation", { missingIds: Array.isArray(result.missing) ? result.missing.map(String) : [],
    omittedIds: Array.isArray(result?.meta?.omittedIds) ? result.meta.omittedIds.map(String) : [],
    declinedIds: Array.isArray(result?.meta?.declinedIds) ? result.meta.declinedIds.map(String) : [] });
  await wireTrace?.("timing", { totalMs: Math.round(performance.now() - started), status: res.status,
    providerMs: Number.isFinite(result?.meta?.providerMs) ? result.meta.providerMs : null,
    parseMs: Number.isFinite(result?.meta?.parseMs) ? result.meta.parseMs : null });

  const generationAttempts = Math.max(
    1,
    Number(result?.meta?.generationAttempts) || 1,
  );
  await persistResponseUsage(
    {
      runtime: runtimeFor(
        result?.meta?.resolvedProvider ||
          result?.meta?.provider ||
          ai?.provider,
        result?.meta?.baseUrl || result?.meta?.base_url || ai?.base_url,
      ),
      provider:
        result?.meta?.resolvedProvider ||
        result?.meta?.resolved_provider ||
        result?.meta?.provider ||
        ai?.provider ||
        "unknown",
      model:
        result?.meta?.resolvedModel ||
        result?.meta?.resolved_model ||
        result?.meta?.model ||
        ai?.model ||
        "unknown",
      engine: "runsextension",
      generationAttempts,
      reason: result?.meta?.repairAttempted ? "repair" : "translation_success",
      operationId,
      requestId,
      traceId,
      replayed: Boolean(result?.replayed),
      startedAt: usageStartedAt,
      requests: generationAttempts,
      usage: result?.meta?.usage,
      inputTokens: result?.meta?.usage?.inputTokens,
      outputTokens: result?.meta?.usage?.outputTokens,
      totalTokens: result?.meta?.usage?.totalTokens,
      sourceChars: sourceChars(units),
      jobId, batchId, imageCount: imageId || imageDataUri ? 1 : 0,
      translatedUnits: result.translations.length,
      providerMs: result?.meta?.providerMs,
      totalMs: result?.meta?.dt_ms,
    },
    { emitTrace: trace },
  );
  return { ...result, meta: { ...(result.meta || {}), route: "server" } };
}
