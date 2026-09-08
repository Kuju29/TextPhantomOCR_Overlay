import { reportTranslationFailure } from "../../shared/diagnostic-policy.js";
// Per-image AI translation orchestration. Queueing, batch barriers and provider
// capacity remain owned by jobs.js; this module owns one page-level translation
// attempt whose provider work may be split into sequential adaptive sub-batches.

import { runContentValidatedTranslation } from "../../shared/ai-content-repair.js";
import {
  applyTranslations as defaultApplyTranslations,
  classifyAiTranslationReport as defaultClassifyReport,
  requireAiLensDocument as defaultRequireDocument,
  requireTranslationConservation as defaultRequireConservation,
  translationUnits as defaultTranslationUnits,
} from "../../shared/lens-document.js";
import { eraseBoxesForAiPartial as defaultErasePartial } from "../../shared/erase-boxes.js";
import { markNoTranslatableText as defaultMarkNoText } from "./result-policy.js";
import {
  diagnoseTargetScripts as defaultDiagnoseScripts,
  summarizeUnitScripts as defaultSummarizeScripts,
} from "../ai/script-diagnostics.js";
import { translateUnits as defaultTranslateUnits } from "../ai/translation-service.js";
import {
  getSeriesMemory as defaultGetMemory,
  selectPromptMemory as defaultSelectMemory,
} from "../series-memory.js";
import { aiWireTraceEnabled, createAiWireRecorder } from "../ai/wire-trace.js";
import { classifyAiOutcomeIds } from "./ai-outcome-classification.js";
import { workloadController as defaultWorkloadController } from "../ai/workload-controller.js";

import { workloadOperationId } from "../ai/workload-identity.js";

const noop = () => {};
const quietLog = Object.freeze({ info: noop, warn: noop });

/**
 * Translate one already-decoded Lens page.
 *
 * Integration signature:
 *   translateLensPage({ base, payload, result, plan, cancelBatchId, signal,
 *     telemetry, onGenerationAttempt, jobId, beforeRepair, capabilities,
 *     isCancelled, onStreamProgress, trace, traceLayout, log, dependencies })
 *
 * `dependencies` is intentionally injectable for contract tests; production
 * callers normally omit it. Cancellation and batch state are injected so this
 * leaf never imports jobs.js, batches.js or scheduler.js.
 */
