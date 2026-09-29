import { uncertainRepairIds } from "../repair-alignment.js";
import { promptLayout } from "../prompt-layout.js";
import { planOllamaContext } from "../providers/ollama-context.js";
import { LOCAL_CONTEXT_METADATA_MAX } from "../providers/local-openai-compatible.js";
import { guardOutputBudget, estimateProviderInput } from "../workload/budget.js";
import { emitPreviewChunks, tracePreviewUnits } from "../../trace-preview.js";
import { diagnosticPreviewsEnabled } from "../../trace.js";
import { completedLineContract } from "../contracts/marker-completion.js";
import { resolveLocalProvider } from "../providers/local-registry.js";
import { LocalAiError } from "./error.js";
import { classifyDirectLocalMissingIds } from "./result-classification.js";
import {
  composeCanonicalPrompt,
  composeTranslationUserMessage,
  sessionPromptFingerprint,
  withoutLeadingTargetLanguageHeader,
} from "./prompt.js";
import {
  MARKER_CONTRACT_VERSION,
  decodeTranslations,
} from "./decode.js";
import {
  SCHEMA_OBJECT_CONTRACT,
  COMPACT_RECORDS_CONTRACT,
  exactOutputInstruction,
  selectLocalOutputContract,
  translationObjectSchema,
} from "./output-contract.js";
import { normalizeReasoningPreference, resolveReasoningPreference } from "../../reasoning-preference.js";

export { LocalAiError } from "./error.js";
export { localOpenAiBase } from "./endpoint.js";
export { shouldUseDirectLocalAi } from "./route-policy.js";
export { discoverLocalModels } from "./model-discovery.js";
export { buildLocalAiCapabilityHints } from "./capability-hints.js";
export { targetLanguagePriority } from "./prompt.js";
export { assertNoDuplicateJsonKeys } from "./decode.js";
export { completedLineContract } from "../contracts/marker-completion.js";

function dynamicOutputTokens(units, _systemText = "", workload = null) {
  const list = Array.isArray(units) ? units : [];
  const chars = list.reduce(
    (n, unit) => n + String(unit?.text || "").length,
    0,
  );
  const count = Math.max(1, list.length);
  const predicted = Number(workload?.predictedOutput);
  // Output allowance must follow the requested translation, not the size of
  // the system/style prompt. Counting prompt characters here previously gave
  // a four-record Local request 2k+ completion tokens, which invited small
  // models to ramble or spend the entire allowance on hidden reasoning.
  const sourceAllowance = Math.ceil(chars * 1.75 + count * 36 + 96);
  const learnedAllowance = Number.isFinite(predicted) && predicted > 0
    ? Math.ceil(predicted * 1.75 + 96)
    : 0;
  return Math.max(384, Math.min(8192, Math.max(sourceAllowance, learnedAllowance)));
}
export const localAiOutputBudgetForTest = dynamicOutputTokens;

export function encodeLocalSourceBlocks(wireUnits) {
  const records = (wireUnits || []).map((unit) => {
    const id = String(unit?.id || "");
    const source = String(unit?.text ?? "");
    if (!source || /[\r\n\t\u0085\u2028\u2029]/u.test(source) || /<<(?:TP_P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6})/u.test(source)) {
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
    return id.startsWith("I") ? `<<${id}:${source}>>` : `<<TP_${id}:${source}>>`;
  });
  return records
    .join("\n");
}

