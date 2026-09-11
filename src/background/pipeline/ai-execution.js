import { updateImagePresentation } from "../batches.js";
import { attachTpError } from "../../shared/error-contract.js";
import { classifyAiRuntime } from "../../shared/ai-settings-contract.js";
import { shouldUseDirectLocalAi } from "../../shared/ai/direct-local/route-policy.js";
import { getTrace, note as traceNote } from "../../shared/trace.js";
import { translationUnits } from "../../shared/lens-document.js";
import { imageKeyFromPayload } from "../job-keys.js";
import {
  getBatch,
  markBatchInitialAi,
  markLocalAiStreamProgress,
  waitForBatchInitialAi,
} from "../batches.js";
import { isLocalAiPayload } from "../local-capacity.js";
import {
  acquire,
  releaseSuccess,
  releaseReplay,
  releaseRejected,
  releaseDeferred,
  releaseGated,
  releaseFailed,
  releaseLocalFailure,
  laneKeyFor,
  describe as describeLane,
  setLaneUnlimited,
  configureLocalCapacityForPayload,
} from "../scheduler.js";
import { planAiRoute } from "./engine-routing.js";
import { translateLensPage } from "./page-translation.js";

function isRateGateBusy(error) {
  const code = String(error?.code || "");
  return code === "rate_gate_busy" || code === "local_rate_gate_busy";
}

export function releaseAiLaneFailure(
  key,
  payload,
  error,
  { retryAfterMs = 250, serverRetryMs = retryAfterMs } = {},
) {
  const code = String(error?.code || "");
  const gated = isRateGateBusy(error);
  const providerBackpressure = code === "provider_rate_limited";
  const serverDeferred = code === "server_busy";
  const generationAttempts = Number(
    error?.generationAttempts || error?.providerAttempts || 0,
  );
  const backpressure =
    Number(error?.status) === 429 ||
    Number(error?.status) === 503 ||
    providerBackpressure;

  if (gated) releaseGated(key, retryAfterMs);
  else if (isLocalAiPayload(payload))
    releaseLocalFailure(key, error, retryAfterMs);
  else if (generationAttempts === 0 && backpressure)
    releaseDeferred(key, retryAfterMs);
  else if (providerBackpressure) releaseRejected(key, retryAfterMs);
  else if (serverDeferred) releaseDeferred(key, serverRetryMs);
  else if (backpressure) releaseRejected(key, retryAfterMs);
  else releaseFailed(key);

  return { gated, providerBackpressure, serverDeferred, generationAttempts };
}

