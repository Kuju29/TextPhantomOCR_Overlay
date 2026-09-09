import { applyRuntimeCapacityHints } from "./jobs/capacity-policy.js";
import { reportTranslationFailure } from "../shared/diagnostic-policy.js";
import { repairCoordinator } from "./repair/coordinator.js";
// Orchestrates a translation job from enqueue through submit, result handling and batch finalisation.

import { createLogger, setLogLevel } from "../shared/logger.js";
import { setLogShippingEnabled } from "../shared/log-sink.js";
import { getApiBase } from "./api.js";
import {
  ensureBatch,
  getBatch,
  batchMark,
  markImagePhase,
  markBatchInitialAi,
  batchUpdateToast,
  batchStopKeepAlive,
  batchPassStats,
} from "./batches.js";
import {
  classifyJobError,
  fetchImageDataUriFromUrl,
  fetchImageDataUriFromTab,
  selectBatchRetryCandidates,
} from "./images.js";
import { addTask } from "./job-queue.js";
import { imageKeyFromPayload, normImgSrc } from "./job-keys.js";
import {
  pendingByJob,
  pendingByImage,
  findContext,
  removeJob,
  rememberJob,
  restorePendingJobs,
} from "./job-registry.js";
import {
  getCachedDataUri,
  setCachedDataUri,
  isMangaDexPageUrl,
  mdKeyFromUrl,
  mdCacheKey,
  setCachedResult,
  stripImageFields,
} from "./mangadex.js";
import { accumulateSeriesMemory } from "./series-memory.js";
import { resolveSeriesKey } from "../shared/series.js";
import { bumpTabSession, getTabSessionId } from "./tab-sessions.js";
import { sendToTab } from "./tabs-messaging.js";
import { enqueueDomInsert } from "./insert-queue.js";
import { imageErrorMessage } from "./error-message.js";
import { attachTpError } from "../shared/error-contract.js";
import { pollJobViaRest } from "./transports/polling.js";
import { cancelJobsViaRest } from "./transports/cancel.js";
import { groupParagraphsWithArtifactFallback } from "./transports/groups.js";
import { fetchLensRawViaRest } from "./transports/lens.js";
import {
  capabilityFailureDetails,
  engineCompatibilityIssue,
  forgetCapabilities,
  getCapabilities,
  getFreshCapabilitiesForScope,
} from "./capabilities.js";
import {
  getTrace,
  newTraceId,
  note as traceNote,
  setTrace,
  setTracingEnabled,
} from "../shared/trace.js";
import * as wf from "./workflow-track.js";
import {
  canRenderFaithfully,
  translationUnits,
} from "../shared/lens-document.js";
import { aiLayoutDecision } from "../shared/lens-axis.js";
import {
  acquire,
  releaseSuccess,
  releaseRejected,
  releaseGated,
  releaseFailed,
} from "./scheduler.js";
import {
  isTextNoOverlaySkippable as evaluateTextNoOverlaySkippable,
  markNoTranslatableText,
  summarizeResultPresentation,
  aiPageFailure,
} from "./pipeline/result-policy.js";
import {
  isUrlOnlyPayload,
  shouldPrefetchDataUri as evaluateDataUriPrefetch,
} from "./pipeline/image-routing.js";
import {
  dispatchPreparedJob,
  payloadForFullServer as buildFullServerPayload,
} from "./pipeline/engine-routing.js";
import { buildEnqueuePolicy } from "./pipeline/enqueue-policy.js";
import { createJobPreparation } from "./pipeline/job-preparation.js";
import { createLensDirectPath } from "./pipeline/lens-direct.js";
import { createAiExecution } from "./pipeline/ai-execution.js";
import {
  runServerTranslation,
  submitAndPollServer,
} from "./pipeline/server-translation.js";
import {
  releaseBatchImageJobs,
  releaseTabImageJobs,
  scheduleOwnedImageJob,
  abortBatchInFlight,
  abortTabInFlight,
  beginInFlight,
  bumpSettingsEpoch,
  endInFlight,
  getCurrentBatchId,
  getSettingsEpoch,
  setCurrentBatchId,
} from "./jobs/lifecycle.js";
import { idempotencyKeyForPayload } from "./jobs/idempotency.js";
import {
  markDomainNeedsDataUri,
  shouldPrefetchDataUri as applyImageSourcePolicy,
} from "./jobs/image-source-policy.js";
import { createBatchRetryCoordinator } from "./jobs/batch-retry.js";
import { createResultDelivery } from "./jobs/result-delivery.js";

export { bumpSettingsEpoch, markDomainNeedsDataUri, setCurrentBatchId };

const log = createLogger("SW.jobs");
const reportFailure = (message, error, details = {}, traceId = "") =>
  reportTranslationFailure(log, (event, data, id) =>
    traceNote("background/jobs.js", event, data, id), message, error, details, traceId);

