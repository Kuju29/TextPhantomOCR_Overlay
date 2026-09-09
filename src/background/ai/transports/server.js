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
import { AI_PROMPT_MODE, requireAiPrompt } from "../../../shared/ai-prompt-policy.js";
import { beginApiRequest, noteApiActivity, noteApiSuccess } from "../../api.js";

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
  const prompt = requireAiPrompt(ai?.prompt);
  const usageStartedAt = Date.now();
  const apiBase = String(base || "").replace(/\/+$/, "");
  if (!apiBase) throw new Error("server AI route has no API base URL");

  const outputSelection = workloadSelection(ai || {}, "server");
  const body = {
    schema: "tp.ai.request/1",
    operationId,
    ...(batchId ? { batchId } : {}),
    context: {
      tp_trace: traceId,
      ...(tabSession ? { tp_tab_session: String(tabSession) } : {}),
    },
    units: units.map(({ id, text }) => ({ id, text })),
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
      thinking: ai?.thinking === "on" ? "on" : "off",
      ...(outputSelection.contract ? { outputContract: outputSelection.contract } : {}),
      modelCapabilities: outputSelection.caps,
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

  if (ai?.repair_reason === "wrong_target_script") body.repair.reason = ai.repair_reason;

  const requestPath = repairClaim
    ? repairRunPath(repairClaim.runId, `tasks/${encodeURIComponent(repairClaim.taskId)}/translate`)
    : engineApiPath(capabilities, API_PATHS.ENGINE_EXTENSION_AI_TRANSLATE, API_PATHS.AI_TRANSLATE_V1);
  const requestId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
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
    httpStarted = performance.now(); httpAttempts = 1;
    progress("http_wait"); emitTiming("http_started");
    res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal,
      body: JSON.stringify(body),
    });
    headersAt = performance.now();
    emitTiming("http_headers", {status:res.status, headersMs: headersAt-httpStarted});
    trace?.("text-only AI server first byte", {
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

  if (!res.ok) {
    const rawText = String(await res.text());
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
      providerHttpStatuses: [res.status],
      generationAttempts,
      modelFallback: false,
      schemaFallback: false,
    });
    const error = new Error(
      `Text-only AI failed: HTTP ${res.status}${detailText ? ` - ${detailText}` : ""}`,
    );
    error.status = res.status;
    error.code = code;
    error.retryAfterMs = retryAfterMs;
    error.providerAttempts = providerAttempts;
    error.generationAttempts = generationAttempts;
    if (generationAttempts === 0 && (detailObject?.requestDispatched === false ||
        detailObject?.generationAttempts === 0 || (res.status >= 400 && res.status < 500)))
      await persistProviderGeneration({ operationId, engine: "runsextension", resolvePending: true });
    if (generationAttempts > 0)
      await persistProviderGeneration(
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
  const rawResponse = String(await res.text());
  emitTiming("response_complete", {httpMs: performance.now()-httpStarted, bodyMs:performance.now()-headersAt});
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
    if (generationAttempts > 0) await persistProviderGeneration(
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
    providerMs: Number(result?.meta?.providerMs || 0), parseMs: Number(result?.meta?.parseMs || 0) });

  const generationAttempts = Math.max(
    1,
    Number(result?.meta?.generationAttempts) || 1,
  );
  await persistProviderGeneration(
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
      translatedUnits: result.translations.length,
      providerMs: result?.meta?.providerMs,
      totalMs: result?.meta?.dt_ms,
    },
    { emitTrace: trace },
  );
  return { ...result, meta: { ...(result.meta || {}), route: "server" } };
}
