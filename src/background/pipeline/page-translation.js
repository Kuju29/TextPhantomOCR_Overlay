import {bindConversation} from "../ai/translation-paths/order.js";
import { budgetDiagnostic, rejectedBudgetDiagnostic, resultDiagnostic } from "../../shared/ai/request-diagnostics.js";
import { rememberDiagnostic } from "../ai/recent-diagnostics.js";
import { selectPageContext } from "../../shared/ai/page-context.js";
import { summarizeExecutionTiming } from "../../shared/ai/execution-timing.js";
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
import { WORKLOAD_POLICY } from "../../shared/ai/workload/model.js";
import { normalizeReasoningPreference } from "../../shared/reasoning-preference.js";

import { workloadOperationId } from "../ai/workload-identity.js";
import { pageImageEnabled } from "../../shared/page-image-policy.js";
import { isTracing as defaultIsTracing } from "../../shared/trace.js";

const noop = () => {};
const quietLog = Object.freeze({ info: noop, warn: noop });
const FINGERPRINT_CONCURRENCY = 16;
const defaultFingerprintDigest = (_algorithm, keyed) =>
  crypto.subtle.digest("SHA-256", keyed);

async function mapBounded(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), values.length) },
      worker,
    ),
  );
  return output;
}

/** Privacy-safe diagnostics. No key or digest work occurs while trace is off. */
export async function diagnosticFingerprints(
  units,
  { enabled = defaultIsTracing(), digest = defaultFingerprintDigest } = {},
) {
  if (!enabled) return null;
  if (!globalThis.__tpTraceFingerprintKey)
    globalThis.__tpTraceFingerprintKey = crypto.getRandomValues(new Uint8Array(32));
  const key = globalThis.__tpTraceFingerprintKey;
  const fingerprints = new Map();
  const fingerprint = (value) => {
    const text = String(value || "");
    if (fingerprints.has(text)) return fingerprints.get(text);
    const pending = (async () => {
    const source = new TextEncoder().encode(text);
    const keyed = new Uint8Array(key.length + source.length);
    keyed.set(key);
    keyed.set(source, key.length);
    const valueDigest = await digest("SHA-256", keyed);
    return Array.from(new Uint8Array(valueDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    })();
    // Scope reuse to this page and trace key; keep no cross-page text cache.
    fingerprints.set(text, pending);
    return pending;
  };
  const source = await mapBounded(
    units,
    FINGERPRINT_CONCURRENCY,
    (unit) => fingerprint(unit?.text),
  );
  const partition = JSON.stringify(
    units.map((unit) => [
      String(unit.id),
      (unit.paragraphIds || []).map(String),
    ]),
  );
  return { source, partition: await fingerprint(partition), fingerprint };
}

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
  conversationSubmit = null,
  onCheckpoint = async () => {},
  onStatus = () => {},
  onProvisionalResult = null,
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
  const clock = dependencies.clock || (() => performance.now());
  const traceEnabled = dependencies.traceEnabled || defaultIsTracing;
  const digest = dependencies.fingerprintDigest;
  const pageTranslationStartedAt = clock();

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
    pageIndex: payload?.context?.page_index,
    jobId: String(jobId || ""),
    engine: payload?.engine === "api" ? "api" : "extension",
    route: String(plan?.route || ""),
    provider: String(plan?.ai?.provider || ""),
    model: String(plan?.ai?.model || ""),
  };
  const wireTrace = createAiWireRecorder({
    enabled: aiWireTraceEnabled(capabilities, plan?.route), operationId: operationBase, traceId,
    identity: { ...correlation, recordKind: "page_summary" }, apiBase: base, relay: plan?.route === "direct-local"
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
  let sourceFingerprints = [];
  let unitPartitionFingerprint = "";
  let fingerprintText = null;
  const fingerprintStartedAt = clock();
  try {
    const fingerprints = await diagnosticFingerprints(sendable, {
      enabled: traceEnabled(),
      ...(digest ? { digest } : {}),
    });
    if (fingerprints) {
      sourceFingerprints = fingerprints.source;
      unitPartitionFingerprint = fingerprints.partition;
      fingerprintText = fingerprints.fingerprint;
    }
  } catch {
    sourceFingerprints = []; // Never fall back to an unsalted hash.
    unitPartitionFingerprint = "";
    fingerprintText = null;
  }
  const fingerprintMs = Math.max(0, clock() - fingerprintStartedAt);
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

  bindConversation(payload);
  if (payload.ai?.conversation) plan.ai = {...plan.ai, conversation: payload.ai.conversation};
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
    const checkpointStartedAt = clock();
    let checkpointFailed = true;
    try {
      await onCheckpoint({stage, payload, result, plan, units, jobId,
        operationId:operationBase, imageId:correlation.imageId, ...data});
      checkpointFailed = false;
    } finally {
      // Diagnostics must never change checkpoint success/failure semantics.
      try { trace("aiCheckpointTiming", {schema:"tp.audit/1", event:"checkpoint_timing",
        reason:stage, scope:{operationId:data.operationId || operationBase,
          imageId:correlation.imageId, batchId:cancelBatchId, jobId},
        timing:{checkpointMs:Math.max(0, clock() - checkpointStartedAt)},
        counts:{failed:Number(checkpointFailed)}}, traceId); } catch {}
    }
    for (const u of data.accepted || []) if (expectedRequestIds.includes(String(u.id))) acceptedStatusIds.add(String(u.id));
    const common = {total:sendable.length, accepted:acceptedStatusIds.size,
      pending:sendable.length-acceptedStatusIds.size};
    if(stage === 'prepared') status({...common,applied:0,provider:plan.ai.provider,model:plan.ai.model,
      fallbackCount:Number(result?.diagnosticSummary?.orientationFallbackCount || 0)});
    else if(stage === 'dispatch') status({...common,phase:'usage_pending',unitCount:data.ids?.length || 0,batchIndex:++statusBatch,contract:data.workload?.planningContract || 'unconfirmed'});
    else {
      status(common);
      if (data.nextDispatch) status({...common,phase:'usage_pending',unitCount:data.nextDispatch.ids.length,
        batchIndex:++statusBatch,contract:data.nextDispatch.workload?.planningContract || 'unconfirmed'});
    }
  };
  const workloadController = dependencies.workloadController || defaultWorkloadController;
  const workloadStartedAt = clock();
  const workloadSession = conversationSubmit ? {key:"conversation_cross_page", ai:plan.ai} : await workloadController.open({ ai: plan.ai, route: plan.route, pageUnits: sendable,
    sourceLang: String(doc?.languages?.source || ""), targetLang: String(payload.lang || ""),
    image: pageImageEnabled(plan.ai?.send_image), wholePageFirst: true, phase: "initial", singleRequest: false });
  const workloadOpenMs = Math.max(0, clock() - workloadStartedAt);
  // Capture the same snapshot that selected the workload before any async
  // metadata refresh can change what the transport or repair sees.
  if (workloadSession.ai) plan = { ...plan, ai: workloadSession.ai };
  trace("effectiveSettings", {schema:"tp.audit/1",event:"settings_effective",reason:"initial",
    scope:{profileId:workloadSession.key.slice(0,16),imageId:correlation.imageId,batchId:cancelBatchId},
    engine:payload.engine === 'api' ? 'api' : 'extension',route:plan.route,
    planned:{thinking:normalizeReasoningPreference(plan.ai.thinking, 'minimum'),pageImage:pageImageEnabled(plan.ai.send_image),
      examplesEnabled:plan.ai.style_examples!==false,memoryMode:plan.ai.memory_mode || "off",
      memoryEnabled:plan.ai.char_memory===true,temperature:plan.ai.temperature ?? null,
      maxOutput:plan.ai.max_output_tokens ?? null,glossaryItems:plan.ai.glossary?.length || 0,
      characterItems:plan.ai.characters?.length || 0,previousItems:plan.ai.prev_context?.length || 0}},traceId);
  const preparedCheckpointStartedAt = clock();
  await checkpoint("prepared");
  const checkpointPreparedMs = Math.max(0, clock() - preparedCheckpointStartedAt);

  const executionTimings = [];
  const recordExecutionTiming = result => {
    executionTimings.push(result);
    if (telemetry) Object.assign(telemetry, summarizeExecutionTiming(executionTimings));
  };
  const translateOne = async (selectedUnits, operationId, workload, recorder = wireTrace) => {
    try {
      const answer = await translateUnits(selectedUnits, {
      route: plan.route,
      ai: { ...plan.ai, workload, page_context: selectPageContext(sendable, selectedUnits) },
      rate: payload?.rate || null,
      unlimited: payload?.limits?.aiUnlimited === true,
      imageDataUri: pageImageEnabled(plan.ai?.send_image)
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
      tabSession: String(payload?.context?.tp_tab_session || ""),
      trace: (event, data) =>
        trace("translateUnits", { event, ...data }, traceId),
      onProgress: onStreamProgress,
      capabilities,
      wireTrace: recorder,
    });
      recordExecutionTiming(answer);
      if (telemetry) telemetry.sampleWorkload = executionTimings.length === 1
        ? {unitCount:selectedUnits.length, sourceChars:selectedUnits.reduce((sum,unit)=>sum+Array.from(String(unit?.text || "")).length,0)}
        : null;
      return answer;
    } catch (error) {
      // Even an unconfirmed dispatch invalidates a complete timing sample.
      recordExecutionTiming({ failed: true, replayed: error?.replayed === true,
        meta: error?.providerResponded === false ? {} :
          error?.generationMeta || error?.structuralDetails?.generationMeta ||
          (error?.diagnostics?.providerTerminalComplete === true ? error.diagnostics : {}) });
      throw error;
    }
  };

  // Re-plan only the unsent units after each measured generation. Never resend
  // successful units, change their IDs, or turn one attempt into a hidden retry.
  let provisionalVisible=false;
  const translate = async (selectedUnits, operationId) => {
    if (conversationSubmit) {
      const bytes=new TextEncoder().encode(JSON.stringify(sendable.map(u=>[u.id,u.text])));
      const sourceFingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
      const answer=await conversationSubmit(selectedUnits,{
        payload,route:plan.route,ai:plan.ai,rate:payload.rate || null,unlimited:payload?.limits?.aiUnlimited===true,
        imageDataUri:pageImageEnabled(plan.ai?.send_image)?String(result?.sourceImageDataUri||payload?.imageDataUri||""):"",
        targetLang:String(payload.lang||""),sourceLang:String(doc?.languages?.source||""),base,
        operationId,batchId:cancelBatchId,jobId,imageId:correlation.imageId,signal,traceId,
        sourceFingerprint,tabSession:String(payload?.context?.tp_tab_session||""),trace,
        onConversationStatus:status=>onStatus?.({translationMode:'conversation',conversation:status}),
        beforeBatchDispatch:async data=>checkpoint("dispatch",{ids:data.units.map(u=>u.id),operationId:data.batchId,workload:data.estimate}),
        onProvisionalResult:async data=>{
          if(!onProvisionalResult||isCancelled())return;
          const validationStarted=performance.now();
          const defects=contentDefects(data,sendable);
          const bad=new Set([...defects.missing,...defects.wrongLanguage]);
          const accepted=data.translations.filter(t=>!bad.has(String(t.id)));
          const complete=bad.size===0;
          const streamTiming={...data.streamTiming,validatedAt:Date.now(),
            validationMs:performance.now()-validationStarted};
          trace('conversationPageValidated',{schema:'tp.audit/1',event:'page_stream_timing',reason:'page_validated',...streamTiming,batchId:data.batchId,
            imageId:correlation.imageId,complete,missingCount:bad.size},traceId);
          if(!complete&&!provisionalVisible)return;
          const applied=applyTranslations(doc,[...accepted,...passthrough]);
          const snapshot={...result,lensDocument:applied.document,
            meta:{...(result.meta||{}),provisional:true},
            aiRoute:{route:plan.route,translationMode:'conversation',provisional:true},
            aiPartial:{partial:!complete,translated:accepted.length,missing:[...bad]}};
          if(!complete){
            const safe=erasePartial(applied.document,result.eraseBoxes);
            snapshot.eraseBoxes=safe.ok?safe.eraseBoxes:[];
          }
          await onProvisionalResult(snapshot,{complete,failure:data.failure,
            invalidated:provisionalVisible&&!complete,missing:[...bad],isCancelled,streamTiming});
          provisionalVisible=true;
          trace('conversationProvisionalPage',{batchId:data.batchId,imageId:correlation.imageId,
            complete,terminal:false,translated:accepted.length,missing:[...bad],
            streamTerminal:data.terminal===true},traceId);
        },
        afterBatchResult:async data=>{
          const defects=contentDefects(data,data.units),bad=new Set([...defects.missing,...defects.wrongLanguage]);
          await checkpoint("progress",{accepted:data.translations.filter(t=>!bad.has(t.id)),
            failures:[...bad].map(id=>({id,reason:defects.wrongLanguage.includes(id)?"wrong_language":"missing"}))});
        },
        onProgress:onStreamProgress,capabilities});
      await wireTrace?.("contractSelection",{recordKind:"page_summary",planner:"conversation_cross_page",
        sharedRequestRefs:answer.meta?.sharedRequestRefs||[],usageScope:"shared_request_references"});
      for(const ref of answer.meta?.sharedRequestRefs || [])
        trace("conversationPageProjection",{schema:"tp.conversation_batch/1",phase:"page_projection",planner:"conversation_cross_page",
          batchId:ref.operationId,unitCount:ref.pageUnits,requestUnitCount:ref.requestUnits,usageOwner:"provider_request",legacyFallback:false},traceId);
      return answer;
    }
    const translations = [], missing = [], memoryCharacters = [], memoryGlossary = [], subBatches = [];
    const unsentIds = [];
    let offset = 0;
    let preparedDispatch = null;
    let consecutiveCapacityFailures = 0;
    let circuitOpened = false;
    let circuitReason = '';
    const markRemainingUnsent = async (reason) => {
      const remaining = selectedUnits.slice(offset);
      if (!remaining.length) return;
      const ids = remaining.map(unit => String(unit.id));
      unsentIds.push(...ids);
      missing.push(...ids);
      circuitOpened = true;
      circuitReason = reason;
      await checkpoint("progress", {
        failures: ids.map(id => ({ id, reason: "not_sent" })),
        circuit: { open: true, reason, consecutiveCapacityFailures },
      });
      offset = selectedUnits.length;
    };
    try {
      while (offset < selectedUnits.length) {
        if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
        const priorDispatch = preparedDispatch;
        preparedDispatch = null;
        const chunk = priorDispatch?.chunk || workloadSession.next(selectedUnits, offset);
        const index = subBatches.length;
        const single = offset === 0 && chunk.units.length === selectedUnits.length;
        const subOperationId = priorDispatch?.operationId || await workloadOperationId(operationId, index, chunk.units, workloadSession.key);
        let recorder = wireTrace;
        const childTrace = subOperationId !== operationId;
        if (childTrace) {
          recorder = createAiWireRecorder({ enabled: aiWireTraceEnabled(capabilities, plan.route),
            operationId: subOperationId, traceId, identity: { ...correlation, operationId: subOperationId, parentOperationId: operationId,
              recordKind: "provider_request", attemptKind: "initial" },
            apiBase: base, relay: plan.route === "direct-local" ? capabilities?.aiWireTraceRelay : null });
          childWireTraces.push(recorder);
          await recorder?.("units", chunk.units.map(u => ({ id: String(u.id), text: String(u.text || "") })));
        }
        const { estimate } = chunk;
        const diagnosticScope = {operationId:subOperationId,imageId:correlation.imageId,
          profileId:workloadSession.key.slice(0,16),pageUnits:selectedUnits.length};
        const budget = budgetDiagnostic(chunk,diagnosticScope);
        trace("translationBudget",budget,traceId);
        rememberDiagnostic({provider:plan.ai.provider,model:plan.ai.model,operationId:subOperationId,budget});
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
          const dispatchCheckpointStartedAt = clock();
          if (!priorDispatch) await checkpoint("dispatch", { ids: chunk.units.map(u => String(u.id)), operationId: subOperationId, workload:chunk.estimate, contextIds:selectPageContext(sendable, chunk.units).map(u => u.id) });
          const checkpointDispatchMs = Math.max(0, clock() - dispatchCheckpointStartedAt);
          if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
          trace("aiPreProviderTiming", {
            schema: "tp.audit/1",
            event: "pre_provider_timing",
            operationId: subOperationId,
            parentOperationId: operationId,
            batchIndex: index,
            timing: {
              fingerprintMs,
              workloadOpenMs,
              checkpointPreparedMs,
              checkpointDispatchMs,
              // This is the exact handoff to the transport. The server
              // transport's requestTiming/http_started event owns the later
              // network-dispatch boundary after its durable usage intent.
              pageTranslationToTransportHandoffMs: Math.max(0, clock() - pageTranslationStartedAt),
            },
          }, traceId);
          answer = await translateOne(chunk.units, subOperationId, workload, recorder);
        } catch (error) {
          if (isCancelled()) {
            const cancelledResult=resultDiagnostic(null,{...diagnosticScope,error:Object.assign(new Error('Cancelled'),{name:'AbortError'})});
            trace('translationResult',cancelledResult,traceId);
            rememberDiagnostic({provider:plan.ai.provider,model:plan.ai.model,operationId:subOperationId,result:cancelledResult});
            if (childTrace) await recorder?.("terminal", { state: "cancelled", stage: "provider_generation",
              code: String(error?.code || "cancelled"), terminal: true });
            throw error;
          }
          const observed = workloadSession.observe({ units: chunk.units, error, plan: estimate });
          trace("aiModelWorkload", { event: "observation", operationId: subOperationId, ...observed }, traceId);
          const diagnosticResult=resultDiagnostic(observed,{...diagnosticScope,error});
          trace("translationResult",diagnosticResult,traceId);
          rememberDiagnostic({provider:plan.ai.provider,model:plan.ai.model,operationId:subOperationId,result:diagnosticResult});
          const code = String(error?.code || "");
          const generated = error?.providerResponded === true || error?.requestDispatched === true ||
            Number(error?.generationAttempts || 0) > 0 || Number(error?.providerAttempts || 0) > 0 ||
            observed.outcome === "length" || observed.outcome === "structure";
          const recoverableGeneratedFailure = generated &&
            /invalid_model_output|output_budget_exhausted|wrong_language|output_contract|invalid_result_schema/.test(code);
          // A typed upstream HTTP failure returned by the API ends this API
          // invocation. It does not establish provider billing or downstream
          // generation termination. Pool it once at the batch barrier; do not
          // retry this initial call or infer finality from an outer 502/504.
          const terminalGatewayFailure = plan.route === "server" &&
            code === "provider_timeout" && error?.upstreamStatus === 504 &&
            error?.providerFailureKind === "http_status" && error?.requestDispatched === true;
          await checkpoint("progress", {
            failures: terminalGatewayFailure ? chunk.units.map(u => ({ id: String(u.id), reason: "provider_http_error" }))
              : recoverableGeneratedFailure ? chunk.units.map(u => ({ id: String(u.id),
              reason: code === "output_budget_exhausted" ? "length" : code === "wrong_language_output" ? "wrong_language" : "malformed" })) : [],
            blocked: recoverableGeneratedFailure || terminalGatewayFailure ? [] : chunk.units.map(u => String(u.id)),
          });
          if (childTrace) await recorder?.("terminal", { state: "failed", stage: "provider_generation",
            code: code || "provider_generation_failed", providerResponded: generated,
            providerAttempts: Number(error?.providerAttempts || 0),
            generationAttempts: Number(error?.generationAttempts || 0), terminal: true });
          if (!recoverableGeneratedFailure) throw error;
          const ids = chunk.units.map(unit => String(unit.id));
          missing.push(...ids);
          subBatches.push({ index, operationId: subOperationId, unitCount: chunk.units.length,
            outputTarget: estimate.target, sourceChars: estimate.sourceChars,
            recordTarget: estimate.recordTarget, predictedOutput: estimate.predictedOutput,
            splitReason: chunk.splitReason, failed: true, errorCode: code || "generated_output_invalid",
            outcome: observed.outcome, meta: error?.generationMeta || error?.structuralDetails?.generationMeta || {} });
          offset += chunk.units.length;
          consecutiveCapacityFailures = ["length", "structure"].includes(observed.outcome)
            ? consecutiveCapacityFailures + 1 : 0;
          if (consecutiveCapacityFailures >= WORKLOAD_POLICY.circuitFailureThreshold)
            await markRemainingUnsent(observed.outcome === "length" ? "repeated_output_budget_exhausted" : "repeated_invalid_model_output");
          continue;
        }
        if (isCancelled()) throw signal?.reason || new DOMException("Aborted", "AbortError");
        const chunkDefects = contentDefects(answer, chunk.units);
        const observed = workloadSession.observe({ units: chunk.units, answer,
          defects: chunkDefects, plan: estimate });
        trace("aiModelWorkload", { event: "observation", operationId: subOperationId,
          ...observed }, traceId);
        const diagnosticResult=resultDiagnostic(observed,diagnosticScope);
        trace("translationResult",diagnosticResult,traceId);
        rememberDiagnostic({provider:plan.ai.provider,model:plan.ai.model,operationId:subOperationId,
          result:diagnosticResult,layout:answer?.meta?.promptLayout,coordination:answer?.meta?.cacheCoordination,conversation:answer?.meta?.conversation});
        consecutiveCapacityFailures = ["length", "structure"].includes(observed.outcome)
          ? consecutiveCapacityFailures + 1 : 0;
        const rejected = new Set([...chunkDefects.missing, ...chunkDefects.wrongLanguage]);
        if (childTrace) await recorder?.("terminal", {
          state: rejected.size ? "partial" : "succeeded",
          translated: Math.max(0, chunk.units.length - rejected.size),
          missingIds: chunkDefects.missing.map(String),
          wrongLanguageIds: chunkDefects.wrongLanguage.map(String),
          complete: rejected.size === 0, terminal: true,
        });
        // Commit this answer and the next dispatch in one awaited checkpoint,
        // avoiding two whole-run writes per successful sub-batch boundary.
        // The coordinator retains its existing explicit unavailable/degraded
        // behavior if session storage fails; no checkpoint is fire-and-forgotten.
        let planningError;
        if (!isCancelled() && offset + chunk.units.length < selectedUnits.length &&
            consecutiveCapacityFailures < WORKLOAD_POLICY.circuitFailureThreshold) {
          try {
            const next = workloadSession.next(selectedUnits, offset + chunk.units.length);
            preparedDispatch = { chunk: next, operationId: await workloadOperationId(
              operationId, index + 1, next.units, workloadSession.key) };
          } catch (error) { planningError = error; }
        }
        await checkpoint("progress", {
          ...(preparedDispatch ? {nextDispatch: {
            ids: preparedDispatch.chunk.units.map(u => String(u.id)),
            operationId: preparedDispatch.operationId,
            workload: preparedDispatch.chunk.estimate,
            contextIds: selectPageContext(sendable, preparedDispatch.chunk.units).map(u => u.id),
          }} : {}),
          accepted: (answer?.translations || []).filter(x => !rejected.has(String(x.id))),
          failures: [...rejected].map(id => ({ id, reason: chunkDefects.wrongLanguage.includes(id) ? "wrong_language"
            : answer?.meta?.declinedIds?.includes(id) ? "empty"
            : answer?.meta?.omittedIds?.includes(id) ? "omitted" : "missing" })),
        });
        if (planningError) throw planningError;
        translations.push(...(answer?.translations || []));
        missing.push(...(answer?.missing || []));
        memoryCharacters.push(...(answer?.memoryDelta?.characters || []));
        memoryGlossary.push(...(answer?.memoryDelta?.glossary || []));
        subBatches.push({ index, operationId: subOperationId, unitCount: chunk.units.length,
          outputTarget: estimate.target, sourceChars: estimate.sourceChars, recordTarget: estimate.recordTarget,
          predictedOutput: estimate.predictedOutput, splitReason: chunk.splitReason,
          outcome: observed.outcome, meta: answer?.meta || {} });
        offset += chunk.units.length;
        if (consecutiveCapacityFailures >= WORKLOAD_POLICY.circuitFailureThreshold)
          await markRemainingUnsent("repeated_incomplete_model_output");
        if (single && !circuitOpened) return {
          ...answer,
          meta: {
            ...(answer?.meta || {}),
            route: plan.route,
            adaptiveBatching: true,
            workloadPolicy: "page_first_guarded_v1",
            hardBudgetSplit: String(chunk.splitReason).startsWith("per_request_"),
            circuitOpened: false,
            batchCount: 1,
            subBatches,
          },
        };
      }
      return { schema: "tp.ai.result/1", translations, missing: [...new Set(missing.map(String))],
        memoryDelta: { characters: memoryCharacters, glossary: memoryGlossary },
        meta: { route: plan.route, adaptiveBatching: true, workloadPolicy: "page_first_guarded_v1",
          hardBudgetSplit: subBatches.some(batch => String(batch.splitReason).startsWith("per_request_")),
          circuitOpened, circuitReason, unsentIds: [...new Set(unsentIds)],
          batchCount: subBatches.length, subBatches,
          generationAttempts: subBatches.reduce((n, batch) =>
            n + Math.max(1, Number(batch.meta?.generationAttempts || batch.meta?.generation_attempts || 1)), 0),
          providerAttempts: subBatches.reduce((n, batch) =>
            n + Math.max(1, Number(batch.meta?.providerAttempts || batch.meta?.provider_attempts || 1)), 0),
          omittedIds: subBatches.flatMap(b => b.meta.omittedIds || []),
          declinedIds: subBatches.flatMap(b => b.meta.declinedIds || []) } };
    } catch (error) {
      if (String(error?.code || '').toLowerCase() === 'ai_workload_budget_insufficient' && error?.requestDispatched !== true) {
        const scope={operationId,imageId:correlation.imageId,profileId:workloadSession.key.slice(0,16)};
        const budget=rejectedBudgetDiagnostic(error,{...scope,pageUnits:selectedUnits.length});
        const result=resultDiagnostic(null,{...scope,error});
        trace('translationBudget',budget,traceId);trace('translationResult',result,traceId);
        rememberDiagnostic({provider:plan.ai.provider,model:plan.ai.model,operationId,budget,result});
      }
      throw error;
    } finally {
      if (workloadSession.flush) await workloadSession.flush();
      else await workloadController.flush();
    }
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
    const rows = await mapBounded(
      (items || []).filter(item => String(item?.id || "")),
      FINGERPRINT_CONCURRENCY,
      async item => {
        const id = String(item.id);
        return {
          id,
          contentFingerprint: await fingerprintText(item?.text),
          scripts: summarizeScripts([{ id, text: String(item?.text || "") }])[0],
        };
      },
    );
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
      repair: { enabled: false, deferredToBatch: true },
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
      ...(error?.code === "ai_workload_budget_insufficient" ? {budget: error.diagnostics || {}} : {}),
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
  const wrongLanguageCount = unresolvedWrongLanguageIds.size;
  const overwhelminglyWrongLanguage =
    wrongLanguageCount > 0 &&
    wrongLanguageCount >= Math.ceil(sendable.length * 0.8);
  trace(
    "aiPageContract",
    {
      event: "final",
      outcome: overwhelminglyWrongLanguage || unresolvedIds.size >= sendable.length
        ? "failed" : unresolvedIds.size ? "partial" : "succeeded",
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
    Object.assign(telemetry, summarizeExecutionTiming(executionTimings));
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
    recordKind: "page_summary", children: childWireTraces.filter(r => r?.identity).map(r => ({
      operationId: r.identity.operationId, executionKey: r.identity.executionKey,
    })),
  });
  await flushWireTrace();
  return report;
}