// Structural trace only: IDs, reading order and geometry. Never include OCR
// or translated strings, so TP_TRACE can diagnose reversal and rotation signs
// without exporting page dialogue.
function traceUnitLayout(doc, traceId, phase, imageId = "") {
  if (!traceId) return;
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : [];
  const paragraphById = new Map(
    paragraphs.map((paragraph) => [String(paragraph?.id || ""), paragraph]),
  );
  const groupByMember = new Map();
  for (const group of Array.isArray(doc?.canonicalOriginalTree?.paragraphs)
    ? doc.canonicalOriginalTree.paragraphs
    : []) {
    for (const id of group?.source?.documentParagraphIds || [])
      groupByMember.set(String(id), group);
  }
  const units = translationUnits(doc);
  for (let offset = 0; offset < units.length; offset += 10) {
    traceNote(
      "background/jobs.js",
      "unitLayout",
      {
        phase,
        imageId: String(imageId || ""),
        offset,
        units: units.slice(offset, offset + 10).map((unit, localIndex) => {
          const paragraphIds = (unit?.paragraphIds || []).map(String);
          const group = paragraphIds
            .map((id) => groupByMember.get(id))
            .find(Boolean);
          const members = paragraphIds.map((paragraphId) => {
            const paragraph = paragraphById.get(paragraphId);
            const rotations = (paragraph?.items || paragraph?.lensItems || [])
              .map((item) => Number(item?.box?.rotation_deg ?? item?.rotation))
              .filter(Number.isFinite);
            return {
              paragraphId,
              inputRotations: rotations,
              inputSigns: rotations.map((rotation) => Math.sign(rotation)),
            };
          });
          const memberRotations = members.flatMap(
            (member) => member.inputRotations,
          );
          const groupRotation = Number(group?.rotation);
          // Groups carry the server-selected output rotation. Ungrouped units
          // preserve Lens geometry, so the first finite member rotation is the
          // renderer's input rather than reporting an unhelpful null.
          const outputRotation = Number.isFinite(groupRotation)
            ? groupRotation
            : memberRotations[0];
          return {
            index: offset + localIndex,
            id: String(unit?.id || ""),
            paragraphIds,
            readingOrder: paragraphIds,
            members,
            direction: String(group?.direction || ""),
            outputRotation: Number.isFinite(outputRotation)
              ? outputRotation
              : null,
            outputSign: Number.isFinite(outputRotation)
              ? Math.sign(outputRotation)
              : null,
            outputRotationSource: Number.isFinite(groupRotation)
              ? "group"
              : "lens",
          };
        }),
      },
      traceId,
    );
  }
}

// Advances the canonical per-image progress record for a registered job.
// Keeping this lookup here lets stage owners report their real boundary without
// threading batch UI objects through Lens/grouping/AI internals.
function markJobPhase(jobId, phase, details = {}) {
  const ctx = pendingByJob.get(jobId);
  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(
    ctx?.imageKey || ctx?.metadata?.image_id || "",
  ).trim();
  if (!batchId || !imageKey) return null;
  return markImagePhase(batchId, imageKey, phase, details);
}

// Lens/grouping admission failures are safe to retry because the rejected request
// never entered the stage. Keep that backlog in the browser that owns the page
// instead of turning another user's burst into a permanent image error.
function isStageBackpressure(error) {
  const status = Number(error?.status) || 0;
  if (status !== 429 && status !== 503) return false;
  if (error?.permanent === true) return false;
  const code = String(error?.code || "");
  return (
    error?.retryable === true ||
    code === "server_busy" ||
    code === "lens_session_unavailable" ||
    code === "API_5XX" ||
    code === "API_BAD_RESPONSE" ||
    !code
  );
}

// Runs one extension-owned server stage in its own lane. A rejected admission
// releases the slot, observes Retry-After, and re-acquires later; it never holds
// a Lens slot while grouping waits or vice versa.
async function runStageInLane(
  key,
  work,
  { signal = null, stage = "", imageId = "", traceId = "", onGranted = null } = {},
) {
  let accumulatedQueueWaitMs = 0;
  let attempt = 0;
  while (true) {
    attempt++;
    const granted = await acquire(key, signal);
    accumulatedQueueWaitMs += Number(granted?.waitMs) || 0;
    if (typeof onGranted === "function") {
      try {
        await onGranted({
          lane: key, attempt, queueWaitMs: Number(granted?.waitMs) || 0,
          accumulatedQueueWaitMs,
        });
      } catch {}
    }
    const started = Date.now();
    try {
      const value = await work();
      releaseSuccess(key, Date.now() - started);
      return value;
    } catch (error) {
      if (error?.name === "AbortError") {
        releaseFailed(key);
        throw error;
      }
      if (!isStageBackpressure(error)) {
        releaseFailed(key);
        throw error;
      }
      const retryAfterMs = Math.max(50, Number(error?.retryAfterMs) || 1000);
      const code = String(error?.code || "");
      if (code === "server_busy" || Number(error?.status) === 429) {
        releaseRejected(key, retryAfterMs);
      } else {
        // Session refresh / other temporary service conditions are time waits,
        // not evidence that client concurrency itself was too high.
        releaseGated(key, retryAfterMs);
      }
      traceNote(
        "background/jobs.js",
        "imageStage",
        {
          stage,
          state: "requeued",
          imageId,
          lane: key,
          attempt,
          queueWaitMs: Number(granted?.waitMs) || 0,
          accumulatedQueueWaitMs,
          status: Number(error?.status) || 0,
          code,
          retryAfterMs,
          errorType: error?.name || "Error",
        },
        traceId,
      );
      await waitForRetry(retryAfterMs, signal);
    }
  }
}

