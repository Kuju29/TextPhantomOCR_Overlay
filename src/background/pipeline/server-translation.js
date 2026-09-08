import { getTrace, note as traceNote } from "../../shared/trace.js";
import {
  failureUsageDetails,
  persistProviderGeneration,
} from "../../shared/ai-usage.js";
import { isLocalAiPayload } from "../local-capacity.js";
import { normImgSrc } from "../job-keys.js";
import { pendingByImage } from "../job-registry.js";
import { setCachedDataUri } from "../mangadex.js";
import {
  acquire,
  configureLocalCapacityForPayload,
  describe as describeLane,
  laneKeyFor,
  releaseDeferred,
  releaseFailed,
  releaseGated,
  releaseLocalFailure,
  releaseRejected,
  releaseReplay,
  releaseSuccess,
} from "../scheduler.js";
import { pollJobViaRest } from "../transports/polling.js";
import {
  submitJobViaRest,
  translateViaSyncRest,
} from "../transports/translate.js";
import * as wf from "../workflow-track.js";
import { idempotencyKeyForPayload } from "../jobs/idempotency.js";
import { withPipelineStage } from "../jobs/batch-retry.js";

function rateGateBusy(error) {
  const code = String(error?.code || "");
  return code === "rate_gate_busy" || code === "local_rate_gate_busy";
}