export function createAiExecution({ log, markJobPhase, traceUnitLayout, onCheckpoint = async () => {} }) {
  async function planLocalAi(payload) {
    const ai = payload?.ai && typeof payload.ai === "object" ? payload.ai : null;
    const classification = classifyAiRuntime({
      aiProvider: ai?.provider,
      aiBaseUrl: ai?.base_url,
    });
    if (classification.conflict) {
      throw attachTpError(
        new Error(
          "The selected Cloud AI provider has a Local AI endpoint. Save the Provider's Cloud endpoint before translating.",
        ),
        {
          code: "ai_provider_endpoint_conflict",
          category: "configuration",
          origin: "user",
          stage: "ai_routing",
          retryable: false,
        },
      );
    }
    const direct = shouldUseDirectLocalAi(
      payload?.engine,
      ai?.provider,
      ai?.base_url,
    );
    const plan = planAiRoute(payload, direct);
    if (!plan) return null;
    log.info(
      plan.route === "server"
        ? "AI will use the text-only API"
        : "AI will run in the browser",
      {
        route: plan.route,
        reason: plan.reason,
        provider: String(ai?.provider || "auto"),
        model: String(ai?.model || "auto"),
        runtime: classification.runtime,
        classificationReason: classification.reason,
      },
    );
    return plan;
  }
  
  // Thin integration boundary: per-image translation lives in pipeline/page-translation.js.
  async function runLocalAi(
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
  ) {
    const traceId = String(payload?.context?.tp_trace || getTrace() || "");
    return translateLensPage({
      base,
      payload,
      result,
      plan,
      cancelBatchId,
      signal,
      telemetry,
      onGenerationAttempt,
      jobId,
      beforeRepair,
      capabilities,
      onCheckpoint: data => onCheckpoint(cancelBatchId, data),
      onStatus: patch => updateImagePresentation(cancelBatchId, imageKeyFromPayload(payload), patch),
      isCancelled: () =>
        signal?.aborted === true ||
        Boolean(cancelBatchId && getBatch(cancelBatchId)?.cancelled),
      onStreamProgress: ({state}) => {
        if (["usage_pending", "http_wait", "validating"].includes(state))
          updateImagePresentation(cancelBatchId, imageKeyFromPayload(payload), {phase:state});
        else if (plan.route === "direct-local") markLocalAiStreamProgress(cancelBatchId, imageKeyFromPayload(payload), state);
      },
      trace: (event, data, eventTraceId = traceId) =>
        traceNote("background/jobs.js", event, data, eventTraceId || traceId),
      traceLayout: (document, eventTraceId, phase, imageId) =>
        traceUnitLayout(document, eventTraceId || traceId, phase, imageId),
      log,
    });
  }
  
  // Abortable delay used only for safe no-generation orchestration retries.
  async function waitForRetry(ms, signal) {
    const base = Math.max(0, Math.floor(Number(ms) || 0));
    if (base <= 0) return;
    // A small positive jitter prevents many browsers rejected by the same full HF
    // worker pool from waking on the same millisecond and recreating the burst.
    // Keep it small enough that it never becomes meaningful user-visible pacing.
    const jitter =
      base >= 100 ? Math.floor(Math.random() * Math.min(500, base * 0.2)) : 0;
    const delay = base + jitter;
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }
  
  // True only when the server says the model was NOT called. These are safe
  // orchestration retries with the same Idempotency-Key, not model retries.
  function isSafeNoGenerationBackpressure(error) {
    if (Number(error?.generationAttempts || 0) !== 0) return false;
    const code = String(error?.code || "");
    return (
      code === "rate_gate_busy" ||
      code === "local_rate_gate_busy" ||
      code === "server_busy" ||
      code === "provider_rate_limited"
    );
  }
  
  async function runLocalAiInLane(
    base,
    payload,
    result,
    plan,
    batchId,
    signal,
    onGenerationAttempt = null,
    jobId = "",
    capabilities = null,
  ) {
    const key = laneKeyFor(payload);
    // Removing RPM/time pacing is independent from generation concurrency.
    // Capacity is selected per runtime endpoint + model, never globally.
    const localCapacity = configureLocalCapacityForPayload(payload);
    if (!localCapacity) {
      setLaneUnlimited(key, false);
      // Cloud lanes were already pinned to the API's advertised executable
      // capacity by applyRuntimeCapacityHints(). Clearing that ceiling here
      // made every successful request widen the browser lane back toward 64,
      // overfilling the server's 24 active + bounded-waiter admission gate.
      // Local lanes have their own key and policy, so cloud setup must leave
      // the server-owned ceiling intact.
    }
    const unlimited = false;
    const traceId = String(payload?.context?.tp_trace || getTrace() || "");
    const imageId = String(payload?.metadata?.image_id || "");
    const barrierImageKey = imageKeyFromPayload(payload);
    let orchestrationAttempts = 0;
    let accumulatedQueueWaitMs = 0;
    let providerBackpressureSince = 0;
  
    while (true) {
      orchestrationAttempts++;
      markJobPhase(jobId, "ai_queued");
      traceNote(
        "background/jobs.js",
        "imageStage",
        {
          stage: "ai",
          state: "queued",
          route: "extension",
          imageId,
          orchestrationAttempts,
        },
        traceId,
      );
  
      const slot = await acquire(key, signal);
      traceNote("background/pipeline/ai-execution.js", "imageAiLane", {
        schema:"tp.audit/1", event:"capacity_selected", reason:"initial",
        scope:{imageId,ref:slot?.diagnosticLaneId},
        after:{window:slot?.window,ceiling:slot?.maxWindow,running:slot?.running},
        timing:{queueMs:slot?.waitMs},
      }, traceId);
      markJobPhase(jobId, "ai_generating");
      const queueWaitMs = Number(slot?.waitMs) || 0;
      accumulatedQueueWaitMs += queueWaitMs;
      traceNote(
        "background/jobs.js",
        "imageStage",
        {
          stage: "ai",
          state: "started",
          route: "extension",
          imageId,
          queueWaitMs,
          accumulatedQueueWaitMs,
          window: Number(slot?.window) || 0,
          maxWindow: Number(slot?.maxWindow) || 0,
          unlimited,
          orchestrationAttempts,
        },
        traceId,
      );
  
      const started = Date.now();
      let laneStarted = started;
      const telemetry = {};
      let slotHeld = true;
      try {
        const beforeRepair = async () => {
          // A repair must not occupy scarce provider capacity while sibling
          // images are still making their first attempt. Release, join the
          // current batch-pass barrier, then reacquire for the single repair.
          releaseSuccess(key, Math.max(1, Date.now() - laneStarted));
          slotHeld = false;
          const barrierRequired = Boolean(String(batchId || "").trim());
          const barrierBatch = getBatch(batchId);
          const barrierPass = Number(barrierBatch?.pass) || 0;
          await waitForBatchInitialAi(batchId, barrierImageKey, signal);
          const currentBatch = getBatch(batchId);
          const barrierExpired =
            barrierRequired && (
              !barrierBatch ||
              !currentBatch ||
              currentBatch !== barrierBatch ||
              Number(currentBatch?.pass) !== barrierPass);
          if (signal?.aborted || currentBatch?.cancelled || barrierExpired) {
            traceNote(
              "background/jobs.js",
              "jobCancellation",
              {
                batchId,
                imageId,
                repairSuppressedByCancel: true,
                repairBarrierExpired: barrierExpired,
                cancelRequestedAt: Date.now(),
              },
              traceId,
            );
            throw new DOMException("The operation was aborted", "AbortError");
          }
          const repairSlot = await acquire(key, signal);
          const repairQueueWaitMs = Number(repairSlot?.waitMs) || 0;
          accumulatedQueueWaitMs += repairQueueWaitMs;
          laneStarted = Date.now();
          slotHeld = true;
        };
        const done = await runLocalAi(
          base,
          payload,
          result,
          plan,
          batchId,
          signal,
          telemetry,
          onGenerationAttempt,
          jobId,
          beforeRepair,
          capabilities,
        );
        // Clean/partial-complete images never enter beforeRepair, so publish
        // their initial terminal boundary before the caller starts rendering.
        markBatchInitialAi(batchId, barrierImageKey);
        const roundTripMs = Date.now() - started;
        const serverWaitMs =
          (Number.isFinite(telemetry.rateWaitMs) ? telemetry.rateWaitMs : 0) +
          (Number.isFinite(telemetry.admissionWaitMs)
            ? telemetry.admissionWaitMs
            : 0);
        const replayed = telemetry.replayed === true;
        const reportedProviderMs =
          Number.isFinite(telemetry.providerMs) && telemetry.providerMs > 0
            ? telemetry.providerMs
            : 0;
        const providerMs = replayed
          ? 0
          : reportedProviderMs > 0
            ? reportedProviderMs
            : Math.max(1, Date.now() - laneStarted - serverWaitMs);
        const serverTotalMs =
          Number.isFinite(telemetry.serverTotalMs) && telemetry.serverTotalMs > 0
            ? telemetry.serverTotalMs
            : 0;
        const transportProxyMs =
          replayed || serverTotalMs <= 0
            ? 0
            : Math.max(0, roundTripMs - serverTotalMs);
        const latencySource = replayed
          ? "idempotent-replay"
          : reportedProviderMs > 0
            ? "server.providerMs"
            : "roundTrip-minus-serverWait";
        // A ledger replay did not call the provider now. Do not pollute the
        // scheduler's latency telemetry with the original generation's duration.
        if (slotHeld) {
          if (replayed) releaseReplay(key);
          else releaseSuccess(key, providerMs);
          slotHeld = false;
        }
        const rpmNow = Number(telemetry.rate?.rpm) || 0;
        const ceiling = Number(describeLane(key)?.effectiveMax) || 0;
        traceNote(
          "background/jobs.js",
          "imageStage",
          {
            stage: "ai",
            state: "finished",
            route: "extension",
            imageId,
            queueWaitMs,
            accumulatedQueueWaitMs,
            providerMs,
            reportedProviderMs,
            roundTripMs,
            serverWaitMs,
            serverTotalMs,
            transportProxyMs,
            replayed,
            latencySource,
            rpmNow,
            laneCeiling: ceiling,
            orchestrationAttempts,
            usable: done?.usable === true,
            complete: done?.complete === true,
            missingUnitIds: Array.isArray(done?.missing) ? done.missing : [],
          },
          traceId,
        );
        return done;
      } catch (e) {
        const status = Number(e?.status) || 0;
        const code = String(e?.code || "");
        const gated = isRateGateBusy(e);
        const providerBackpressure = code === "provider_rate_limited";
        const serverDeferred = code === "server_busy";
        if (providerBackpressure && !providerBackpressureSince)
          providerBackpressureSince = Date.now();
        if (!providerBackpressure) providerBackpressureSince = 0;
        const providerBackpressureMs = providerBackpressureSince
          ? Math.max(0, Date.now() - providerBackpressureSince)
          : 0;
        const retryableBeforeProvider = isSafeNoGenerationBackpressure(e);
        const backpressure =
          status === 429 || status === 503 || providerBackpressure;
        const retryAfterMs = Math.max(50, Number(e?.retryAfterMs) || 250);
        // A full shared HF process should never become a hot 503 loop across many
        // browsers. Keep the work client-side, preserve provider concurrency, and
        // spread retries exponentially (capped) until a real server slot opens.
        const serverRetryMs = serverDeferred
          ? Math.min(
              5000,
              Math.max(
                retryAfterMs,
                300 * 2 ** Math.min(4, orchestrationAttempts - 1),
              ),
            )
          : retryAfterMs;
  
        const generationAttempts = Number(
          e?.generationAttempts || e?.providerAttempts || 0,
        );
        if (slotHeld) {
          releaseAiLaneFailure(key, payload, e, {
            retryAfterMs,
            serverRetryMs,
          });
          slotHeld = false;
        }
  
        traceNote(
          "background/jobs.js",
          "imageStage",
          {
            stage: "ai",
            state: retryableBeforeProvider ? "requeued" : "failed",
            route: "extension",
            imageId,
            queueWaitMs,
            accumulatedQueueWaitMs,
            providerMs: Date.now() - started,
            status,
            backpressure,
            gated,
            retryableBeforeProvider,
            providerBackpressure,
            providerBackpressureMs,
            retryAfterMs,
            serverRetryMs,
            orchestrationAttempts,
            code,
            providerAttempts: Number(e?.providerAttempts || 0),
            generationAttempts: Number(e?.generationAttempts || 0),
            errorType: e?.name || "Error",
          },
          traceId,
        );
  
        if (!retryableBeforeProvider || signal?.aborted) throw e;
        // The lane itself may already be paused until Retry-After. Shared-server
        // pressure gets a progressively wider client-side retry delay so many
        // browsers do not synchronize into a hot 503 loop.
        await waitForRetry(serverDeferred ? serverRetryMs : retryAfterMs, signal);
      }
    }
  }
  
  // Translates one image with `POST /v1/translate`, taking a scheduler slot and reporting how it was released.
  return { planLocalAi, runLocalAiInLane, waitForRetry };
}