const runLensDirectPath = createLensDirectPath({
  fetchFromUrl: fetchImageDataUriFromUrl,
  fetchFromTab: fetchImageDataUriFromTab,
  fetchLensRaw: fetchLensRawViaRest,
  groupParagraphs: groupParagraphsWithArtifactFallback,
  runStage: runStageInLane,
  markPhase: markJobPhase,
  trace: (event, data, traceId) =>
    traceNote("background/pipeline/lens-direct.js", event, data, traceId),
  traceLayout: traceUnitLayout,
  getTrace,
  log,
});

const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS = 3000;
const { finalizeBatch } = createBatchRetryCoordinator({
  retryGapMs: 1800,
  batchPassStats,
  selectRetryCandidates: selectBatchRetryCandidates,
  updateToast: batchUpdateToast,
  stopKeepAlive: batchStopKeepAlive,
  markImagePhase,
  batchMark,
  addTask,
  imageKeyFromPayload,
  normalizeImageKey: normImgSrc,
  getCachedDataUri,
  fetchImageDataUriFromUrl,
  setCachedDataUri,
  classifyJobError,
  enqueue,
  onComplete: async (batch, label) => {
    const owned = await repairCoordinator.finishInitial(batch);
    if (!owned) { batchUpdateToast(batch, batch.repair?.phase === 'unavailable'
      ? `${label}; repair unavailable: ${batch.repair.code || 'API/session error'}` : label, true); await batchStopKeepAlive(batch); }
  },
});
export { finalizeBatch };

const { failJobImmediately, handleStaleJob, handleJobError, handleResult } =
  createResultDelivery({
    accumulateSeriesMemory,
    batchUpdateToast,
    classifyJobError,
    enqueueDomInsert,
    ensureBatch,
    evaluateTextNoOverlaySkippable,
    finalizeBatch,
    findContext,
    getSettingsEpoch,
    getTabSessionId,
    imageErrorMessage,
    isUrlOnlyPayload,
    markDomainNeedsDataUri,
    markImagePhase,
    mdCacheKey,
    mdKeyFromUrl,
    normImgSrc,
    pendingByJob,
    removeJob,
    resolveSeriesKey,
    sendToTab,
    setCachedDataUri,
    setCachedResult,
    stripImageFields,
    summarizeResultPresentation,
    traceNote,
    workflow: wf,
    onDelivered: (ctx, ok) => repairCoordinator.markDelivered(ctx, ok),
    log,
  });
export { handleStaleJob, handleJobError, handleResult };

const { planLocalAi, runLocalAiInLane, waitForRetry } = createAiExecution({
  onCheckpoint: (batchId, data) => repairCoordinator.capture(batchId, data),
  log,
  markJobPhase,
  traceUnitLayout,
});

function shouldPrefetchDataUri(payload) {
  return applyImageSourcePolicy(payload, evaluateDataUriPrefetch);
}

// Processes one image payload end to end, from data-URI prefetch to the translate call.
export async function processJob(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;
  return processJobInner(payload, tabId, frameId);
}

