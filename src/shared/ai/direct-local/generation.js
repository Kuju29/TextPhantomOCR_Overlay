import { guardOutputBudget } from "../workload/budget.js";
import { emitPreviewChunks, tracePreviewUnits } from "../../trace-preview.js";
import { diagnosticPreviewsEnabled } from "../../trace.js";
import { completedLineContract } from "../contracts/marker-completion.js";
import { resolveLocalProvider } from "../providers/local-registry.js";
import { LocalAiError } from "./error.js";
import { classifyDirectLocalMissingIds } from "./result-classification.js";
import {
  composeCanonicalPrompt,
  composeTranslationUserMessage,
  composeTranslatorIdentitySystem,
  sessionPromptFingerprint,
  withoutLeadingTargetLanguageHeader,
} from "./prompt.js";
import {
  MARKER_CONTRACT_VERSION,
  decodeTranslations,
} from "./decode.js";
import {
  SCHEMA_OBJECT_CONTRACT,
  exactOutputInstruction,
  selectLocalOutputContract,
  translationObjectSchema,
} from "./output-contract.js";

export { LocalAiError } from "./error.js";
export { localOpenAiBase } from "./endpoint.js";
export { shouldUseDirectLocalAi } from "./route-policy.js";
export { discoverLocalModels } from "./model-discovery.js";
export { buildLocalAiCapabilityHints } from "./capability-hints.js";
export { targetLanguagePriority } from "./prompt.js";
export { assertNoDuplicateJsonKeys } from "./decode.js";
export { completedLineContract } from "../contracts/marker-completion.js";

function dynamicOutputTokens(units, systemText = "") {
  const chars = (units || []).reduce(
    (n, unit) => n + String(unit?.text || "").length,
    0,
  );
  return Math.max(
    1024,
    Math.min(
      8192,
      Math.ceil(chars * 3 + String(systemText).length * 0.1) +
        Math.max(1, units?.length || 0) * 96 +
        512,
    ),
  );
}
export const localAiOutputBudgetForTest = dynamicOutputTokens;

export function encodeLocalSourceBlocks(wireUnits) {
  const records = (wireUnits || []).map((unit) => {
    const id = String(unit?.id || "");
    const source = String(unit?.text ?? "");
    if (!source || /[\r\n\t\u0085\u2028\u2029]/u.test(source) || /<<TP_P\d+/u.test(source)) {
      throw new LocalAiError("Local AI source does not match the compact record contract", {
        code: "local_source_contract_invalid",
        attempted: false,
        retryable: false,
        diagnostics: {
          responseGrammar: MARKER_CONTRACT_VERSION,
          validatorSubtype: !source
            ? "empty_source"
            : /[\r\n\t\u0085\u2028\u2029]/u.test(source)
              ? "non_physical_line_source"
              : "ambiguous_source_marker",
          sourceId: id,
        },
      });
    }
    return `<<TP_${id}:${source}>>`;
  });
  return records
    .join("\n");
}

export function encodeLocalSchemaSource(wireUnits) {
  return (wireUnits || []).map((unit, index) => {
    const id = String(unit?.id || "");
    const source = String(unit?.text ?? "");
    if (id !== `P${index}` || !source || /[\r\n\t\u0085\u2028\u2029]/u.test(source)) {
      throw new LocalAiError("Local AI source does not match the schema source contract", {
        code: "local_source_contract_invalid",
        attempted: false,
        retryable: false,
        diagnostics: {
          responseGrammar: SCHEMA_OBJECT_CONTRACT,
          validatorSubtype: id !== `P${index}`
            ? "non_contiguous_source_id"
            : !source ? "empty_source" : "non_physical_line_source",
          sourceId: id,
        },
      });
    }
    return `${id}:${source}`;
  }).join("\n");
}