export async function runServerTranslation(input, deps) {
  const {
    base,
    jobId,
    tabId,
    frameId,
    batchId,
    // imageKey,
    workflowId,
    capabilities,
  } = input;
  let { payload, lensDone = false } = input;
  const {
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
    // rememberJob,
    releaseJob,
    waitForRetry,
  } = deps;
  let browserImageFallbackUsed = false;
  let serverRequestTracked = false;
  for (let attempt = 0; ; attempt++) {
    const outbound = payloadForFullServer(payload);
    try {
      outbound.idempotency_key = await idempotencyKeyForPayload(outbound);
    } catch {
      delete outbound.idempotency_key;
    }
    const requestLane = laneKeyFor(outbound);
    const localRequest = isLocalAiPayload(outbound);
    configureLocalCapacityForPayload(outbound);
    const ctrl = beginInFlight(jobId, tabId, batchId);
    let slotHeld = false;
    let queueWaitMs = 0;
    const t0 = Date.now();
    let requestStartedAt = 0;
    const traceId = String(payload?.context?.tp_trace || getTrace() || "");
    const imageId = String(payload?.metadata?.image_id || "");
    traceNote(
      "background/pipeline/server-translation.js",
      "imageStage",
      {
        stage: "ai",
        state: "queued",
        route: "api",
        imageId,
      },
      traceId,
    );
    try {
      markJobPhase(
        jobId,
        input.apiEngine && !lensDone
          ? "server_processing"
          : lensDone
            ? "ai_queued"
            : "lens",
        input.apiEngine && !lensDone
          ? { stage: "Server processing (Lens/AI)" }
          : {},
      );
      const slot = await acquire(requestLane, ctrl.signal);
      if (lensDone) markJobPhase(jobId, "ai_generating");
      queueWaitMs = Number(slot?.waitMs) || 0;
      requestStartedAt = Date.now();
      slotHeld = true;
      traceNote(
        "background/pipeline/server-translation.js",
        "imageStage",
        {
          stage: "ai",
          state: "started",
          route: "api",
          imageId,
          queueWaitMs,
          window: Number(slot?.window) || 0,
          maxWindow: Number(slot?.maxWindow) || 0,
          unlimited: slot?.unlimited === true,
        },
        traceId,
      );
      if (!serverRequestTracked) {
        if (lensDone) await wf.aiRequested(workflowId, `ai-server:${jobId}`);
        else await wf.lensRequested(workflowId, `sync:${jobId}`);
        serverRequestTracked = true;
      }
      let result;
      if (outbound?.ai?.provider && !ctrl.signal.aborted)
        await persistProviderGeneration({ pending: true, operationId: String(outbound.idempotency_key || ""),
          engine: "runsapi", runtime: localRequest ? "local" : "cloud",
          provider: outbound.ai.provider, model: outbound.ai.model });
      try {
        result = await translateViaSyncRest(base, outbound, {
          signal: ctrl.signal,
          jobId,
          imageId,
          batchId,
          capabilities,
        });
      } finally {
        endInFlight(jobId);
      }
      const requestMs = Date.now() - requestStartedAt;
      const serverProcessingMs = Number(result?.perf?.total_ms) || 0;
      const transportProxyMs =
        serverProcessingMs > 0
          ? Math.max(0, requestMs - serverProcessingMs)
          : 0;
      const replayed =
        result?.replayed === true ||
        result?.perf?.replayed === true ||
        result?.perf?.replayedFromLedger === true;
      const aiMeta =
        result?.Ai?.meta && typeof result.Ai.meta === "object"
          ? result.Ai.meta
          : {};
      const responseCached = result?.perf?.cache === "hit";
      if (responseCached || !aiMeta.provider || !aiMeta.model)
        await persistProviderGeneration({ resolvePending: true, engine: "runsapi", operationId: String(outbound.idempotency_key || "") });
      if (!responseCached && aiMeta.provider && aiMeta.model)
        await persistProviderGeneration(
          {
            runtime: localRequest ? "local" : "cloud",
            provider: aiMeta.provider,
            model: aiMeta.model,
            engine: "runsapi",
            generationAttempts: Math.max(
              1,
              Number(aiMeta.generation_attempts) || 1,
            ),
            reason: aiMeta.repair_attempted ? "repair" : "translation_success",
            operationId: String(outbound?.idempotency_key || ""),
            traceId,
            requestId: String(aiMeta.request_id || result?.requestId || ""),
            replayed,
            startedAt: requestStartedAt,
            requests: Math.max(1, Number(aiMeta.generation_attempts) || 1),
            usage: aiMeta.usage,
            inputTokens: aiMeta.usage?.inputTokens,
            outputTokens: aiMeta.usage?.outputTokens,
            totalTokens: aiMeta.usage?.totalTokens,
            sourceChars: String(result?.originalTextFull || "").length,
            translatedUnits: Number(aiMeta.units) || 0,
            providerMs: aiMeta.provider_ms ?? result?.perf?.ai_ms,
            totalMs: result?.perf?.total_ms,
          },
          {
            emitTrace: (name, data) =>
              traceNote(
                "background/pipeline/server-translation.js",
                name,
                data,
                traceId,
              ),
          },
        );
      if (replayed) releaseReplay(requestLane);
      else {
        const localProviderMs = Math.max(0, Number(aiMeta.provider_ms ?? result?.perf?.ai_ms) || 0);
        releaseSuccess(requestLane, localRequest && localProviderMs > 0 ? localProviderMs : requestMs);
      }
      slotHeld = false;
      traceNote(
        "background/pipeline/server-translation.js",
        "imageStage",
        {
          stage: "ai",
          state: "finished",
          route: "api",
          imageId,
          queueWaitMs,
          requestMs,
          serverProcessingMs,
          transportProxyMs,
          totalElapsedMs: Date.now() - t0,
          laneCeiling: Number(describeLane(requestLane)?.effectiveMax) || 0,
        },
        traceId,
      );
      if (!lensDone) {
        await wf.lensReady(workflowId);
        lensDone = true;
      }
      await wf.textReady(workflowId);
      await handleResult(jobId, result);
      return;
    } catch (error) {
      endInFlight(jobId);
      traceNote(
        "background/pipeline/server-translation.js",
        "imageStage",
        {
          stage: "ai",
          state: error?.name === "AbortError" ? "cancelled" : "failed",
          route: "api",
          imageId,
          queueWaitMs,
          status: Number(error?.status) || 0,
          retryAfterMs: Number(error?.retryAfterMs) || 0,
        },
        traceId,
      );
      if (error?.cancelled || error?.name === "AbortError") {
        const observed = failureUsageDetails(error);
        if (observed.usage?.receiptId || observed.usage?.generations?.length)
          await persistProviderGeneration({ ...observed, usage: observed.usage,
            runtime: localRequest ? "local" : "cloud", engine: "runsapi", success: false,
            operationId: String(outbound?.idempotency_key || ""), requests: Math.max(1, observed.generationAttempts) });
        if (slotHeld) releaseFailed(requestLane);
        log.info("request cancelled with the tab", { jobId });
        await wf.failed(workflowId, "cancelled with the tab");
        markJobPhase(jobId, "cancelled", {
          lastError: "cancelled with the tab",
        });
        releaseJob(jobId, payload?.metadata?.image_id);
        return;
      }
      const retryAfterMs = Number(error?.retryAfterMs) || 0;
      const status = Number(error?.status) || 0;
      const failedStage = String(error?.failedStage || "");
      if (
        !browserImageFallbackUsed &&
        failedStage === "image_fetch" &&
        !payload.imageDataUri &&
        /^https?:/i.test(String(payload?.src || ""))
      ) {
        browserImageFallbackUsed = true;
        if (slotHeld) {
          releaseFailed(requestLane);
          slotHeld = false;
        }
        const src = String(payload.src || "").trim();
        let browserFetchError = "";
        try {
          let dataUri = "";
          if (tabId)
            try {
              dataUri = await fetchImageDataUriFromTab(
                tabId,
                src,
                frameId || 0,
              );
            } catch (tabError) {
              browserFetchError = tabError?.message || String(tabError);
            }
          if (!dataUri)
            dataUri = await fetchImageDataUriFromUrl(
              src,
              payload?.context?.page_url || "",
            );
          if (dataUri) {
            payload.imageDataUri = dataUri;
            const key = normImgSrc(src);
            if (key) setCachedDataUri(key, dataUri);
            markDomainNeedsDataUri(src);
            payload = withPipelineStage(
              payload,
              "server_image_fetch_browser_fallback",
            );
            log.info("server image fetch failed; recovered bytes in browser", {
              src: src.slice(0, 180),
              kb: Math.round(dataUri.length / 1024),
              tabFallbackError: browserFetchError,
            });
            await wf.lensDegraded(
              workflowId,
              "server image fetch failed; browser supplied bytes",
            );
            serverRequestTracked = false;
            continue;
          }
        } catch (browserError) {
          browserFetchError = browserError?.message || String(browserError);
        }
        log.warn("browser image fallback failed", {
          src: src.slice(0, 180),
          failedStage,
          error: browserFetchError || "browser returned no image bytes",
        });
      }
      const isBusy = status === 429 || status === 503 || retryAfterMs > 0;
      const gated = rateGateBusy(error);
      const code = String(error?.code || "");
      const charged = failureUsageDetails(error);
      const generationAttempts = Number(
        error?.generationAttempts || charged.generationAttempts || 0,
      );
      if (generationAttempts === 0 && (error?.requestDispatched === false ||
          error?.tpError?.generationAttempts === 0 || (status >= 400 && status < 500)))
        await persistProviderGeneration({ resolvePending: true, engine: "runsapi", operationId: String(outbound?.idempotency_key || "") });
      if (generationAttempts > 0)
        await persistProviderGeneration(
          {
            runtime: localRequest ? "local" : "cloud",
            provider:
              charged.provider ||
              error?.provider ||
              outbound?.ai?.provider ||
              "unknown",
            model:
              charged.model || error?.model || outbound?.ai?.model || "unknown",
            engine: "runsapi",
            requests: generationAttempts,
            failures: generationAttempts,
            generationAttempts,
            reason: "provider_charged_failure",
            operationId: String(outbound?.idempotency_key || ""),
            traceId,
            requestId: String(error?.requestId || error?.request_id || ""),
            replayed: Boolean(error?.replayed),
            startedAt: requestStartedAt,
            usage: charged.usage,
            inputTokens: charged.inputTokens,
            outputTokens: charged.outputTokens,
            totalTokens: charged.totalTokens,
            providerMs: charged.providerMs,
            totalMs: Number.isFinite(charged.totalMs)
              ? charged.totalMs
              : requestStartedAt
                ? Date.now() - requestStartedAt
                : 0,
          },
          {
            emitTrace: (name, data) =>
              traceNote(
                "background/pipeline/server-translation.js",
                name,
                data,
                traceId,
              ),
          },
        );
      const safeDeferred =
        generationAttempts === 0 &&
        [
          "server_busy",
          "local_rate_gate_busy",
          "lens_session_unavailable",
          "provider_rate_limited",
        ].includes(code);
      if (isBusy && safeDeferred) {
        const serverRetryMs =
          code === "server_busy"
            ? Math.min(
                5000,
                Math.max(retryAfterMs, 300 * 2 ** Math.min(4, attempt)),
              )
            : retryAfterMs;
        if (slotHeld) {
          if (gated) releaseGated(requestLane, retryAfterMs);
          else if (localRequest)
            releaseLocalFailure(requestLane, error, retryAfterMs);
          else if (code === "provider_rate_limited")
            releaseRejected(requestLane, retryAfterMs);
          else releaseDeferred(requestLane, serverRetryMs);
          slotHeld = false;
        }
        log.info(
          gated
            ? "this API key is out of tokens; the image waits its turn"
            : `${code || "server busy"}; the image stays with us`,
          {
            laneKey: requestLane,
            attempt: attempt + 1,
            retryAfterMs,
            serverRetryMs,
            gated,
            code,
            generationAttempts,
          },
        );
        traceNote(
          "background/pipeline/server-translation.js",
          "imageStage",
          {
            stage: "ai",
            state: "requeued",
            route: "api",
            imageId,
            queueWaitMs,
            status,
            retryAfterMs,
            serverRetryMs,
            code,
            generationAttempts,
            attempt: attempt + 1,
          },
          traceId,
        );
        await waitForRetry(
          code === "server_busy" ? serverRetryMs : retryAfterMs,
          ctrl.signal,
        );
        continue;
      }
      if (slotHeld) {
        if (localRequest) releaseLocalFailure(requestLane, error, retryAfterMs);
        else if (isBusy) releaseRejected(requestLane, retryAfterMs);
        else releaseFailed(requestLane);
      }
      await wf.failed(workflowId, error?.message || String(error));
      handleJobError(jobId, error);
      return;
    }
  }
}