async function processJobInner(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;

  if (!payload.metadata || typeof payload.metadata !== "object")
    payload.metadata = {};
  const batchId = String(
    payload.metadata.batch_id || getCurrentBatchId() || "",
  ).trim();
  if (batchId) payload.metadata.batch_id = batchId;
  // A batch may be cancelled after leaving the page but before this queued
  // function is admitted. Do not recreate workflow/status or contact Lens/AI.
  if (batchId && getBatch(batchId)?.cancelled) return;
  const imageKey = imageKeyFromPayload(payload);
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;
  let traceId = "";
  if (batch && imageKey) markImagePhase(batchId, imageKey, "waiting");

  const pageUrl = payload?.context?.page_url || "";
  const isMd = isMangaDexPageUrl(pageUrl);

  const originSession = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  const curSession = getTabSessionId(tabId);
  if (originSession && curSession && originSession !== curSession && !isMd) {
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "cancelled", {
        lastError: "navigation",
      });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
      batchStopKeepAlive(batch);
    }
    return;
  }

  if (batch && imageKey) {
    markImagePhase(batchId, imageKey, "scanning");
  }

  const workflowId = await wf.begin({
    itemId: imageKey || String(payload?.metadata?.image_id || ""),
    request: {
      mode: payload?.mode || "",
      lang: payload?.lang || "",
      source: payload?.source || "",
      src: String(payload?.src || "").slice(0, 300),
    },
    generation: {
      tabId,
      frameId,
      batchId,
      pageUrl,
      pageInstanceId: String(payload?.generation?.pageInstanceId || ""),
    },
  });

  const preparation = createJobPreparation({
    batchIsCancelled: () => Boolean(batchId && getBatch(batchId)?.cancelled),
    failWorkflow: (reason) => wf.failed(workflowId, reason),
    shouldPrefetch: shouldPrefetchDataUri,
    fetchFromTab: fetchImageDataUriFromTab,
    fetchFromUrl: fetchImageDataUriFromUrl,
    getCached: getCachedDataUri,
    setCached: setCachedDataUri,
    normalizeImageKey: normImgSrc,
    classifyError: classifyJobError,
    onDownloadStarted: () => {
      if (batch && imageKey) markImagePhase(batchId, imageKey, "downloading");
    },
    onPayloadUpdated: () => {
      if (batch && imageKey) batchMark(batchId, imageKey, { payload });
    },
    onPermanentReadError: async ({ message, code }) => {
      if (payload?.metadata?.image_id)
        pendingByImage.delete(payload.metadata.image_id);
      if (batch && imageKey) {
        markImagePhase(batchId, imageKey, "error", {
          lastError: message,
          permanent: true,
        });
        batchUpdateToast(batch, "Error (permanent)");
        finalizeBatch(batch);
      }
      await wf.failed(workflowId, `image could not be fetched: ${message}`);
      failJobImmediately(
        tabId,
        payload?.src || null,
        attachTpError(new Error(message), {
          code,
          origin: "extension",
          stage: "image_read",
          category: "input",
          retryable: false,
          diagnostic: message,
        }),
        frameId,
        traceId,
      );
    },
    logInfo: (message, details) => log.info(message, details),
    logWarn: (message, details) => log.warn(message, details),
  });
  const { stopIfBatchWasCancelled } = preparation;
  if (await stopIfBatchWasCancelled()) return;

  const base = await getApiBase();

  // getApiBase may yield to storage. Recheck immediately before the first
  // external prefetch and again later before registry/capability work.
  if (await stopIfBatchWasCancelled()) return;

  if (shouldPrefetchDataUri(payload)) {
    const outcome = await preparation.prefetchDataUri(payload, {
      tabId,
      frameId,
      pageUrl,
    });
    if (outcome.stopped) return;
  }

  await wf.mediaReady(workflowId);
  if (await stopIfBatchWasCancelled()) return;

  const sessionId = getTabSessionId(tabId) || bumpTabSession(tabId, pageUrl);

  // Builds the context record stored in the registry for this job.
  const makeContext = (extra = {}) => ({
    imgUrl: payload.src,
    tabId,
    frameId,
    mode: payload?.mode || null,
    lang: payload?.lang || null,
    source: payload?.source || null,
    metadata: payload.metadata,
    generation: payload.generation || null,
    batchId,
    imageKey,
    pageUrl,
    seriesKey: String(payload?.context?.series_key || "").trim(),
    sessionId: originSession || sessionId,
    workflowId,
    keepCacheOnStale: isMd,
    settingsEpoch: getSettingsEpoch(),
    traceId,
    ...extra,
  });

  // Create and stamp the trace before capability routing so a compatibility
  // stop and the registry context are correlated just like a request that
  // reaches either engine.
  traceId = newTraceId();
  if (!payload.context || typeof payload.context !== "object")
    payload.context = {};
  payload.context.tp_trace = traceId;
  setTrace(traceId);

  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, makeContext());
  }

  const capabilityScope = batchId
    ? `translation:${batchId}:pass:${Number(batch?.pass) || 1}`
    : `translation:${workflowId || traceId}`;
  const caps = await getFreshCapabilitiesForScope(base, capabilityScope);
  traceNote(
    "background/capabilities.js",
    "capabilityProbe",
    {
      origin: caps?.probe?.origin || "",
      durationMs: Number(caps?.probe?.durationMs) || 0,
      outcome: caps?.probe?.outcome || (caps?.reason ? "unavailable" : "ok"),
      status: Number(caps?.probe?.status) || 0,
      errorName: caps?.probe?.errorName || "",
    },
    traceId,
  );
  // Configure tracing from this API response before emitting a first-job
  // compatibility stop. Otherwise that event is lost until the second job.
  setLogLevel(caps.consoleLevel || "warn");
  setLogShippingEnabled(caps.logFile !== false, getApiBase, base, {
    authoritative: caps.logFile === true,
  });
  setTracingEnabled(
    caps.trace,
    getApiBase,
    caps.traceDetail,
    caps.traceSession,
    async () => {
      forgetCapabilities(base);
      return getCapabilities(base, { forceRefresh: true });
    },
  );

  const compatibilityIssue = engineCompatibilityIssue(payload, caps);
  if (compatibilityIssue) {
    traceNote(
      "background/jobs.js",
      "engineRoute",
      {
        engine: "extension",
        outcome: "stopped",
        reason: compatibilityIssue,
        mode: payload.mode,
        source: payload.source,
        syncPath: false,
      },
      traceId,
    );
    log.error("extension route stopped before legacy submit", {
      reason: compatibilityIssue,
    });
    await wf.failed(workflowId, compatibilityIssue);
    if (payload?.metadata?.image_id)
      pendingByImage.delete(payload.metadata.image_id);
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "error", {
        lastError: compatibilityIssue,
        permanent: true,
      });
      batchUpdateToast(batch, "Compatibility error");
      finalizeBatch(batch);
    }
    // A bare string reaches makeTpError() with no code, matches none of the
    // legacy patterns, and is rendered to the user as "unknown cause · UNKNOWN"
    // — the least useful sentence we can put on an image, for the one failure
    // whose cause we know exactly.
    failJobImmediately(
      tabId,
      payload?.src || null,
      attachTpError(new Error(compatibilityIssue), {
        ...capabilityFailureDetails(caps),
        diagnostic: compatibilityIssue,
      }),
      frameId,
      traceId,
    );
    return;
  }
  applyRuntimeCapacityHints(caps, payload);
  await sendToTab(
    tabId,
    {
      type: "TP_DIAGNOSTICS_STATE",
      enabled: caps.trace,
      detail: caps.traceDetail,
      consoleLevel: caps.consoleLevel || "warn",
    },
    frameId,
  );

  traceNote(
    "background/jobs.js",
    "runTranslateJob",
    {
      clientBuild: String(
        chrome?.runtime?.getManifest?.()?.version || "unknown",
      ),
      traceClientSchema: 2,
      mode: payload.mode,
      source: payload.source,
      // Which engine actually ran. Without this in the trace there is no way to
      // tell a working switch from a setting nothing read.
      engine: payload?.engine === "api" ? "api" : "extension",
      imageKey,
      batchId,
      workflowId,
      syncPath: caps.syncTranslate,
      background: payload?.render?.background,
      lensDocument: payload?.render?.lensDocument,
      pageImageToAi: Boolean(payload?.ai?.send_image),
      seriesMemoryMode: String(payload?.ai?.memory_mode || "off"),
      removeServerPacing: payload?.limits?.apiUnlimited === true,
      localAiCapacity: Number(payload?.limits?.manualConcurrency) || 1,
      aiThinking: String(payload?.ai?.thinking || "off") === "on",
      aiStyle: String(payload?.ai?.prompt || "").trim() ? "custom" : "empty",
    },
    traceId,
  );

  await dispatchPreparedJob(
    {
      base,
      payload,
      makeContext,
      capabilities: caps,
      dispatchOptions: { tabId, frameId, batch, batchId, imageKey, workflowId },
    },
    {
      dispatchSync: runSyncTranslate,
      dispatchLegacy: (legacyBase, legacyPayload, legacyMakeContext, options) =>
        submitAndPollServer(
          {
            base: legacyBase,
            payload: legacyPayload,
            makeContext: legacyMakeContext,
            ...options,
          },
          {
            batchUpdateToast,
            classifyJobError,
            failJobImmediately,
            finalizeBatch,
            handleJobError,
            markImagePhase,
            rememberJob,
          },
        ),
    },
  );
}