export async function translateLensPage({
  base,
  payload,
  result,
  plan,
  cancelBatchId = "",
  signal = null,
  telemetry = null,
  onGenerationAttempt = null,
  jobId = "",
  beforeRepair = async () => {},
  capabilities = null,
  isCancelled = () => signal?.aborted === true,
  onStreamProgress = null,
  trace = noop,
  traceLayout = noop,
  log = quietLog,
  dependencies = {},
  onCheckpoint = async () => {},
  onStatus = () => {},
}) {
  const requireDocument =
    dependencies.requireAiLensDocument || defaultRequireDocument;
  const readUnits = dependencies.translationUnits || defaultTranslationUnits;
  const requireConservation =
    dependencies.requireTranslationConservation || defaultRequireConservation;
  const applyTranslations =
    dependencies.applyTranslations || defaultApplyTranslations;
  const classifyReport =
    dependencies.classifyAiTranslationReport || defaultClassifyReport;
  const erasePartial =
    dependencies.eraseBoxesForAiPartial || defaultErasePartial;
  const markNoText = dependencies.markNoTranslatableText || defaultMarkNoText;
  const translateUnits = dependencies.translateUnits || defaultTranslateUnits;
  const diagnoseScripts =
    dependencies.diagnoseTargetScripts || defaultDiagnoseScripts;
  const summarizeScripts =
    dependencies.summarizeUnitScripts || defaultSummarizeScripts;
  const getSeriesMemory = dependencies.getSeriesMemory || defaultGetMemory;
  const selectPromptMemory =
    dependencies.selectPromptMemory || defaultSelectMemory;

  const doc = requireDocument(result);
  const units = readUnits(doc);
  const conservation = requireConservation(doc, units);
  const sendable = units.filter((unit) => unit.translatable);
  const passthrough = units
    .filter((unit) => !unit.translatable)
    .map((unit) => ({ id: unit.id, text: unit.text }));
  if (!units.length || !sendable.length) {
    const reason = units.length ? "no_translatable_text" : "no_text";
    log.info(
      reason === "no_text"
        ? "no text to translate; nothing for the AI layer to do"
        : "no translatable text; every unit is digits or symbols",
      { units: units.length },
    );
    markNoText(result, reason);
    return {
      usable: true,
      complete: true,
      skipped: true,
      translated: 0,
      missing: [],
    };
  }

  const traceId = String(payload?.context?.tp_trace || "");
  const operationBase = `ai:${String(payload?.idempotency_key || payload?.metadata?.image_id || "")}`;
  const correlation = {
    operationId: operationBase,
    batchId: String(cancelBatchId || ""),
    imageId: String(payload?.metadata?.image_id || ""),
    jobId: String(jobId || ""),
    engine: payload?.engine === "api" ? "api" : "extension",
    route: String(plan?.route || ""),
    provider: String(plan?.ai?.provider || ""),
    model: String(plan?.ai?.model || ""),
  };
  const wireTrace = createAiWireRecorder({
    enabled: aiWireTraceEnabled(capabilities, plan?.route), operationId: operationBase, traceId,
    identity: correlation, apiBase: base, relay: plan?.route === "direct-local"
      ? capabilities?.aiWireTraceRelay : null,
  });
  const childWireTraces = [];
  const flushWireTrace = () => Promise.all([wireTrace, ...childWireTraces].map(recorder =>
    recorder?.flush?.(Number(capabilities?.aiWireTraceRelay?.timeoutMs) || 1500)));
  // Request IDs are owned by this exact array. Cloud and Local transports get
  // the same array and must not reconstruct expectations from the OCR tree.
  const expectedRequestIds = sendable.map((unit) => String(unit.id));
  await wireTrace?.("units", sendable.map((unit) => ({ id: String(unit.id), text: String(unit.text || ""),
    paragraphIds: (unit.paragraphIds || []).map(String) })));
  // Privacy-safe, session-keyed fingerprints make per-page input ordering
  // observable without placing OCR dialogue in TP_TRACE.
  const sourceFingerprints = [];
  let unitPartitionFingerprint = "";
  let fingerprintText = null;
  try {
    if (!globalThis.__tpTraceFingerprintKey) {
      globalThis.__tpTraceFingerprintKey = crypto.getRandomValues(
        new Uint8Array(32),
      );
    }
    fingerprintText = async (value) => {
      const source = new TextEncoder().encode(String(value || ""));
      const keyed = new Uint8Array(
        globalThis.__tpTraceFingerprintKey.length + source.length,
      );
      keyed.set(globalThis.__tpTraceFingerprintKey);
      keyed.set(source, globalThis.__tpTraceFingerprintKey.length);
      const digest = await crypto.subtle.digest("SHA-256", keyed);
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    for (const unit of sendable) {
      sourceFingerprints.push(await fingerprintText(unit.text));
    }
    const partition = new TextEncoder().encode(
      JSON.stringify(
        sendable.map((unit) => [
          String(unit.id),
          (unit.paragraphIds || []).map(String),
        ]),
      ),
    );
    const keyedPartition = new Uint8Array(
      globalThis.__tpTraceFingerprintKey.length + partition.length,
    );
    keyedPartition.set(globalThis.__tpTraceFingerprintKey);
    keyedPartition.set(partition, globalThis.__tpTraceFingerprintKey.length);
    const partitionDigest = await crypto.subtle.digest(
      "SHA-256",
      keyedPartition,
    );
    unitPartitionFingerprint = Array.from(
      new Uint8Array(partitionDigest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    sourceFingerprints.length = 0; // Never fall back to an unsalted hash.
    unitPartitionFingerprint = "";
  }
  trace(
    "aiPageContract",
    {
      event: "prepared",
      ...correlation,
      unitCount: sendable.length,
      eligibleParagraphCount: conservation.eligibleParagraphCount,
      excludedBlankParagraphCount: conservation.excludedBlankParagraphCount,
      conservedUnitCount: conservation.unitCount,
      expectedIdCount: expectedRequestIds.length,
      unitPartitionFingerprint,
      fingerprintAvailable: sourceFingerprints.length === sendable.length,
      fingerprintChunks: sourceFingerprints.length
        ? Math.ceil(sendable.length / 10)
        : 0,
      fullContext: true,
    },
    traceId,
  );
  for (
    let offset = 0;
    sourceFingerprints.length && offset < sendable.length;
    offset += 10
  ) {
    trace(
      "aiUnitFingerprints",
      {
        ...correlation,
        offset,
        units: sendable.slice(offset, offset + 10).map((unit, index) => ({
          id: String(unit.id),
          sourceFingerprint: sourceFingerprints[offset + index],
        })),
      },
      traceId,
    );
  }

  const memoryMode = String(plan.ai?.memory_mode || "off");
  const seriesKey = String(payload?.context?.series_key || "");
  if (seriesKey && memoryMode !== "off") {
    const recent = selectPromptMemory(await getSeriesMemory(seriesKey));
    const pageIndex = Number(payload?.context?.page_index);
    const memoryBatchId = String(
      payload?.context?.batch_id || payload?.metadata?.batch_id || "",
    );
    const previousPage =
      Number.isInteger(pageIndex) && pageIndex > 0
        ? recent.pageContexts?.[memoryBatchId]?.[String(pageIndex - 1)] || []
        : [];
    plan.ai = {
      ...plan.ai,
      glossary:
        memoryMode === "terms" || memoryMode === "full" ? recent.glossary : [],
      characters: memoryMode === "full" ? recent.characters : [],
      series_state: memoryMode === "full" ? recent.state : "",
      prev_context: memoryMode === "full" ? previousPage : [],
    };
  }

  const acceptedStatusIds = new Set();
  let statusBatch = 0;
  const status = patch => { try { onStatus(patch); } catch {} };
  const checkpoint = async (stage, data = {}) => {
    await onCheckpoint({stage, payload, result, plan, units, jobId,
      operationId:operationBase, imageId:correlation.imageId, ...data});
    for (const u of data.accepted || []) if (expectedRequestIds.includes(String(u.id))) acceptedStatusIds.add(String(u.id));
    const common = {total:sendable.length, accepted:acceptedStatusIds.size,
      pending:sendable.length-acceptedStatusIds.size};
    if(stage === 'prepared') status({...common,applied:0,provider:plan.ai.provider,model:plan.ai.model,
      fallbackCount:Number(result?.diagnosticSummary?.orientationFallbackCount || 0)});
    else if(stage === 'dispatch') status({...common,phase:'usage_pending',unitCount:data.ids?.length || 0,batchIndex:++statusBatch,contract:data.workload?.planningContract || 'unconfirmed'});
    else status(common);
  };
  const workloadController = dependencies.workloadController || defaultWorkloadController;
  const workloadSession = await workloadController.open({ ai: plan.ai, route: plan.route,
    sourceLang: String(doc?.languages?.source || ""), targetLang: String(payload.lang || ""),
    image: plan.ai?.send_image === true });
  // Capture the same snapshot that selected the workload before any async
  // metadata refresh can change what the transport or repair sees.
  if (workloadSession.ai) plan = { ...plan, ai: workloadSession.ai };
  trace("effectiveSettings", {schema:"tp.audit/1",event:"settings_effective",reason:"initial",
    scope:{profileId:workloadSession.key.slice(0,16),imageId:correlation.imageId,batchId:cancelBatchId},
    engine:payload.engine === 'api' ? 'api' : 'extension',route:plan.route,
    planned:{thinking:plan.ai.thinking === 'on' ? 'on' : 'off',pageImage:plan.ai.send_image===true,
      memoryEnabled:plan.ai.char_memory===true,temperature:plan.ai.temperature ?? null,
      maxOutput:plan.ai.max_output_tokens ?? null,glossaryItems:plan.ai.glossary?.length || 0,
      characterItems:plan.ai.characters?.length || 0,previousItems:plan.ai.prev_context?.length || 0}},traceId);
  await checkpoint("prepared");

  const translateOne = (selectedUnits, operationId, workload, recorder = wireTrace) =>
    translateUnits(selectedUnits, {
      route: plan.route,
      ai: { ...plan.ai, workload },
      rate: payload?.rate || null,
      unlimited: payload?.limits?.aiUnlimited === true,
      imageDataUri: plan.ai?.send_image
        ? String(result?.sourceImageDataUri || payload?.imageDataUri || "")
        : "",
      targetLang: String(payload.lang || ""),
      sourceLang: String(doc?.languages?.source || ""),
      base,
      operationId,
      batchId: cancelBatchId,
      jobId,
      imageId: correlation.imageId,
      signal,
      traceId,
      trace: (event, data) =>
        trace("translateUnits", { event, ...data }, traceId),
      onProgress: onStreamProgress,
      capabilities,
      wireTrace: recorder,
    });

  // Re-plan only the unsent units after each measured generation. Never resend
  // successful units, change their IDs, or turn one attempt into a hidden retry.
  const translate = async (selectedUnits, operationId) => {
    const translations = [], missing = [], memoryCharacters = [], memoryGlossary = [], subBatches = [];
    let offset = 0;
    try {
      while (offset < selectedUnits.length) {
        if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
        const chunk = workloadSession.next(selectedUnits, offset);
        const index = subBatches.length;
        const single = offset === 0 && chunk.units.length === selectedUnits.length;
        const subOperationId = await workloadOperationId(operationId, index, chunk.units, workloadSession.key);
        let recorder = wireTrace;
        if (subOperationId !== operationId) {
          recorder = createAiWireRecorder({ enabled: aiWireTraceEnabled(capabilities, plan.route),
            operationId: subOperationId, traceId, identity: { ...correlation, operationId: subOperationId },
            apiBase: base, relay: plan.route === "direct-local" ? capabilities?.aiWireTraceRelay : null });
          childWireTraces.push(recorder);
          await recorder?.("units", chunk.units.map(u => ({ id: String(u.id), text: String(u.text || "") })));
        }
        const { estimate } = chunk;
        const workload = { version: 1, predictedOutput: estimate.predictedOutput,
          reasoningReserve: estimate.reasoningReserve, estimatedInput: estimate.estimatedInput,
          completionAvailable: estimate.completionAvailable, limits: estimate.limits };
        trace("aiModelWorkload", { event: "dispatch", operationId: subOperationId,
          parentOperationId: operationId, profileId: workloadSession.key.slice(0, 16),
          budget: { unitCount: chunk.units.length, predictedOutput: estimate.predictedOutput,
            reasoningReserve: estimate.reasoningReserve, estimatedInput: estimate.estimatedInput,
            outputTarget: estimate.target, sourceChars: estimate.sourceChars, recordTarget: estimate.recordTarget, revision: estimate.revision,
            completionAvailable: estimate.completionAvailable, samples: estimate.samples,
            planningContract: estimate.planningContract, profileDecision: estimate.profileDecision },
          splitReason: chunk.splitReason, oversizeSingleUnit: chunk.oversizeSingleUnit,
          limitsSource: estimate.limits.source || "unknown", ids: chunk.units.map(u => String(u.id)),
        }, traceId);
        let answer;
        try {
          await checkpoint("dispatch", { ids: chunk.units.map(u => String(u.id)), operationId: subOperationId, workload:chunk.estimate });
          if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
          answer = await translateOne(chunk.units, subOperationId, workload, recorder);
        } catch (error) {
          if (!isCancelled()) trace("aiModelWorkload", { event: "observation", operationId: subOperationId,
            ...workloadSession.observe({ units: chunk.units, error, plan: estimate }) }, traceId);
          const known = /invalid_model_output|output_budget_exhausted|wrong_language|output_contract|invalid_result_schema/.test(String(error?.code || ""));
          if (!isCancelled()) await checkpoint("progress", {
            failures: known ? chunk.units.map(u => ({ id: String(u.id), reason: error.code === "output_budget_exhausted" ? "length" : "malformed" })) : [],
            blocked: known ? [] : chunk.units.map(u => String(u.id)),
          });
          throw error;
        }
        if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
        trace("aiModelWorkload", { event: "observation", operationId: subOperationId,
          ...workloadSession.observe({ units: chunk.units, answer,
            defects: contentDefects(answer, chunk.units), plan: estimate }) }, traceId);
        const chunkDefects = contentDefects(answer, chunk.units);
        const rejected = new Set([...chunkDefects.missing, ...chunkDefects.wrongLanguage]);
        await checkpoint("progress", {
          accepted: (answer?.translations || []).filter(x => !rejected.has(String(x.id))),
          failures: [...rejected].map(id => ({ id, reason: chunkDefects.wrongLanguage.includes(id) ? "wrong_language"
            : answer?.meta?.declinedIds?.includes(id) ? "empty"
            : answer?.meta?.omittedIds?.includes(id) ? "omitted" : "missing" })),
        });
        translations.push(...(answer?.translations || []));
        missing.push(...(answer?.missing || []));
        memoryCharacters.push(...(answer?.memoryDelta?.characters || []));
        memoryGlossary.push(...(answer?.memoryDelta?.glossary || []));
        subBatches.push({ index, operationId: subOperationId, unitCount: chunk.units.length,
          outputTarget: estimate.target, sourceChars: estimate.sourceChars, recordTarget: estimate.recordTarget,
          predictedOutput: estimate.predictedOutput, meta: answer?.meta || {} });
        offset += chunk.units.length;
        if (single) return answer;
      }
      return { schema: "tp.ai.result/1", translations, missing: [...new Set(missing.map(String))],
        memoryDelta: { characters: memoryCharacters, glossary: memoryGlossary },
        meta: { route: plan.route, adaptiveBatching: true, workloadPolicy: "model_aware_output_weight_v1",
          batchCount: subBatches.length, subBatches,
          generationAttempts: subBatches.reduce((n,b) => n + (b.meta.generationAttempts || 1), 0),
          providerAttempts: subBatches.reduce((n,b) => n + (b.meta.providerAttempts || 1), 0),
          omittedIds: subBatches.flatMap(b => b.meta.omittedIds || []),
          declinedIds: subBatches.flatMap(b => b.meta.declinedIds || []) } };
    } finally { await workloadController.flush(); }
  };

  const memoryCharacters = [];
  const memoryGlossary = [];
  const collectMemoryDelta = (answer) => {
    if (Array.isArray(answer?.memoryDelta?.characters))
      memoryCharacters.push(...answer.memoryDelta.characters);
    if (Array.isArray(answer?.memoryDelta?.glossary))
      memoryGlossary.push(...answer.memoryDelta.glossary);
  };
  const contentDefects = (answer, expectedUnits = sendable) => {
    const translations = Array.isArray(answer?.translations)
      ? answer.translations
      : [];
    const missing = new Set((answer?.missing || []).map(String));
    const returned = new Set(
      translations
        .filter((item) => String(item?.text || "").trim())
        .map((item) => String(item.id)),
    );
    for (const unit of expectedUnits)
      if (!returned.has(String(unit.id))) missing.add(String(unit.id));
    const expectedIds = new Set(expectedUnits.map((unit) => String(unit.id)));
    const scoped = translations.filter((item) =>
      expectedIds.has(String(item?.id)),
    );
    const diagnostics = diagnoseScripts(
      scoped,
      String(payload.lang || ""),
      expectedUnits,
    );
    const wrongLanguage = diagnostics
      .filter((row) => row.decision === "reject")
      .map((row) => row.id);
    return {
      missing: [...missing],
      wrongLanguage,
      languageDiagnostics: diagnostics.slice(0, 10),
      invalid: missing.size > 0 || wrongLanguage.length > 0,
    };
  };
  // Wrong-script records remain classified as wrongLanguageIds; adaptive
  // sub-batching changes provider generation boundaries only. Preserving a
  // valid partial result is a delivery policy, not a reason to relabel model
  // output as structurally missing.
  const traceAttempt = (event, attempt, data = {}) =>
    trace(
      "aiContentAttempt",
      {
        event,
        attempt,
        // Failure shape must survive compact TP_TRACE key caps; identifiers
        // and stable correlation fields follow it.
        ...data,
        ...correlation,
        repairAttempt: Math.max(0, attempt - 1),
        fullContext: true,
        unitCount: sendable.length,
      },
      traceId,
    );
  const traceScripts = (items, phase) =>
    trace(
      "aiUnitScripts",
      {
        ...correlation,
        phase,
        units: summarizeScripts(items),
      },
      traceId,
    );
  const traceStageFingerprints = async (items, stage) => {
    if (!fingerprintText) return;
    const rows = [];
    for (const item of items || []) {
      const id = String(item?.id || "");
      if (!id) continue;
      rows.push({
        id,
        contentFingerprint: await fingerprintText(item?.text),
        scripts: summarizeScripts([{ id, text: String(item?.text || "") }])[0],
      });
    }
    for (let offset = 0; offset < rows.length; offset += 10) {
      trace(
        "aiUnitStageFingerprints",
        { ...correlation, stage, offset, units: rows.slice(offset, offset + 10) },
        traceId,
      );
    }
  };

  let translated;
  try {
    translated = await runContentValidatedTranslation({
      translate,
      units: sendable,
      operationBase,
      contentDefects,
      collectMemoryDelta,
      onGenerationAttempt: () => onGenerationAttempt?.(),
      traceAttempt,
      traceScripts,
      beforeRepair,
      isCancelled,
      repair: { enabled: false },
      preserveWrongLanguagePartial: true,
      warn: (error) =>
        reportTranslationFailure(log, trace,
          "AI content repair failed; preserving the validated first partial", error,
          {
            route: plan.route,
            code: error?.code,
            error: error?.message || String(error),
          },
        ),
    });
  } catch (error) {
    await wireTrace?.("failure", {
      stage: String(error?.stage || "page_translation"), code: String(error?.code || ""),
      name: String(error?.name || "Error"), message: String(error?.message || error),
      status: Number(error?.status || 0), requestDispatched: error?.requestDispatched === true,
      providerResponded: error?.providerResponded === true,
      providerAttempts: Number(error?.providerAttempts || 0),
      generationAttempts: Number(error?.generationAttempts || 0),
    });
    await flushWireTrace();
    if (Number(error?.generationAttempts || 0) > 0) onGenerationAttempt?.();
    reportTranslationFailure(log, trace, "text-only AI failed", error, {
      route: plan.route,
      code: error?.code,
      providerAttempts: Number(error?.providerAttempts || 0),
      error: error?.message || String(error),
      willRetryFullPipeline: false,
    });
    throw error;
  }
  let { outcome, firstOutcome, repairAttempted, repairReason } = translated;
  await traceStageFingerprints(
    Array.isArray((firstOutcome || outcome)?.translations)
      ? (firstOutcome || outcome).translations
      : [],
    "provider_parsed",
  );
  const repairAccepted =
    repairAttempted && outcome?.meta?.repairAccepted === true;
  const remainingDefects = contentDefects(outcome);
  const firstDefects = contentDefects(firstOutcome || outcome);
  const { missingIds: missingIdsBeforeApply, omittedIds, emptyIds,
    wrongLanguageIds, preservedIds } = classifyAiOutcomeIds({
    missing: remainingDefects.missing,
    omitted: outcome?.meta?.omittedIds,
    empty: outcome?.meta?.declinedIds,
    wrongLanguage: remainingDefects.wrongLanguage,
    preserved: passthrough.map((item) => item.id),
  });
  await wireTrace?.("validation", {
    missingIds: missingIdsBeforeApply, omittedIds, emptyIds, wrongLanguageIds,
    preservedIds, repairAttempted, repairReason, repairAccepted,
  });
  const unresolvedIds = new Set([
    ...remainingDefects.missing,
    ...remainingDefects.wrongLanguage,
  ].map(String));
  const unresolvedWrongLanguageIds = new Set(
    remainingDefects.wrongLanguage.map(String),
  );
  if (repairReason === "wrong_target_script") {
    for (const id of firstDefects.wrongLanguage)
      if (unresolvedIds.has(String(id))) unresolvedWrongLanguageIds.add(String(id));
  }
  trace(
    "aiPageContract",
    {
      event: "final",
      ...correlation,
      repairAttempted,
      repairReason,
      repairAccepted,
      fullContext: false,
      missingIds: remainingDefects.missing,
      wrongLanguageIds: remainingDefects.wrongLanguage,
    },
    traceId,
  );
  await checkpoint("finished", {
    accepted: (outcome?.translations || []).filter(x => !unresolvedIds.has(String(x.id))),
    failures: [...unresolvedIds].map(id => ({ id, reason: unresolvedWrongLanguageIds.has(id) ? "wrong_language" :
      emptyIds.includes(id) ? "empty" : "missing" })),
  });
  const wrongLanguageCount = unresolvedWrongLanguageIds.size;
  const overwhelminglyWrongLanguage =
    wrongLanguageCount > 0 &&
    wrongLanguageCount >= Math.ceil(sendable.length * 0.8);
  if (overwhelminglyWrongLanguage) {
    const error = new Error(
      `AI returned ${wrongLanguageCount} of ${sendable.length} translation units outside the selected target language`,
    );
    error.code = "wrong_language_output";
    error.generationAttempts = repairAttempted ? 2 : 1;
    error.providerAttempts = error.generationAttempts;
    error.retryable = false;
    error.diagnostics = {
      targetLang: String(payload.lang || ""),
      rejectedUnits: wrongLanguageCount,
      expectedUnits: sendable.length,
      repairAttempted,
    };
    await wireTrace?.("failure", { stage: "target_language_validation", code: error.code,
      name: error.name, message: error.message, providerResponded: true,
      providerAttempts: error.providerAttempts, generationAttempts: error.generationAttempts,
      wrongLanguageIds: [...unresolvedWrongLanguageIds] });
    await flushWireTrace();
    throw error;
  }
  if (remainingDefects.wrongLanguage.length) {
    const rejected = new Set(remainingDefects.wrongLanguage.map(String));
    outcome = {
      ...outcome,
      translations: (outcome.translations || []).filter(
        (item) => !rejected.has(String(item?.id)),
      ),
      missing: [
        ...new Set([...(outcome.missing || []).map(String), ...rejected]),
      ],
    };
  }
  outcome.meta = {
    ...(outcome?.meta || {}),
    contractVersion: String(outcome?.meta?.contractVersion || "tp.ai.result/1"),
    automaticContentRetry: repairAttempted,
    contentRepairAttempts: repairAttempted ? 1 : 0,
    contentRepairReason: repairReason,
    contentRepairAccepted: repairAccepted,
    contentRepairFullContext: false,
    contentGenerationAttempts: repairAttempted ? 2 : 1,
    remainingWrongLanguageIds: remainingDefects.wrongLanguage,
  };
  if (telemetry) {
    telemetry.providerMs = Number(outcome.meta.providerMs);
    telemetry.serverTotalMs = Number(outcome.meta.dt_ms);
    telemetry.replayed = outcome.replayed === true;
    telemetry.rateWaitMs = Number(outcome.meta.rateWaitMs);
    telemetry.admissionWaitMs = Number(outcome.meta.admissionWaitMs);
    telemetry.rate =
      outcome.meta.rate && typeof outcome.meta.rate === "object"
        ? outcome.meta.rate
        : null;
  }

  const merged = [
    ...(Array.isArray(outcome.translations) ? outcome.translations : []),
    ...passthrough,
  ];
  let applied;
  try { applied = applyTranslations(doc, merged); }
  catch (error) {
    await wireTrace?.("failure", { stage: "apply_translations", code: String(error?.code || ""),
      name: String(error?.name || "Error"), message: String(error?.message || error),
      providerResponded: true, generationAttempts: Number(outcome?.meta?.generationAttempts || 1) });
    await flushWireTrace();
    throw error;
  }
  await wireTrace?.("applyResult", { applied: Array.isArray(applied.report?.applied) ? applied.report.applied.map(String) : [],
    missing: Array.isArray(applied.report?.missing) ? applied.report.missing.map(String) : [], documentParagraphs: (applied.document?.paragraphs || []).map((paragraph) => ({
      id: String(paragraph?.id || ""), aiText: Object.hasOwn(paragraph || {}, "aiText") ? String(paragraph.aiText || "") : null,
    })) });
  await traceStageFingerprints(
    sendable.flatMap((unit) => {
      const leader = String(unit?.paragraphIds?.[0] || "");
      const paragraph = (applied.document?.paragraphs || []).find(
        (item) => String(item?.id || "") === leader,
      );
      return Object.hasOwn(paragraph || {}, "aiText")
        ? [{ id: String(unit.id), text: String(paragraph.aiText || "") }]
        : [];
    }),
    "document_applied",
  );
  traceLayout(
    applied.document,
    traceId,
    "post-translation",
    correlation.imageId,
  );
  const missingIds = applied.report.missing.map(String);
  const translatedCount = sendable.length - missingIds.length;
  if (translatedCount <= 0) {
    await wireTrace?.("terminal", { state: "completed_unusable", translated: 0,
      missingIds, terminal: true });
    await flushWireTrace();
    return {
      usable: false,
      complete: false,
      translated: 0,
      missing: missingIds,
      reason: "AI returned no usable translations",
    };
  }

  result.lensDocument = applied.document;
  const pageIndex = Number(payload?.context?.page_index);
  if (
    memoryCharacters.length ||
    memoryGlossary.length ||
    memoryMode === "full" ||
    Boolean(outcome.meta.vision)
  ) {
    result.Ai = {
      ...(result.Ai || {}),
      characters: memoryCharacters,
      glossary: memoryGlossary,
      meta: {
        ...(result.Ai?.meta || {}),
        vision: Boolean(outcome.meta.vision),
        ...(Number.isInteger(pageIndex) ? { pageIndex } : {}),
        ...(payload?.metadata?.batch_id
          ? { batchId: String(payload.metadata.batch_id) }
          : {}),
      },
    };
  }
  result.aiRoute = { ...plan, ...outcome.meta, ...applied.report };
  delete result.aiRoute.ai;
  if (applied.report.missing.length) {
    const safeErase = erasePartial(result.lensDocument, result.eraseBoxes);
    if (!safeErase.ok) {
      trace("aiEraseOwnership", { ...correlation, stage: "render",
        code: "AI_ERASE_OWNERSHIP_INVALID", reason: safeErase.reason,
        translated: applied.report.translated, missingIds }, traceId);
      await wireTrace?.("terminal", { state: "completed_unusable", stage: "render",
        code: "AI_ERASE_OWNERSHIP_INVALID",
        translated: applied.report.translated, missingIds, reason: safeErase.reason,
        terminal: true });
      await flushWireTrace();
      return {
        usable: false,
        complete: false,
        translated: applied.report.translated,
        missing: missingIds,
        code: "AI_ERASE_OWNERSHIP_INVALID",
        failedStage: "render",
        reason: safeErase.reason,
      };
    }
    result.eraseBoxes = safeErase.eraseBoxes;
    const omitted = omittedIds;
    const declined = emptyIds;
    const missingUnits = missingIds.map((id) => ({
      id,
      paragraphIds: (
        sendable.find((unit) => String(unit.id) === id)?.paragraphIds || []
      ).map(String),
    }));
    result.aiPartial = {
      partial: true,
      translated: applied.report.translated,
      missing: missingIds,
      missingUnits,
      omitted,
      declined,
      wrongLanguage: wrongLanguageIds,
      preserved: preservedIds,
    };
    const causes = [
      omitted.length ? `omitted: ${omitted.join(", ")}` : "",
      declined.length ? `empty: ${declined.join(", ")}` : "",
      wrongLanguageIds.length
        ? `wrong target language: ${wrongLanguageIds.join(", ")}` : "",
      missingIdsBeforeApply.length
        ? `unclassified missing: ${missingIdsBeforeApply.join(", ")}` : "",
    ].filter(Boolean);
    result.warnings = [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      `AI left ${applied.report.missing.length} translation unit(s) unanswered (${causes.join("; ")}): ` +
        `${applied.report.missing.join(", ")}`,
    ];
  }
  const report = classifyReport(applied.report);
  await wireTrace?.("terminal", {
    state: missingIds.length === 0 ? "succeeded" : "partial",
    translated: translatedCount, missingIds: missingIdsBeforeApply,
    omittedIds, emptyIds, wrongLanguageIds, preservedIds,
    unresolvedIds: missingIds, complete: missingIds.length === 0, terminal: true,
  });
  await flushWireTrace();
  return report;
}