export async function submitAndPollServer(input, deps) {
  const {
    base,
    payload,
    makeContext,
    tabId,
    frameId,
    batch,
    batchId,
    imageKey,
    workflowId = "",
  } = input;
  const {
    batchUpdateToast,
    classifyJobError,
    failJobImmediately,
    finalizeBatch,
    handleJobError,
    markImagePhase,
    rememberJob,
  } = deps;
  let jobId = "";
  try {
    const idempotencyKey = await idempotencyKeyForPayload(payload);
    payload.idempotency_key = idempotencyKey;
    await wf.lensRequested(workflowId, `rest:${idempotencyKey}`);
    if (batch && imageKey)
      markImagePhase(
        batchId,
        imageKey,
        payload?.engine === "api" ? "server_processing" : "lens",
        payload?.engine === "api"
          ? { stage: "Server processing (Lens/AI)" }
          : {},
      );
    if (payload?.ai?.provider)
      await persistProviderGeneration({ pending: true, operationId: idempotencyKey, engine: "runsapi",
        provider: payload.ai.provider, model: payload.ai.model, runtime: isLocalAiPayload(payload) ? "local" : "cloud" });
    const submitted = await submitJobViaRest(base, payload, { idempotencyKey });
    jobId = String(submitted.id || "");
    const ctx = makeContext({
      startedAt: Date.now(),
      base,
      idempotencyKey,
      serverHints: submitted,
      serverQueued: true,
    });
    rememberJob(jobId, ctx);
    await pollJobViaRest(base, jobId, {
      session: String(ctx?.sessionId || payload?.context?.tp_tab_session || ""),
    });
  } catch (error) {
    const message = error?.message || String(error);
    if (jobId) {
      handleJobError(jobId, error);
      return;
    }
    if (payload?.metadata?.image_id)
      pendingByImage.delete(payload.metadata.image_id);
    if (batch && imageKey) {
      const classification = classifyJobError(error);
      markImagePhase(batchId, imageKey, "error", {
        lastError: message,
        permanent: Boolean(classification.permanent),
      });
      batchUpdateToast(
        batch,
        classification.permanent ? "Error (permanent)" : "Error",
      );
      finalizeBatch(batch);
    }
    failJobImmediately(
      tabId,
      payload?.src || null,
      error,
      frameId,
      String(payload?.context?.tp_trace || ""),
    );
  }
}