function rejectedResponse(response, raw) {
  let detail = "";
  try {
    const data = JSON.parse(raw);
    detail = String(data?.error?.message || data?.message || "").slice(0, 300);
  } catch {}
  const missing =
    response.status === 404 &&
    /\bmodel\b[\s\S]{0,80}\b(?:not found|missing|unknown|does not exist|not installed)\b|\b(?:not found|missing|unknown)\b[\s\S]{0,80}\bmodel\b/i.test(
      detail,
    );
  const error = new LocalAiError(
    `Local AI rejected the request (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    {
      code: missing
        ? "local_model_not_found"
        : response.status === 404
          ? "local_ai_endpoint_incompatible"
          : response.status >= 500
            ? "local_ai_server_error"
            : "local_ai_http_error",
      status: response.status,
      attempted: true,
      retryable: false,
    },
  );
  error.providerResponded = true;
  error.generationAttempts = 0;
  return error;
}

function terminalDiagnostics(stream, providerMs, parseMs, finishReason) {
  return {
    providerMs: Math.round(providerMs),
    parseMs: Math.round(parseMs),
    finishReason,
    terminalCompleted: stream.terminalCompleted === true,
    terminalEvidence: stream.terminalEvidence || "none",
    firstAllIdsMs:
      stream.firstAllIdsMs == null ? null : Math.round(stream.firstAllIdsMs),
    earlyCompletionMs:
      stream.earlyCompletionMs == null
        ? null
        : Math.round(stream.earlyCompletionMs),
    terminalMs:
      stream.terminalMs == null ? null : Math.round(stream.terminalMs),
    dispatchToHeadersMs:
      stream.dispatchToHeadersMs == null ? null : Math.round(stream.dispatchToHeadersMs),
    lastContentMs:
      stream.lastContentMs == null ? null : Math.round(stream.lastContentMs),
    drainStatus: stream.drainStatus || null,
    drainTimeoutMs: stream.drainTimeoutMs ?? null,
    drainElapsedMs:
      stream.drainElapsedMs == null ? null : Math.round(stream.drainElapsedMs),
    completionEvidence: stream.completionEvidence || "none",
    malformedFrameCount: stream.malformedFrameCount || 0,
    malformedFrameSubtypes: stream.malformedFrameSubtypes || [],
  };
}

async function translateSingle(
  units,
  {
    ai,
    canonicalPrompt = null,
    promptAudit = null,
    systemText = "",
    imageDataUri = "",
    sourceLang = "",
    targetLang = "",
    signal = null,
    timeoutMs = 0,
    trace = null,
    wireTrace = null,
    onProgress = null,
  } = {},
) {
  const started = performance.now();
  const diagnosticTrace =
    diagnosticPreviewsEnabled() && typeof trace === "function" ? trace : null;
  if (signal?.aborted)
    throw new LocalAiError("Local AI request was cancelled", {
      code: "cancelled",
    });
  const model = String(ai?.model || "").trim();
  if (!model || model.toLowerCase() === "auto")
    throw new LocalAiError("Select a model exposed by the Local AI runtime", {
      code: "local_model_missing",
    });
  const settings =
    ai?.local_adapter && typeof ai.local_adapter === "object"
      ? ai.local_adapter
      : {};
  const adapter = resolveLocalProvider(
    { ...settings, baseUrl: settings.baseUrl || ai?.base_url },
    ai?.provider,
  );
  const outputContract = selectLocalOutputContract({
    provider: ai?.provider || adapter.id,
    model,
    modelCapabilities: ai?.model_capabilities,
  });
  if (!canonicalPrompt || canonicalPrompt.version !== "translation-plan-2")
    throw new LocalAiError("Local AI requires canonical prompt contract translation-plan-2", {
      code: "canonical_prompt_contract_invalid",
      attempted: false,
      retryable: false,
    });
  const composed = composeCanonicalPrompt(
    canonicalPrompt,
    ai,
    Boolean(imageDataUri),
    outputContract.kind === "schema_object",
    targetLang,
  );
  if (!composed.system)
    throw new LocalAiError("Local AI canonical translation prompt is missing", {
      code: "local_prompt_unavailable",
    });
  const userPrompt = String(ai?.prompt || "").trim();
  const builtInStyle = String(
    canonicalPrompt?.pieces?.editableStyle || "",
  ).trim();
  const savedDefault =
    withoutLeadingTargetLanguageHeader(userPrompt) ===
    withoutLeadingTargetLanguageHeader(builtInStyle);
  const wireUnits = units.map((unit, index) => ({
    id: `P${index}`,
    text: String(unit?.text || ""),
  }));
  const requestOutputContract = exactOutputInstruction(
    wireUnits.map((unit) => unit.id), outputContract, targetLang,
  );
  const effectiveSystemPrompt = composeTranslatorIdentitySystem(composed.sections.style);
  const audit = {
    promptPolicyVersion: String(promptAudit?.promptVersion || ""),
    canonicalPromptVersion: String(
      promptAudit?.canonicalPromptVersion || canonicalPrompt?.version || "",
    ),
    canonicalPromptHash: String(promptAudit?.canonicalPromptHash || ""),
    promptSource: savedDefault ? "saved_default" : "saved_custom_replace",
    promptMode: "replace",
    userPromptPresent: Boolean(userPrompt),
    userPromptChars: userPrompt.length,
    effectiveStyleChars: composed.sections.style.length,
    effectiveStyleFingerprint: await sessionPromptFingerprint(
      composed.sections.style,
    ),
    effectiveSystemPromptChars: effectiveSystemPrompt.length,
    effectiveSystemPromptFingerprint: await sessionPromptFingerprint(
      effectiveSystemPrompt,
    ),
    imageHintApplied: Boolean(imageDataUri),
    memoryMode: String(ai?.memory_mode || "off"),
    seriesStateChars: String(ai?.series_state || "").length,
    characterItems: Array.isArray(ai?.characters) ? ai.characters.length : 0,
    glossaryItems: Array.isArray(ai?.glossary) ? ai.glossary.length : 0,
    previousContextItems: Array.isArray(ai?.prev_context)
      ? ai.prev_context.length
      : 0,
  };
  const sourceRecords = outputContract.kind === "schema_object"
    ? encodeLocalSchemaSource(wireUnits)
    : encodeLocalSourceBlocks(wireUnits);
  const userText = composeTranslationUserMessage({
    sections: {
      ...composed.sections,
      source: outputContract.kind === "schema_object"
        ? "INPUT — tp.translation.schema-object/1\nEach source record is Pn:source text."
        : composed.sections.source,
    },
    requestOutputContract,
    sourceRecords,
    targetLang, repairReason: ai?.repair_reason,
  });
  const userTextFingerprint = await sessionPromptFingerprint(userText);
  diagnosticTrace?.("AI local request contract", {
    requestedContract: SCHEMA_OBJECT_CONTRACT,
    selectedContract: outputContract.version,
    selectedContractKind: outputContract.kind,
    selectedContractReason: outputContract.reason,
    capabilitySource: outputContract.capabilitySource,
    unitCount: units.length,
    targetLang: String(targetLang || ""),
    effectiveSystemPromptFingerprint: audit.effectiveSystemPromptFingerprint,
    styleOrigin: audit.promptSource,
    styleMode: audit.promptMode,
    styleChars: audit.effectiveStyleChars,
    styleFingerprint: audit.effectiveStyleFingerprint,
    instructionChars: audit.effectiveSystemPromptChars,
    instructionFingerprint: audit.effectiveSystemPromptFingerprint,
    userMessageChars: userText.length,
    userMessageFingerprint: userTextFingerprint,
    streamRequested: true,
  });
  await wireTrace?.("contractSelection", {
    requested: SCHEMA_OBJECT_CONTRACT,
    selected: outputContract.version,
    kind: outputContract.kind,
    reason: outputContract.reason,
    capabilitySource: outputContract.capabilitySource,
    provider: String(ai?.provider || adapter.id), model,
    automaticRetry: false,
  });
  const thinkingSelected = ["off", "on"].includes(ai?.thinking)
    ? ai.thinking
    : "default";
  const thinkingMode =
    thinkingSelected === "default" ? adapter.defaultThinking : thinkingSelected;
  const standardOutputTokens = adapter.outputTokens({
    standard: dynamicOutputTokens(units, effectiveSystemPrompt),
    thinkingMode,
  });
  const outputTokens = guardOutputBudget({ standard: standardOutputTokens,
    workload: ai?.workload, limits: ai?.model_capabilities?.limits,
    system: effectiveSystemPrompt, user: userText,
    schema: outputContract.kind === "schema_object" ? translationObjectSchema(wireUnits.map(u => u.id)) : null,
    image: Boolean(imageDataUri) });
  const messages = [
    { role: "system", content: effectiveSystemPrompt },
    {
      role: "user",
      content: adapter.buildUserContent(userText, imageDataUri),
      ...adapter.userImageFields(imageDataUri),
    },
  ];
  await wireTrace?.("systemPrompt", effectiveSystemPrompt);
  await wireTrace?.("userPrompt", messages[1]?.content || "");
  await wireTrace?.("wireUnits", wireUnits);
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", abort, { once: true });
  const configuredTimeoutMs =
    Number(timeoutMs) > 0 ? Math.max(1000, Number(timeoutMs)) : 0;
  let timedOut = false;
  const timer = configuredTimeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Local AI request timed out"));
      }, configuredTimeoutMs)
    : null;
  let exchange;
  try {
    const responseSchema = outputContract.kind === "schema_object"
      ? translationObjectSchema(wireUnits.map((unit) => unit.id)) : null;
    exchange = await adapter.generate(
      { model, messages, outputTokens, thinkingMode, responseSchema },
      {
        expectedIds: wireUnits.map((unit) => unit.id),
        signal: controller.signal,
        trace: diagnosticTrace,
        wireTrace,
        onProgress,
      },
    );
  } catch (cause) {
    if (cause?.code === "AI_WIRE_TRACE_WRITE_FAILED") throw cause;
    if (signal?.aborted) {
      const error = new LocalAiError("Local AI request was cancelled", {
        code: "cancelled",
        attempted: true,
        retryable: false,
      });
      error.name = "AbortError";
      error.requestDispatched = cause?.requestDispatched === true;
      error.providerResponded = cause?.providerResponded === true;
      error.generationAttempts = error.providerResponded ? 1 : 0;
      if (cause?.observedUsage) error.generationMeta = {
        provider: String(ai?.provider || adapter.id), model, usage: cause.observedUsage, generationAttempts: error.generationAttempts,
      };
      throw error;
    }
    const providerResponded = cause?.providerResponded === true;
    const error = new LocalAiError(
      timedOut
        ? "Local AI request timed out"
        : providerResponded
          ? "Local AI response stream ended unexpectedly"
          : "Could not connect to Local AI on this PC",
      {
        code: timedOut ? "local_ai_timeout" : providerResponded ? "provider_protocol_error" : "local_ai_unreachable",
        retryable: false,
        attempted: true,
      },
    );
    error.requestDispatched = cause?.requestDispatched === true;
    error.providerResponded = providerResponded;
    error.status = Number(cause?.status || 0);
    error.generationAttempts = providerResponded ? 1 : 0;
    error.diagnostics = { ...(cause?.diagnostics || {}) };
    if (cause?.observedUsage) error.generationMeta = {
      provider: String(ai?.provider || adapter.id), model, usage: cause.observedUsage, generationAttempts: error.generationAttempts,
    };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
  const { response, stream, providerMs } = exchange;
  if (!response.ok) throw rejectedResponse(response, stream.raw);
  try {
  if (
    !stream.earlyCompleted &&
    (stream.providerStreamErrorCode || stream.malformedFrameCount > 0)
  ) {
    const error = new LocalAiError(
      "Local AI returned a malformed or error stream frame",
      {
        code: "provider_protocol_error",
        attempted: true,
        diagnostics: {
          validatorSubtype: stream.providerStreamErrorCode
            ? "provider_stream_error"
            : "malformed_stream_frame",
          providerErrorCode: stream.providerStreamErrorCode || null,
          malformedFrameCount: stream.malformedFrameCount || 0,
          malformedFrameSubtypes: stream.malformedFrameSubtypes || [],
        },
      },
    );
    error.providerResponded = true;
    error.generationAttempts = 1;
    throw error;
  }
  if (stream.drainStatus === "timeout") {
    const error = new LocalAiError(
      "Local AI completed the translation records but did not send its authoritative terminal response",
      {
        code: "provider_protocol_error",
        attempted: true,
        retryable: false,
        diagnostics: {
          validatorSubtype: "provider_terminal_timeout",
          completionEvidence: stream.completionEvidence || null,
          drainTimeoutMs: stream.drainTimeoutMs ?? null,
        },
      },
    );
    error.providerResponded = true;
    error.generationAttempts = 1;
    throw error;
  }
  if (stream.streaming && stream.terminalCompleted !== true) {
    const error = new LocalAiError(
      "Local AI stream closed without an authoritative terminal response",
      {
        code: "provider_protocol_error",
        attempted: true,
        retryable: false,
        diagnostics: {
          validatorSubtype: "provider_terminal_missing",
          completionEvidence: stream.completionEvidence || null,
        },
      },
    );
    error.providerResponded = true;
    error.generationAttempts = 1;
    throw error;
  }
  let data = stream.data;
  const envelopeStarted = performance.now();
  if (!data)
    try {
      data = JSON.parse(stream.raw);
    } catch {
      const error = new LocalAiError("Local AI returned invalid JSON", {
        code: "invalid_local_response",
        attempted: true,
      });
      error.providerResponded = true;
      error.generationAttempts = 1;
      throw error;
    }
  let parseMs = performance.now() - envelopeStarted;
  const text = adapter.responseText(data),
    finishReason = adapter.finishReason(data),
    usage = adapter.usage(data);
  if (!stream.streaming && text) onProgress?.({ state: "first_response" });
  if (stream.earlyCompleted && usage.source == null) {
    usage.status = "incomplete_due_to_early_completion";
    usage.reason = adapter.incompleteUsageReason?.(stream) || null;
  }
  const timings = adapter.timing(data, usage.outputTokens),
    thinkingApplied = adapter.thinkingApplied(thinkingMode, { model });
  const attach = (error, extra = 0) => {
    error.generationMeta = {
      provider: String(ai?.provider || adapter.id),
      model: String(data?.model || model),
      runtime: "local",
      usage,
      providerMs: Math.round(providerMs),
      parseMs: Math.round(parseMs + extra),
      totalMs: Math.round(performance.now() - started),
      finishReason,
      requestedOutputTokens: outputTokens,
      thinkingSelected,
      thinkingApplied,
      generationAttempts: 1,
    };
    error.diagnostics = {
      ...(error.diagnostics || {}),
      ...terminalDiagnostics(stream, providerMs, parseMs + extra, finishReason),
    };
    return error;
  };
  diagnosticTrace?.("AI diagnostic provider response", {
    requestedContract: SCHEMA_OBJECT_CONTRACT,
    selectedContract: outputContract.version,
    selectedContractKind: outputContract.kind,
    selectedContractReason: outputContract.reason,
    capabilitySource: outputContract.capabilitySource,
    streamMode: stream.streaming ? adapter.streamMode : "non_stream_fallback",
    firstByteMs:
      stream.firstByteMs == null ? null : Math.round(stream.firstByteMs),
    firstContentMs:
      stream.firstContentMs == null ? null : Math.round(stream.firstContentMs),
    streamChunks: stream.chunks,
    requestedOutputTokens: outputTokens,
    generationMs: Math.round(providerMs),
    ...timings,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    finishReason,
    thinkingSelected,
    thinkingApplied,
  });
  const exhausted = /^(?:length|max_tokens)$/i.test(finishReason);
  if (!text) {
    const hadReasoning =
      stream.reasoningObserved === true ||
      Boolean(adapter.responseReasoning(data).trim());
    const error = new LocalAiError(
      `Local AI returned no final answer${hadReasoning ? " (reasoning was produced but is not valid translation output)" : ""}; finish reason: ${finishReason}`,
      {
        code: exhausted
          ? "output_budget_exhausted"
          : hadReasoning
            ? "local_ai_thinking_no_answer"
            : "invalid_model_output",
        attempted: true,
        diagnostics: exhausted
          ? { providerOutputTruncated: true, validatorSubtype: "empty_output" }
          : null,
      },
    );
    error.providerResponded = true;
    error.generationAttempts = 1;
    throw attach(error);
  }
  const translationStarted = performance.now();
  let decoded;
  try {
    decoded = decodeTranslations(text, units, {
      structured: composed.structured,
      wireUnits,
      compactMarkers: outputContract.kind === "compact_records",
      allowCompleteMarkersWithoutEnd:
        !exhausted && stream.terminalCompleted === true,
    });
  } catch (error) {
    if (exhausted) {
      error.code = "output_budget_exhausted";
      error.message = `Local AI exhausted its output budget before completing the translation; finish reason: ${finishReason}`;
      error.diagnostics = {
        ...(error.diagnostics || {}),
        providerOutputTruncated: true,
      };
    }
    error.providerAttempts = 1;
    error.generationAttempts = 1;
    error.requestDispatched = true;
    error.providerResponded = true;
    throw attach(error, performance.now() - translationStarted);
  }
  parseMs += performance.now() - translationStarted;
  const missing = [
    ...new Set([
      ...(Array.isArray(decoded.missing) ? decoded.missing : []),
      ...decoded.translations
        .filter((item) => !String(item?.text ?? "").trim())
        .map((item) => item.id),
    ].map(String)),
  ];
  const contractDiagnostics = decoded.diagnostics
    ? {
        validatorSubtype: decoded.diagnostics.validatorSubtype || "unknown",
        receivedIds: decoded.diagnostics.receivedIds || [],
        missingIds: decoded.diagnostics.missingIds || [],
        emptyIds: decoded.diagnostics.emptyIds || [],
        duplicateIds: decoded.diagnostics.duplicateIds || [],
        ignoredUnknownIds: decoded.diagnostics.ignoredUnknownIds || [],
        ignoredProse: decoded.diagnostics.ignoredProse === true,
        ignoredProseChars: Number(decoded.diagnostics.ignoredProseChars || 0),
        malformedMarkerIds: decoded.diagnostics.malformedMarkerIds || [],
        malformedLineCount: Number(decoded.diagnostics.malformedLineCount || 0),
      }
    : null;
  const { omittedIds, declinedIds } = classifyDirectLocalMissingIds(
    contractDiagnostics, wireUnits, units,
  );
  await wireTrace?.("parsedRecords", decoded.translations);
  await wireTrace?.("providerValidation", { missingIds: missing, ...(contractDiagnostics || {}) });
  await wireTrace?.("contractApplied", {
    requested: SCHEMA_OBJECT_CONTRACT,
    selected: outputContract.version,
    applied: decoded.responseShape,
    reason: outputContract.reason,
    providerAttempts: 1,
    automaticRetry: false,
  });
  await wireTrace?.("timing", { providerMs: Math.round(providerMs), parseMs: Math.round(parseMs),
    dispatchToHeadersMs: stream.dispatchToHeadersMs == null ? null : Math.round(stream.dispatchToHeadersMs),
    firstByteMs: stream.firstByteMs == null ? null : Math.round(stream.firstByteMs),
    firstContentMs: stream.firstContentMs == null ? null : Math.round(stream.firstContentMs),
    lastContentMs: stream.lastContentMs == null ? null : Math.round(stream.lastContentMs),
    terminalMs: stream.terminalMs == null ? null : Math.round(stream.terminalMs) });
  if (diagnosticTrace)
    emitPreviewChunks(
      diagnosticTrace,
      "AI diagnostic decoded response units",
      await tracePreviewUnits(decoded.translations),
      { missingIds: missing,
        extraIds: contractDiagnostics?.ignoredUnknownIds || [],
        duplicateIds: contractDiagnostics?.duplicateIds || [],
        ignoredProseChars: contractDiagnostics?.ignoredProseChars || 0 },
    );
  onProgress?.({ state: "completed" });
  return {
    schema: "tp.ai.result/1",
    translations: decoded.translations,
    missing,
    meta: {
      route: "direct-local",
      responseShape: decoded.responseShape,
      acceptedLosslessly: decoded.acceptedLosslessly === true,
      omittedIds,
      declinedIds,
      contentModified: decoded.contentModified === true,
      associationContractVersion: outputContract.version,
      providerAttempts: 1,
      generationAttempts: 1,
      httpAttempts: 1,
      automaticContentRetry: false,
      automaticTransportRetry: false,
      modelFallback: false,
      schemaFallback: false,
      requestDispatched: true,
      providerResponded: true,
      providerMs: Math.round(providerMs),
      parseMs: Math.round(parseMs),
      modelLimits: ai?.model_capabilities?.limits || {},
      requestedContract: SCHEMA_OBJECT_CONTRACT,
      selectedContract: outputContract.version,
      selectedContractKind: outputContract.kind,
      selectedContractReason: outputContract.reason,
      capabilitySource: outputContract.capabilitySource,
      streamMode: stream.streaming ? adapter.streamMode : "non_stream_fallback",
      firstByteMs:
        stream.firstByteMs == null ? null : Math.round(stream.firstByteMs),
      firstContentMs:
        stream.firstContentMs == null
          ? null
          : Math.round(stream.firstContentMs),
      streamChunks: stream.chunks,
      malformedFrameCount: stream.malformedFrameCount || 0,
      malformedFrameSubtypes: stream.malformedFrameSubtypes || [],
      generationMs: Math.round(providerMs),
      ...timings,
      finishReason,
      requestedOutputTokens: outputTokens,
      thinkingSelected,
      thinkingApplied,
      acceptedWithoutEndMarker:
        decoded.diagnostics?.validatorSubtype === "accepted_without_end_marker",
      ...terminalDiagnostics(stream, providerMs, parseMs, finishReason),
      usage,
      provider: String(ai?.provider || adapter.id),
      model: String(data?.model || model),
      runtime: "local",
      totalMs: Math.round(performance.now() - started),
      timeoutMs: configuredTimeoutMs,
      promptAudit: audit,
      contractDiagnostics,
    },
  };
  } catch (error) {
    // Decode/protocol failure does not erase tokens already reported by the
    // runtime. This snapshot is deliberately incomplete without a terminal.
    if (!error.generationMeta?.usage) {
      let envelope = stream.data;
      if (!envelope) try { envelope = JSON.parse(stream.raw); } catch {}
      const observed = adapter.usage(envelope || {});
      if (!stream.terminalCompleted) observed.usageStatus = "incomplete";
      error.generationMeta = { ...(error.generationMeta || {}),
        provider: String(ai?.provider || adapter.id), model: String(envelope?.model || model),
        usage: observed, providerMs, generationAttempts: 1 };
      error.generationAttempts = 1;
    }
    throw error;
  }
}

export async function translateWithLocalOpenAi(units, options = {}) {
  const result = await translateSingle(units, options);
  result.meta = {
    ...(result.meta || {}),
    sourceUnitCount: units.length,
    batchCount: 1,
    batchRanges: units.length ? [`0-${units.length - 1}`] : [],
  };
  return result;
}