function payloadForFullServer(payload) {
  const renderPolicy = payload?.engine === "api" ? { lensDocument: false } : {};
  return buildFullServerPayload(payload, renderPolicy);
}
async function runSyncTranslate(
  base,
  payload,
  makeContext,
  {
    tabId,
    frameId,
    batch,
    batchId,
    imageKey,
    workflowId = "",
    capabilities = null,
  },
) {
  const aiPlan = await planLocalAi(payload).catch((e) => {
    log.warn("could not plan extension-first AI; this image will stop", {
      error: e?.message || String(e),
    });
    return null;
  });

  const jobId = crypto.randomUUID();

  try {
    payload.idempotency_key = await idempotencyKeyForPayload(payload);
  } catch {}
  rememberJob(
    jobId,
    makeContext({
      startedAt: Date.now(),
      base,
      transport: "sync",
      ...(aiPlan ? { source: aiPlan.originalSource } : {}),
    }),
  );

  const plan = aiPlan;

  // The user can put the whole pipeline back on the API. The extension then only
  // captures the image and inserts the result, exactly as the pre-v2 build did.
  const apiEngine = payload?.engine === "api";
  const mayUseLensDirect =
    !apiEngine && (payload.source !== "ai" || Boolean(plan));
  // Why the browser could not draw this image, filled in by runLensDirectPath.
  const decline = { reason: "" };

  await wf.lensRequested(workflowId, `lens-direct:${jobId}`);
  let lensDone = false;
  // Own failures by the stage that is actually running. The old catch always
  // reported Lens degradation, even after Lens had succeeded and the local AI
  // request was already in flight, producing the illegal transition
  // AI_REQUESTED -> LENS_DEGRADED and hiding the real provider failure.
  let directStage = "lens";
  try {
    if (!mayUseLensDirect) {
      if (apiEngine) {
        traceNote(
          "background/jobs.js",
          "engineRoute",
          {
            engine: "api",
            reason: "user selected the API server engine",
            mode: payload.mode,
            source: payload.source,
          },
          String(payload?.context?.tp_trace || getTrace() || ""),
        );
      }
      throw Object.assign(
        new Error(
          apiEngine ? "API engine selected" : "AI has no text-only route",
        ),
        { skipDirect: true },
      );
    }
    const lensCtrl = beginInFlight(jobId, tabId, batchId);
    let direct;
    try {
      const directPayload = payload;
      decline.reason = "";
      direct = await runLensDirectPath(base, directPayload, {
        tabId,
        frameId,
        jobId,
        signal: lensCtrl.signal,
        decline,
        capabilities,
      });
    } finally {
      endInFlight(jobId);
    }
    if (direct) {
      await wf.lensReady(workflowId);
      lensDone = true;
      if (plan) {
        directStage = "ai";
        const aiContext = pendingByJob.get(jobId);
        if (aiContext) aiContext.aiRouteEntered = true;
        await wf.aiRequested(workflowId, `ai-route:${jobId}`);
        const layoutDecision = aiLayoutDecision(
          direct.lensDocument,
          payload.lang,
        );
        log.info("AI layout stays in the extension", {
          ...layoutDecision,
          route: plan.route,
        });

        // Do not make an empty page wait behind real AI work. Lens has already
        // supplied the authoritative units here, so zero translatable units is
        // a terminal skip and needs neither a scheduler slot nor a provider call.
        const preAiUnits = translationUnits(direct.lensDocument);
        const hasTranslatableAiText = preAiUnits.some(
          (unit) => unit?.translatable,
        );
        if (!preAiUnits.length || !hasTranslatableAiText) {
          markNoTranslatableText(
            direct,
            preAiUnits.length ? "no_translatable_text" : "no_text",
          );
          traceNote(
            "background/jobs.js",
            "imageStage",
            {
              stage: "ai",
              state: "skipped",
              route: "extension",
              imageId: imageKey,
              reason: direct.meta.skipped_reason,
              queueWaitMs: 0,
              providerMs: 0,
            },
            String(payload?.context?.tp_trace || ""),
          );
          markBatchInitialAi(batchId, imageKey);
          await wf.textReady(workflowId);
          await handleResult(jobId, direct);
          return;
        }

        const aiCtrl = beginInFlight(jobId, tabId, batchId);
        const aiRunning = runLocalAiInLane(
          base,
          payload,
          direct,
          plan,
          batchId,
          aiCtrl.signal,
          () => {
            const c = pendingByJob.get(jobId);
            if (c) c.aiGenerationAttempted = true;
          },
          jobId,
          capabilities,
        ).finally(() => endInFlight(jobId));
        aiRunning.catch(() => {});

        const aiOutcome = await aiRunning;
        // A page Lens read as digits or symbols only has no AI layer to be faithful to; it is skipped.
        if (aiOutcome?.usable && direct?.meta?.skipped_reason) {
          await wf.textReady(workflowId);
          await handleResult(jobId, direct);
          return;
        }
        const finalFidelity = aiOutcome?.usable
          ? canRenderFaithfully(direct.lensDocument, "ai")
          : {
              ok: false,
              reason: aiOutcome?.reason || "AI produced no usable translation",
            };
        if (!aiOutcome?.usable || !finalFidelity.ok) {
          const reason = aiOutcome?.usable
            ? `extension AI geometry was not faithful: ${finalFidelity.reason}`
            : aiOutcome?.reason ||
              "AI produced no usable translation; no automatic retry was made";
          const failure = aiPageFailure(aiOutcome);
          reportFailure(
            "extension-first AI stopped without invoking the full image pipeline",
            {code: failure.code}, {reason, stage: failure.stage, jobId},
          );
          await wf.failed(workflowId, reason);
          handleJobError(
            jobId,
            attachTpError(new Error(reason), {
              code: failure.code,
              origin: "extension",
              stage: failure.stage,
              retryable: false,
            }),
          );
          return;
        }
        if (!aiOutcome.complete) {
          traceNote("background/jobs.js", "aiPartial", {
              event: "extension-first AI is inserting a partial single response",
              translated: aiOutcome.translated,
              missingUnitIds: aiOutcome.missing,
              automaticContentRetry: false,
            },
          );
        }
        log.info("tp.route", {
          stage: "text",
          outcome: "new",
          reason: "",
          route: plan.route,
          source: plan.originalSource,
          lens: "direct",
        });
      }
      directStage = "postprocess";
      await wf.textReady(workflowId);
      await handleResult(jobId, direct);
      return;
    } else {
      await wf.lensDegraded(workflowId, "lens direct declined this image");
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      return;
    }
    // Preserve the structured Local-AI error through the route-decline path.
    // Keeping only its message used to discard codes such as timeout and
    // thinking-without-final-answer, so the image badge fell back to UNKNOWN.
    decline.error = e;
    if (!e?.skipDirect) {
      reportFailure("the extension route threw before it could draw", e, {
        stage: directStage,
        error: e?.message || String(e),
      });
      if (!decline.reason)
        decline.reason = `the extension route threw: ${e?.message || String(e)}`;
    }
    const failureReason = e?.message || String(e);
    if (directStage === "ai") {
      // No alternate AI route is attempted here: record the correct degraded
      // stage, then let the extension-engine stop below with the same reason.
      // This preserves the one-provider-call contract.
      await wf.aiDegraded(workflowId, `local AI threw: ${failureReason}`);
    } else if (directStage === "lens") {
      await wf.lensDegraded(workflowId, `lens direct threw: ${failureReason}`);
    } else {
      // Lens and AI have already completed. An insertion/preparation failure is
      // terminal and must not masquerade as either route degrading or trigger a
      // second pipeline.
      await wf.failed(
        workflowId,
        `extension postprocess threw: ${failureReason}`,
      );
      handleJobError(jobId, e);
      return;
    }
  }

  // The extension engine does not quietly hand a text page to the server. When the
  // browser cannot draw it, that is a failure with a reason, not a different engine:
  // a page that silently arrives rendered by the API looks like the engine switch did
  // nothing, and the grouping failure behind it never gets seen. `lens_images` is unaffected
  // (its only route has always been `/v1/translate`), and so is the API engine, where
  // the server owning the whole pipeline is the point.
  if (!apiEngine && payload.mode === "lens_text") {
    const reason =
      decline.reason ||
      (payload.source === "ai"
        ? "extension-first AI could not obtain a faithful LensDocument"
        : "the extension route declined this image");
    traceNote(
      "background/jobs.js",
      "engineRoute",
      {
        engine: "extension",
        outcome: "stopped",
        reason,
        mode: payload.mode,
        source: payload.source,
      },
      String(payload?.context?.tp_trace || getTrace() || ""),
    );
    await wf.failed(workflowId, reason);
    handleJobError(jobId, decline.error || reason);
    return;
  }

  return runServerTranslation(
    {
      base,
      payload,
      jobId,
      tabId,
      frameId,
      batchId,
      imageKey,
      workflowId,
      capabilities,
      lensDone,
      apiEngine,
    },
    {
      beginInFlight,
      endInFlight,
      fetchImageDataUriFromTab,
      fetchImageDataUriFromUrl,
      handleJobError,
      handleResult,
      log,
      markDomainNeedsDataUri,
      markJobPhase,
      payloadForFullServer,
      rememberJob,
      releaseJob: removeJob,
      waitForRetry,
    },
  );
}