export function encodeLocalSchemaSource(wireUnits) {
  return (wireUnits || []).map((unit, index) => {
    const id = String(unit?.id || "");
    const source = String(unit?.text ?? "");
    const validId = id === `P${index}` || /^I[1-9][0-9]{0,6}_P[0-9]{1,6}$/.test(id);
    if (!validId || !source || /[\r\n\t\u0085\u2028\u2029]/u.test(source)) {
      throw new LocalAiError("Local AI source does not match the schema source contract", {
        code: "local_source_contract_invalid",
        attempted: false,
        retryable: false,
        diagnostics: {
          responseGrammar: SCHEMA_OBJECT_CONTRACT,
          validatorSubtype: !validId
            ? "invalid_source_id"
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
    requestSetupMs: Number.isFinite(stream.requestSetupMs) ? Math.round(stream.requestSetupMs) : null,
    headersToFirstByteMs: stream.headersToFirstByteMs == null ? null : Math.round(stream.headersToFirstByteMs),
    headersToFirstContentMs: stream.headersToFirstContentMs == null ? null : Math.round(stream.headersToFirstContentMs),
    contentToTerminalMs: stream.contentToTerminalMs == null ? null : Math.round(stream.contentToTerminalMs),
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
    conversationContext = null,
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
    operationId = "",
    onProgress = null,
    beforeDispatch = null,
    onDispatched = null,
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
  const conversationRecords = Boolean(conversationContext) && units.length > 0 && units.every(unit=>/^I[1-9][0-9]{0,6}_P[0-9]{1,6}$/.test(String(unit?.id||"")));
  const conversationMarkers=conversationRecords || Boolean(conversationContext) && adapter.id==="lmstudio_native";
  const capabilityContract = selectLocalOutputContract({
    provider: ai?.provider || adapter.id,
    model,
    modelCapabilities: ai?.model_capabilities,
  });
  const nativeMarkerContract = adapter.id === "lmstudio_native";
  // Keep Conversation on one marker protocol. Per-turn exact-key JSON schemas
  // change provider-visible request metadata and can destroy prefix-cache reuse.
  // LM Studio's native chat endpoint does not accept responseSchema in either
  // mode. A stale model capability must not select a wire field this endpoint
  // rejects; report the claimed and selected contracts separately in traces.
  const outputContract = conversationMarkers || nativeMarkerContract ? {
    kind:"compact_records", version:COMPACT_RECORDS_CONTRACT,
    reason:conversationRecords?"conversation_image_records_cache_stable":
      conversationMarkers?"conversation_native_marker_contract":"lmstudio_native_marker_contract",
    capabilitySource:capabilityContract.capabilitySource,
  } : capabilityContract;
  const formatDiagnostics = {
    plannedOutputContract: capabilityContract.version,
    selectedOutputContract: outputContract.version,
    selectionReason: outputContract.reason,
    parserId: outputContract.kind,
    decodedResponseShape: null,
    formatSwitch: false,
  };
  if (!conversationContext && ai?.translation_mode === 'independent' &&
      ai?.style_examples !== false && !ai?.independent_examples)
    throw new LocalAiError('Independent example selection is missing', {
      code:'independent_example_selection_missing',attempted:false,retryable:false});
  const independentExamples = conversationContext || ai?.translation_mode === 'conversation'
    ? null : ai?.independent_examples || {source:ai?.style_examples === false?'none':'human',
        pairs:[],scopeStatus:'legacy_unscoped'};
  const effectiveStyleExamples = ai?.style_examples !== false &&
    (Boolean(conversationContext) || independentExamples?.source !== 'none');
  const promptAi = effectiveStyleExamples === (ai?.style_examples !== false) ? ai : {...ai, style_examples:effectiveStyleExamples};
  const wireUnits = units.map((unit, index) => ({
    id: conversationRecords ? String(unit?.id||"") : `P${index}`,
    text: String(unit?.text || ""),
  }));
  const composed = composeCanonicalPrompt(
    canonicalPrompt,
    promptAi,
    Boolean(imageDataUri),
    outputContract.kind === "schema_object",
    targetLang,
    units,
    wireUnits.map(unit => unit.id),
  );
  if (!composed.system)
    throw new LocalAiError("Local AI canonical translation prompt is missing", {
      code: "local_prompt_unavailable",
    });
  const userPrompt = String(ai?.prompt || "").trim();
  const builtInStyle = String(
    canonicalPrompt?.pieces?.editableStyle || "",
  ).trim();
  const userPromptPresent = Boolean(userPrompt);
  const savedDefault = userPromptPresent && composed.sections.savedDefault;
  const requestOutputContract = exactOutputInstruction(
    wireUnits.map((unit) => unit.id), outputContract, targetLang,
  );
  const selectedStyle = `${composed.sections.language}\n${composed.sections.style}`;
  const effectiveSystemPrompt = composed.system;
  const audit = {
    promptPolicyVersion: String(promptAudit?.promptVersion || ""),
    canonicalPromptVersion: String(
      promptAudit?.canonicalPromptVersion || canonicalPrompt?.version || "",
    ),
    canonicalPromptHash: String(promptAudit?.canonicalPromptHash || ""),
    promptSource: !userPromptPresent
      ? "built_in_default"
      : savedDefault ? "saved_default" : "saved_custom_replace",
    promptMode: "replace",
    userPromptPresent,
    userPromptChars: userPrompt.length,
    effectiveStyleChars: Array.from(selectedStyle).length,
    effectiveStyleFingerprint: await sessionPromptFingerprint(selectedStyle),
    effectiveSystemPromptChars: Array.from(effectiveSystemPrompt).length,
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
    targetLang, sourceLang, repairReason: ai?.repair_reason,
    expectedIds: wireUnits.map(unit => unit.id),
    structuredOutput: outputContract.kind === "schema_object",
    conversationRecords,
    independentExamples,
  });
  audit.promptLayout = await promptLayout(effectiveSystemPrompt, userText, {targetLang,sourceLang,
    structured:outputContract.kind === "schema_object",examples:effectiveStyleExamples,
    memoryMode:ai?.memory_mode,selectedStyle,conversationRecords,independentExamples});
  for (const key of ["styleRole", "systemStyleCopies", "userStyleCopies", "userStaticChars"])
    audit[key] = audit.promptLayout[key];
  const reasoning = ai?.model_capabilities?.reasoning;
  const thinkingRequested = normalizeReasoningPreference(ai?.thinking, "minimum");
  let thinkingSelected = resolveReasoningPreference(thinkingRequested, reasoning);
  // Missing Ollama thinking.values is not proof that the model cannot switch
  // thinking off. Lowest may request the native boolean Off and then verify
  // the response; an advertised mandatory mode is handled by the resolver.
  if (adapter.id === "ollama" && thinkingRequested === "minimum" &&
      thinkingSelected === "default" && typeof reasoning?.supported !== "boolean")
    thinkingSelected = "off";
  const minimumAtProviderDefault = thinkingRequested === "minimum" && thinkingSelected === "default";
  const verifiedNonReasoning = reasoning?.supported === false &&
    Array.isArray(reasoning.supported_efforts) && reasoning.supported_efforts.length === 0 &&
    (adapter.id === "lmstudio_native" && reasoning.source === "lmstudio_native_loaded_instance" ||
      adapter.id === "ollama" && reasoning.source === "ollama-api-show");
  const thinkingAudit = {
    thinkingRequested,
    thinkingSelected,
    ...(minimumAtProviderDefault ? {thinkingApplied: verifiedNonReasoning
      ? "not_applicable_non_reasoning_model" : "provider_managed_unverified"} : {}),
  };
  if (!["minimum", "default", "off"].includes(thinkingRequested) &&
      thinkingSelected !== thinkingRequested)
    throw new LocalAiError("Local AI cannot verify the selected Thinking mode for this model", {
      code: "local_model_thinking_unsupported", attempted: false, retryable: false,
      diagnostics: { thinkingRequested, thinkingSelected },
    });
  // Resolve provider-neutral user intent once against exact model capability.
  // Local provider leaves only map the concrete result to their native wire.
  const thinkingMode = typeof adapter.resolveThinkingMode === "function"
    ? adapter.resolveThinkingMode(thinkingSelected, { model, reasoning })
    : thinkingSelected;
  // Some runtimes do not expose a per-model Thinking switch. Lowest then uses
  // the runtime default, with an explicit unverified audit; Off stays strict.
  if (adapter.id==="lmstudio_native" && thinkingRequested==="off" && thinkingMode!=="off")
    throw new LocalAiError("LM Studio cannot honor the selected Thinking off setting",{
      code:"local_model_thinking_unsupported",attempted:false,retryable:false});
  const standardOutputTokens = adapter.outputTokens({
    standard: dynamicOutputTokens(units, effectiveSystemPrompt, ai?.workload),
    thinkingMode,
  });
  const sourceTexts = wireUnits.map(unit => String(unit.text));
  const userMaxOutput = ai?.max_output_tokens;
  const localReasoningRisk = thinkingMode !== "off" && !verifiedNonReasoning;
  const budgetOptions = { sourceTexts, userMaxOutput, localReasoningRisk };
  const responseSchema = outputContract.kind === "schema_object"
    ? translationObjectSchema(wireUnits.map(u => u.id)) : null;
  let conversationOutputReserve = standardOutputTokens;
  if (conversationContext) {
    const baseBudgetInput = { history: [], system: effectiveSystemPrompt, user: userText,
      schema: responseSchema, image: Boolean(imageDataUri) };
    // Conversation trimming reserves against the proven model maximum, never
    // an old loaded allocation. Ollama can request a larger native num_ctx
    // for the real generation; an unknown model maximum stays unknown.
    const discovered = ai?.model_capabilities?.limits;
    const nativeOllama = adapter.id === "ollama" && discovered?.scope === "runtime" &&
      String(discovered.source || "").startsWith("ollama-api");
    const reserveLimits = nativeOllama ? { ...discovered,
      contextTokens: discovered.modelContextTokens || undefined } : discovered;
    const reserveWorkload = ai?.workload || (nativeOllama
      ? { version: 1, predictedOutput: standardOutputTokens } : null);
    try {
      conversationOutputReserve = guardOutputBudget({ standard: standardOutputTokens,
        workload: reserveWorkload, limits: reserveLimits, ...baseBudgetInput, ...budgetOptions });
    } catch (error) {
      throw error;
    }
  }
  const conversation = conversationContext ? await conversationContext.prepare({
    layout:audit.promptLayout,system:effectiveSystemPrompt,user:userText,
    schema:responseSchema,
    imageDataUri,executedModel:model,protocol:adapter.id,selectedContract:outputContract.version,
    outputReserve:conversationOutputReserve}) : null;
  if (conversation?.layout) audit.promptLayout=conversation.layout;
  for (const key of ["styleRole", "systemStyleCopies", "userStyleCopies", "userStaticChars"])
    audit[key] = audit.promptLayout[key];
  diagnosticTrace?.("AI prompt layout", audit.promptLayout);
  const effectiveUserText=conversation?.current ?? userText;
  const userTextFingerprint = await sessionPromptFingerprint(effectiveUserText);
  diagnosticTrace?.("AI local request contract", {
    styleRole: audit.styleRole,
    systemStyleCopies: audit.systemStyleCopies,
    userStyleCopies: audit.userStyleCopies,
    policyVersion: audit.promptLayout.policyVersion,
    requestedContract: capabilityContract.version,
    selectedContract: outputContract.version,
    ...formatDiagnostics,
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
    userMessageChars: effectiveUserText.length,
    userMessageFingerprint: userTextFingerprint,
    historyMessages: conversation?.history?.length || 0,
    streamRequested: true,
    ...thinkingAudit,
  });
  const budgetInput = {history:conversation?.history || [],system: effectiveSystemPrompt, user: conversation?.current ?? userText,
    schema: responseSchema, image: Boolean(imageDataUri)};
  const jitLimits = ai?.model_capabilities?.limits;
  const jitRequestedContext = adapter.id === "lmstudio_native" &&
    jitLimits?.source === "lmstudio_native_jit_request" && jitLimits?.scope === "request"
    ? jitLimits.contextTokens : null;
  if (jitRequestedContext !== null && (!Number.isSafeInteger(jitRequestedContext) ||
      jitRequestedContext <= 0 || jitRequestedContext > LOCAL_CONTEXT_METADATA_MAX ||
      !Number.isSafeInteger(jitLimits.modelContextTokens) ||
      jitRequestedContext !== jitLimits.modelContextTokens))
    throw new LocalAiError("LM Studio JIT context metadata is invalid", {
      code: "local_model_context_unverified", attempted: false, retryable: false,
    });
  const budgetHint = ai?.workload || (adapter.id === "ollama" || jitRequestedContext !== null
    ? {version:1, predictedOutput:standardOutputTokens} : null);
  const ollamaLimits = ai?.model_capabilities?.limits;
  const ollamaPlanningLimits = adapter.id === "ollama" && ollamaLimits?.scope === "runtime" &&
    String(ollamaLimits.source || "").startsWith("ollama-api")
    ? { ...ollamaLimits, contextTokens:ollamaLimits.modelContextTokens || undefined }
    : ollamaLimits;
  const plannedOllamaOutput = adapter.id === "ollama" ? guardOutputBudget({
    standard:standardOutputTokens, workload:budgetHint, limits:ollamaPlanningLimits,
    ...budgetInput, ...budgetOptions,
    ...(conversation ? {requestOutputReserve:conversationOutputReserve} : {}),
  }) : null;
  const plannedOutput = jitRequestedContext !== null ? guardOutputBudget({
    standard:standardOutputTokens, workload:budgetHint, limits:jitLimits,
    ...budgetInput, ...budgetOptions,
    ...(conversation ? {requestOutputReserve:conversationOutputReserve} : {}),
  }) : null;
  const neededJitContext = jitRequestedContext !== null ? Math.ceil(
    estimateProviderInput(budgetInput) + plannedOutput + 128 + Math.max(256, plannedOutput * .5)) : null;
  const chosenJitContext = neededJitContext !== null ? Math.min(jitRequestedContext,
    Math.max(4096, Math.ceil(neededJitContext / 4096) * 4096)) : null;
  const contextPlan = adapter.id === "ollama" ? planOllamaContext(ai?.model_capabilities?.limits, {
    estimatedInput: estimateProviderInput(budgetInput),
    predictedOutput: plannedOllamaOutput,
    reasoningReserve: Math.min(8192, ai?.workload?.reasoningReserve || 0),
  }) : jitRequestedContext !== null ? {
    limits: { ...jitLimits, contextTokens:chosenJitContext },
    evidence: { requestedContext: chosenJitContext, contextRequired:neededJitContext,
      modelContext: jitLimits.modelContextTokens,
      contextPolicy: "lmstudio-jit-request-v2", contextVerified: false },
  } : null;
  await wireTrace?.("contractSelection", {
    requested: capabilityContract.version,
    selected: outputContract.version,
    ...formatDiagnostics,
    kind: outputContract.kind,
    reason: outputContract.reason,
    capabilitySource: outputContract.capabilitySource,
    provider: String(ai?.provider || adapter.id), model,
    automaticRetry: false,
    ...thinkingAudit,
    promptLayout: audit.promptLayout,
    ...(independentExamples ? {independentExamples:audit.promptLayout.independentExamples} : {}),
    ...(conversation ? {conversation:conversation.evidence, historyOrigins:conversation.origins} : {}),
    ...(contextPlan ? {contextPlan: contextPlan.evidence} : {}),
  });
  // The final guard checks the actual composed message and the exact window
  // being requested, not the smaller allocation from the earlier health probe.
  let outputTokens;
  try {
    outputTokens = guardOutputBudget({ standard: standardOutputTokens, workload: budgetHint,
      limits: contextPlan?.limits || ai?.model_capabilities?.limits, ...budgetInput,
      ...budgetOptions,
      ...(conversation ? {requestOutputReserve:conversationOutputReserve} : {}),
    });
  } catch (error) {
    error.diagnostics = {...error.diagnostics, ...(contextPlan?.evidence || {})};
    throw error;
  }
  if (contextPlan) {
    const evidence = {schema:"tp.audit/1", event:"local_context", route:"direct-local", reason:"prepared",
      planned:{estimatedInput:estimateProviderInput(budgetInput), estimatedOutput:budgetHint.predictedOutput,
        contextLimit:contextPlan.limits.contextTokens, ...contextPlan.evidence}, requestDispatched:false};
    diagnosticTrace?.("localContext", evidence);

  }
  const messages = conversation ? conversationContext.messages(conversation,effectiveSystemPrompt,adapter) : [
    { role: "system", content: effectiveSystemPrompt },
    {
      role: "user",
      content: adapter.buildUserContent(userText, imageDataUri),
      ...adapter.userImageFields(imageDataUri),
    },
  ];
  // A native LM Studio continuation uses the retained response ID, so no
  // system prompt is present in its actual provider request or wire audit.
  if (!conversation?.providerConversation?.previousResponseId)
    await wireTrace?.("systemPrompt", effectiveSystemPrompt);
  await wireTrace?.("userPrompt", messages.at(-1)?.content || "");
  await wireTrace?.("wireUnits", wireUnits);
  const controller = new AbortController(),
    abort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", abort, { once: true });
  // Preparation can await wire traces: honour cancellation that happened
  // between the initial guard and installing this listener.
  if (signal?.aborted) abort();
  const configuredTimeoutMs =
    Number(timeoutMs) > 0 ? Math.max(1000, Number(timeoutMs))
      : Number(adapter.defaultTimeoutMs) > 0 ? Number(adapter.defaultTimeoutMs) : 0;
  let timedOut = false;
  const timer = configuredTimeoutMs
    ? setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Local AI request timed out"));
      }, configuredTimeoutMs)
    : null;
  let exchange;
  const attachFailureThinking = error => {
    const existing = error.generationMeta || {};
    error.generationMeta = {
      ...existing,
      provider: existing.provider || String(ai?.provider || adapter.id),
      model: existing.model || model,
      runtime: existing.runtime || "local",
      ...thinkingAudit,
    };
    return error;
  };
  try {
    exchange = await adapter.generate(
      { model, messages, outputTokens, thinkingMode, thinkingCapability: reasoning, responseSchema,
        ...(conversation?.providerConversation?{providerConversation:conversation.providerConversation}:{}),
        ...(contextPlan ? {contextTokens:contextPlan.evidence.requestedContext} : {}) },
      {
        expectedIds: wireUnits.map((unit) => unit.id),
        emitTranslationDeltas: conversationRecords,
        cacheContext: conversation ? {...audit.promptLayout, staticPrefixSha256:conversation.evidence.prefixSha256} : audit.promptLayout,
        cacheOperationId: operationId,
        cacheRevision: ai?.model_capabilities?.limits?.modelRevision || "",
        signal: controller.signal,
        trace: diagnosticTrace,
        wireTrace,
        onProgress,
        beforeDispatch,
        onDispatched,
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
      error.diagnostics = { ...formatDiagnostics, ...(cause?.diagnostics || {}) };
      error.requestDispatched = cause?.requestDispatched === true;
      error.providerResponded = cause?.providerResponded === true;
      error.generationAttempts = error.providerResponded ? 1 : 0;
      if (cause?.observedUsage) error.generationMeta = {
        provider: String(ai?.provider || adapter.id), model, usage: cause.observedUsage, generationAttempts: error.generationAttempts,
      cacheCoordination: cause.cacheCoordination,
      };
      throw attachFailureThinking(error);
    }
    if (cause?.requestDispatched === false &&
        ["local_model_thinking_unsupported","local_provider_response_contract"].includes(cause?.code)) {
      cause.diagnostics={...formatDiagnostics,...(cause.diagnostics||{})};
      cause.generationAttempts=0;
      cause.providerAttempts=0;
      throw attachFailureThinking(cause);
    }
    if (cause?.code === "invalid_local_request_rate" && cause?.requestDispatched === false) {
      const error = new LocalAiError(cause.message, {
        code: cause.code,
        attempted: false,
        diagnostics: { ...formatDiagnostics, ...(cause.diagnostics || {}) },
      });
      if (cause.cacheCoordination) error.cacheCoordination = cause.cacheCoordination;
      throw attachFailureThinking(error);
    }
    if (cause?.code === "local_model_identity_mismatch") {
      // Keep LM Studio's exact reported/requested identity visible to the
      // caller; reclassifying it as a transport failure hides the root cause.
      cause.diagnostics = { ...formatDiagnostics, ...(cause.diagnostics || {}) };
      throw attachFailureThinking(cause);
    }
    if (adapter.id === "ollama" && cause?.code === "local_model_thinking_unsupported" &&
        cause?.requestDispatched === true && cause?.providerResponded === true) {
      cause.diagnostics = { ...formatDiagnostics, ...(cause.diagnostics || {}) };
      throw attachFailureThinking(cause);
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
    error.diagnostics = { ...formatDiagnostics, ...(cause?.diagnostics || {}) };
    if (cause?.cacheCoordination) error.cacheCoordination = cause.cacheCoordination;
    if (cause?.observedUsage) error.generationMeta = {
      provider: String(ai?.provider || adapter.id), model, usage: cause.observedUsage, generationAttempts: error.generationAttempts,
      cacheCoordination: cause.cacheCoordination,
    };
    throw attachFailureThinking(error);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
  const { response, stream, providerMs, cacheCoordination, thinkingApplied: transportThinkingApplied } = exchange;
  if (!response.ok) {
    const error = rejectedResponse(response, stream.raw);
    error.diagnostics = { ...formatDiagnostics, ...(error.diagnostics || {}) };
    error.cacheCoordination = cacheCoordination;
    throw attachFailureThinking(error);
  }
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
    finishReason = adapter.finishReason(data,outputTokens),
    usage = adapter.usage(data);
  if (!stream.streaming && text) onProgress?.({ state: "first_response" });
  if (stream.earlyCompleted && usage.source == null) {
    usage.status = "incomplete_due_to_early_completion";
    usage.reason = adapter.incompleteUsageReason?.(stream) || null;
  }
  const providerReasoningObserved =
    data?.reasoningDeltaObserved === true || stream.reasoningObserved === true ||
    (Number.isSafeInteger(data?.stats?.reasoning_output_tokens) && data.stats.reasoning_output_tokens > 0) ||
    (Number.isSafeInteger(usage.thinkingTokens) && usage.thinkingTokens > 0) ||
    Boolean(String(adapter.responseReasoning?.(data) || "").trim());
  const timings = adapter.timing(data, usage.outputTokens),
    thinkingApplied = minimumAtProviderDefault
      ? verifiedNonReasoning && !providerReasoningObserved
        ? "not_applicable_non_reasoning_model" : "provider_managed_unverified"
      : String(transportThinkingApplied || (thinkingMode === "default"
        ? "provider_default" : "unverified"));
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
  // Off is a user constraint on every Local adapter. A provider may accept a
  // disable field yet still report reasoning in a stream, final body or usage.
  // Reject that answer without retaining its conversation turn.
  if ((thinkingRequested === "off" || adapter.id === "ollama" && thinkingMode === "off") &&
      providerReasoningObserved) {
    const error = new LocalAiError("Local AI produced reasoning despite Thinking off", {
      code: "local_model_thinking_unsupported", attempted: true, retryable: false,
      diagnostics: { validatorSubtype: "reasoning_reported_with_thinking_off" },
    });
    error.providerResponded = true;
    throw attach(error);
  }
  diagnosticTrace?.("AI diagnostic provider response", {
    requestedContract: capabilityContract.version,
    selectedContract: outputContract.version,
    ...formatDiagnostics,
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
          ? { providerOutputTruncated: true,
            validatorSubtype: hadReasoning ? "reasoning_only_exhausted" : "empty_output" }
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
  const uncertainWireIds = ai?.conversation?.branch === "repair"
    ? uncertainRepairIds(wireUnits.map(u => u.id), decoded.diagnostics?.ignoredUnknownIds || []) : [];
  const uncertainSet = new Set(uncertainWireIds);
  const alignmentUncertainIds = wireUnits.flatMap((wire, i) => uncertainSet.has(wire.id) ? [units[i].id] : []);
  if (alignmentUncertainIds.length) {
    const rejected = new Set(alignmentUncertainIds);
    decoded.translations = decoded.translations.map(row => rejected.has(row.id) ? {...row, text:""} : row);
    decoded.missing = [...new Set([...(decoded.missing || []), ...alignmentUncertainIds])];
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
        formattingWhitespaceChars: Number(decoded.diagnostics.formattingWhitespaceChars || 0),
        redundantClosingDelimiterChars: Number(decoded.diagnostics.redundantClosingDelimiterChars || 0),
        unexpectedProseChars: Number(decoded.diagnostics.unexpectedProseChars ?? (decoded.diagnostics.ignoredProse ? 1 : 0)),
        malformedMarkerIds: decoded.diagnostics.malformedMarkerIds || [],
        recoverableMalformedMarkerIds: decoded.diagnostics.recoverableMalformedMarkerIds || [],
        malformedMarkersRecoverable: decoded.diagnostics.malformedMarkersRecoverable === true,
        malformedLineCount: Number(decoded.diagnostics.malformedLineCount || 0),
      }
    : null;
  let { omittedIds, declinedIds } = classifyDirectLocalMissingIds(
    contractDiagnostics, wireUnits, units,
  );
  omittedIds = [...new Set([...omittedIds, ...alignmentUncertainIds])];
  declinedIds = declinedIds.filter(id => !alignmentUncertainIds.includes(id));
  await wireTrace?.("parsedRecords", decoded.translations);
  await wireTrace?.("providerValidation", { missingIds: missing, ...(contractDiagnostics || {}) });
  await wireTrace?.("contractApplied", {
    requested: capabilityContract.version,
    selected: outputContract.version,
    ...formatDiagnostics,
    applied: decoded.responseShape,
    decodedResponseShape: decoded.responseShape,
    reason: outputContract.reason,
    providerAttempts: 1,
    automaticRetry: false,
  });
  await wireTrace?.("timing", { providerMs: Math.round(providerMs), parseMs: Math.round(parseMs),
    ...(cacheCoordination ? {cacheCoordination} : {}),
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
  if (conversation?.providerConversation) {
    const responseId=String(data?.response_id||"");
    if (!/^resp_[A-Za-z0-9_-]{1,256}$/.test(responseId)) {
      const error=new LocalAiError("LM Studio finished without a usable retained response ID",{
        code:"local_provider_response_contract",attempted:true,retryable:false,
        diagnostics:{validatorSubtype:"missing_stateful_response_id"},
      });
      error.providerResponded=true;
      error.generationAttempts=1;
      throw attach(error);
    }
    conversationContext?.capture(text,responseId);
  } else conversationContext?.capture(text);
  onProgress?.({ state: "completed" });
  return {
    schema: "tp.ai.result/1",
    translations: decoded.translations,
    missing,
    meta: {
      route: "direct-local",
      translationMode:conversation ? "conversation" : "independent",
      ...(conversation ? {conversation:conversation.evidence, historyOrigins:conversation.origins} : {}),
      responseShape: decoded.responseShape,
      ...formatDiagnostics,
      decodedResponseShape: decoded.responseShape,
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
      modelLimits: contextPlan?.limits || ai?.model_capabilities?.limits || {},
      ...(contextPlan ? {contextPlan:contextPlan.evidence} : {}),
      requestedContract: capabilityContract.version,
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
      promptLayout: audit.promptLayout,
      cacheCoordination,
      promptAudit: audit,
      contractDiagnostics,
      alignmentUncertainIds,
      alignmentStatus: alignmentUncertainIds.length ? "uncertain" : "not_semantically_verified",
    },
  };
  } catch (error) {
    error.diagnostics = { ...formatDiagnostics, ...(error.diagnostics || {}) };
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
    throw attachFailureThinking(error);
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
