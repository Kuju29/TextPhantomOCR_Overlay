// Runs one direct-to-local-provider translation generation for runs:Extension.
// This transport owns the local trust boundary, trace evidence and usage ledger;
// orchestration (including repair policy) remains with its caller.
import { translateWithLocalOpenAi } from "../../../shared/ai/direct-local/generation.js";
import {
  failureUsageDetails,
  persistProviderGeneration,
} from "../../../shared/ai-usage.js";

/**
 * Translate units through the user's directly connected local AI provider.
 *
 * @param {Array<{id: string, text: string}>} units
 * @param {object} options
 * @returns {Promise<{translations: Array, missing: Array, meta: object}>}
 */
export async function translateDirectLocal(
  units,
  {
    ai,
    imageDataUri = "",
    targetLang,
    sourceLang,
    canonicalPrompt = null,
    promptAudit = null,
    operationId = "",
    batchId = "",
    imageId = "",
    jobId = "",
    signal = null,
    traceId = "",
    trace = null,
    onProgress = null,
    wireTrace = null,
  } = {},
) {
  if (!units.length) {
    return {
      translations: [],
      missing: [],
      meta: { route: "direct-local", skipped: "no units" },
    };
  }

  const started = performance.now();
  const usageStartedAt = Date.now();
  trace?.("direct Local AI intent", {
    units: units.length,
    provider: String(ai?.provider || "local"),
    model: String(ai?.model || ""),
    endpointHost: (() => {
      try {
        return new URL(String(ai?.base_url || "")).host;
      } catch {
        return "invalid";
      }
    })(),
    cloudKeySent: false,
    contractVersion:
      String(
        ai?.adapter?.translationContract ||
          ai?.adapter?.contractVersion ||
          "v2",
      ).toLowerCase() === "v1"
        ? "tp.local.association/1"
        : "tp.translation.units/1",
    operationId,
    batchId,
    imageId,
    jobId,
    requestAttempted: true,
    generationIntent: true,
  });
  let result;
  try {
    result = await translateWithLocalOpenAi(units, {
      // Strip the key at the trust boundary as well as omitting it in the adapter.
      ai: { ...(ai || {}), api_key: "" },
      canonicalPrompt,
      imageDataUri,
      sourceLang,
      targetLang,
      promptAudit,
      signal,
      trace,
      onProgress,
      wireTrace,
    });
  } catch (error) {
    const charged = failureUsageDetails(error);
    const generationAttempts = Math.max(
      0,
      Number(charged.generationAttempts || error?.generationAttempts || 0),
    );
    const providerAttempts = Math.max(
      generationAttempts,
      Number(error?.providerAttempts || 0),
    );
    await wireTrace?.("failure", {
      stage: error?.providerResponded === true ? "provider_response" : "provider_request",
      code: String(error?.code || ""), name: String(error?.name || "Error"),
      message: String(error?.message || error), status: Number(error?.status || 0),
      requestDispatched: error?.requestDispatched === true,
      providerResponded: error?.providerResponded === true,
      providerAttempts, generationAttempts,
    });
    await wireTrace?.("timing", { totalMs: Math.round(performance.now() - started),
      failed: true, providerMs: Number(error?.diagnostics?.providerMs || 0),
      parseMs: Number(error?.diagnostics?.parseMs || 0) });
    if (error?.code === "AI_OUTPUT_CONTRACT_MISMATCH") {
      const diagnostics =
        error?.diagnostics && typeof error.diagnostics === "object"
          ? error.diagnostics
          : {};
      // Keep this event narrow and nested so compact TP_TRACE retains the
      // complete structural evidence instead of replacing it with `…`.
      trace?.("AI local contract diagnostic", {
        event: "contract_mismatch",
        contract: {
          responseGrammar: String(diagnostics.responseGrammar || ""),
          validatorSubtype: String(diagnostics.validatorSubtype || "unknown"),
          markerCount: Number(diagnostics.markerCount || 0),
          receivedIds: Array.isArray(diagnostics.receivedIds) ? diagnostics.receivedIds : [],
          missingIds: Array.isArray(diagnostics.missingIds) ? diagnostics.missingIds : [],
          extraIds: Array.isArray(diagnostics.extraIds) ? diagnostics.extraIds : [],
          duplicateIds: Array.isArray(diagnostics.duplicateIds) ? diagnostics.duplicateIds : [],
          prefixProse: diagnostics.prefixProse === true,
          suffixProse: diagnostics.suffixProse === true,
          firstMarkerOffset: Number.isFinite(diagnostics.firstMarkerOffset)
            ? diagnostics.firstMarkerOffset
            : -1,
          firstMarkerTokenHash: String(diagnostics.firstMarkerTokenHash || ""),
          contentHash: String(diagnostics.contentHash || diagnostics.observedHash || ""),
        },
        terminal: {
          finishReason: String(diagnostics.finishReason || "unknown"),
          terminalCompleted: diagnostics.terminalCompleted === true,
          terminalEvidence: String(diagnostics.terminalEvidence || "none"),
        },
        providerCallCount: providerAttempts,
      });
    }
    trace?.("direct Local AI failed", {
      operationId,
      batchId,
      imageId,
      jobId,
      requestDispatched: error?.requestDispatched === true,
      providerResponded: error?.providerResponded === true,
      generationStarted: generationAttempts > 0,
      generationAttempts,
      providerAttempts,
      code: String(error?.code || ""),
      status: Number(error?.status || 0),
      ...(error?.diagnostics && typeof error.diagnostics === "object"
        ? error.diagnostics
        : {}),
    });
    if (generationAttempts === 0 && error?.requestDispatched === true)
      await persistProviderGeneration({ pending: true, pendingReason: "local_transport_unconfirmed", operationId,
        runtime: "local", engine: "runsextension", provider: ai?.provider, model: ai?.model });
    if (generationAttempts > 0)
      await persistProviderGeneration(
        {
          runtime: "local",
          provider: charged.provider || ai?.provider || "local",
          model: charged.model || ai?.model || "unknown",
          requestedModel: ai?.model,
          engine: "runsextension",
          requests: generationAttempts,
          failures: generationAttempts,
          generationAttempts,
          reason: "provider_charged_failure",
          operationId,
          traceId,
          startedAt: usageStartedAt,
          usage: charged.usage,
          inputTokens: charged.inputTokens,
          outputTokens: charged.outputTokens,
          totalTokens: charged.totalTokens,
          sourceChars: units.reduce(
            (sum, unit) => sum + String(unit?.text || "").length,
            0,
          ),
          providerMs: Number.isFinite(charged.providerMs)
            ? charged.providerMs
            : error?.diagnostics?.providerMs,
          totalMs: Number.isFinite(charged.totalMs)
            ? charged.totalMs
            : Math.round(performance.now() - started),
        },
        { emitTrace: trace },
      );
    throw error;
  }
  const generationAttempts = Math.max(
    1,
    Number(result?.meta?.generationAttempts || 1),
  );
  const providerAttempts = Math.max(
    generationAttempts,
    Number(result?.meta?.providerAttempts || generationAttempts),
  );
  trace?.("direct Local AI reply", {
    ms: Math.round(performance.now() - started),
    providerMs: Number(result?.meta?.providerMs || 0),
    parseMs: Number(result?.meta?.parseMs || 0),
    adapterTotalMs: Number(result?.meta?.totalMs || 0),
    timeoutMs: Number(result?.meta?.timeoutMs || 0),
    timeoutPolicy:
      Number(result?.meta?.timeoutMs || 0) > 0
        ? "configured-total-timeout"
        : "connect-bounded-read-unbounded",
    requestedOutputTokens: Number(result?.meta?.requestedOutputTokens || 0),
    finishReason: String(result?.meta?.finishReason || ""),
    usage: result?.meta?.usage || null,
    translations: result.translations.length,
    missing: result.missing.length,
    providerAttempts,
    generationAttempts,
    automaticTransportRetry: false,
    modelFallback: false,
    operationId,
    batchId,
    imageId,
    jobId,
    generationStarted: true,
    requestDispatched: true,
    providerResponded: true,
    contractVersion: String(result?.meta?.associationContractVersion || ""),
    ...(result?.meta?.promptAudit || {}),
    missingIds: Array.isArray(result?.missing)
      ? result.missing.map(String)
      : [],
  });
  await persistProviderGeneration(
    {
      runtime: "local",
      provider: result?.meta?.provider || ai?.provider || "local",
      model: result?.meta?.model || ai?.model || "unknown",
      requestedModel: ai?.model,
      engine: "runsextension",
      requests: generationAttempts,
      generationAttempts,
      reason: "translation_success",
      operationId,
      traceId,
      startedAt: usageStartedAt,
      usage: result?.meta?.usage,
      inputTokens: result?.meta?.usage?.inputTokens,
      outputTokens: result?.meta?.usage?.outputTokens,
      totalTokens: result?.meta?.usage?.totalTokens,
      sourceChars: units.reduce(
        (sum, unit) => sum + String(unit?.text || "").length,
        0,
      ),
      translatedUnits: result.translations.length,
      providerMs: result?.meta?.providerMs,
      totalMs: result?.meta?.totalMs,
    },
    { emitTrace: trace },
  );
  return result;
}