// Resumes REST long-polls after a Manifest V3 service-worker restart.
export async function resumePendingRestJobs() {
  const jobIds = await restorePendingJobs();
  for (const jobId of jobIds) {
    const ctx = pendingByJob.get(jobId);
    const base = String(ctx?.base || "").trim();
    if (!base) continue;
    // Synchronous extension/cloud calls are not JobQueue IDs. Never long-poll
    // a synthetic ID or resend a generation after a worker restart.
    if (ctx.transport === "sync") {
      traceNote("background/jobs.js", "translationInterrupted", {
        jobId, batchId:ctx.batchId, stage:"worker_restarted", automaticResend:false,
      }, String(ctx.traceId || ""));
      removeJob(jobId, ctx.metadata?.image_id);
      continue;
    }
    addTask(
      () =>
        pollJobViaRest(base, jobId, {
          session: String(ctx?.sessionId || ""),
        }).catch((e) => handleJobError(jobId, e)),
      { shouldStart: () => pendingByJob.has(jobId) },
    );
  }
}

// Queues a payload for processing, skipping it when its tab session is already stale.
export function enqueue(payload, tabId, frameId = 0) {
  const enqueuePolicy = buildEnqueuePolicy(payload, tabId, {
    getTabSessionId,
    getBatch,
  });
  const isAdmissible = enqueuePolicy.shouldStart;
  return scheduleOwnedImageJob({
    identity: {
      batchId: String(payload?.metadata?.batch_id || getCurrentBatchId() || ""),
      imageKey: imageKeyFromPayload(payload),
      sessionId: String(payload?.context?.tp_tab_session ||
        payload?.metadata?.tp_tab_session || getTabSessionId(tabId) || ""),
      engine: payload?.engine === "api" ? "api" : "extension",
      settingsEpoch: getSettingsEpoch(),
      tabId,
    },
    isAdmissible,
    schedule: addTask,
    work: () => processJob(payload, tabId, frameId),
    // Extension orchestration is governed by its Lens/AI lanes.
    laneManaged: payload?.engine !== "api",
  });
}

// Cancels every in-flight job for a tab, on the extension and on the server.
export function cancelTabWork(tabId, reason = "navigation", sessionId = "") {
  if (!Number.isFinite(tabId)) return;
  void repairCoordinator.cancelTab(tabId, reason);
  releaseTabImageJobs(tabId);
  const msg = String(reason || "navigation");
  const cancelledJobIds = [];
  const cancelledBatchIds = new Set();

  for (const [jobId, ctx] of Array.from(pendingByJob.entries())) {
    if ((ctx?.tabId || 0) !== tabId) continue;
    const batchId = String(
      ctx?.batchId || ctx?.metadata?.batch_id || "",
    ).trim();
    const imageKey = String(
      ctx?.imageKey || ctx?.metadata?.image_id || "",
    ).trim();
    const batch = batchId
      ? ensureBatch(batchId, tabId, ctx?.frameId || 0)
      : null;
    if (batchId) cancelledBatchIds.add(batchId);

    cancelledJobIds.push(jobId);
    traceNote(
      "background/jobs.js",
      "jobCancellation",
      {
        reason: msg,
        jobId: String(jobId),
        batchId,
        imageId: String(ctx?.metadata?.image_id || ""),
        cancelRequestedAt: Date.now(),
        extensionAbortRequested: true,
        serverCancellation: "requested_after_local_cleanup",
      },
      String(ctx?.traceId || ""),
    );
    removeJob(jobId, ctx?.metadata?.image_id);

    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "cancelled", { lastError: msg });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
      batchStopKeepAlive(batch);
    }
  }

  for (const [imageId, rec] of Array.from(pendingByImage.entries())) {
    if ((rec?.tabId || 0) === tabId) pendingByImage.delete(imageId);
  }

  const stopped = abortTabInFlight(tabId, "tp:cancelled");
  if (!cancelledJobIds.length && stopped) {
    traceNote("background/jobs.js", "jobCancellation", {
      reason: msg,
      tabId,
      extensionAbortRequested: true,
      abortedInFlight: stopped,
      providerAbortObservedAt: Date.now(),
      serverCancellation: "not_correlatable_no_registered_job",
    });
  }
  if (stopped)
    log.info("stopped in-flight requests for a gone tab", {
      tabId,
      stopped,
      reason: msg,
    });

  wf.cancelTab(tabId, msg);

  if (cancelledJobIds.length || cancelledBatchIds.size) {
    if (cancelledBatchIds.size) {
      for (const batchId of cancelledBatchIds) {
        cancelJobsViaRest({
          jobIds: cancelledJobIds,
          batchId,
          session: sessionId || getTabSessionId(tabId) || "",
        });
      }
    } else {
      cancelJobsViaRest({
        jobIds: cancelledJobIds,
        session: sessionId || getTabSessionId(tabId) || "",
      });
    }
  }
}

// Marks a batch's unfinished items as aborted so their results are never shown.
export function discardBatchResults(batchId, reason = "user_cancelled") {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  void repairCoordinator.cancelBatch(bid, reason);
  releaseBatchImageJobs(bid);
  const batch = ensureBatch(bid, 0, 0);
  batch.cancelled = true;
  batch.cancelRequestedAt = Date.now();
  abortBatchInFlight(bid, "tp:cancelled");
  for (const [key, item] of batch.items.entries()) {
    if (["done", "error", "aborted", "skipped"].includes(item?.status))
      continue;
    markImagePhase(bid, key, "cancelled", { lastError: reason });
  }
  batchUpdateToast(batch, "Cancelled", true);
  batchStopKeepAlive(batch);
}
