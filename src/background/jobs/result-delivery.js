import { persistProviderGeneration, failureUsageDetails } from "../../shared/ai-usage.js";
import { isLocalAiTarget } from "../../shared/constants.js";
const URL_ONLY_DATA_URI_RETRY_CODES = new Set([
  "IMAGE_FETCH_FAILED",
  "IMAGE_BYTES_UNAVAILABLE",
  "IMAGE_DATA_UNAVAILABLE",
]);

// A URL-only retry exists solely to recover image acquisition by attaching the
// bytes to pass 2. It must never convert a semantic API rejection (grouping
// contract, decode, render, AI, etc.) from permanent to transient.
export function isUrlOnlyImageAcquisitionFailure(error) {
  const structured = error?.tpError || null;
  const code = String(structured?.code || error?.code || "").toUpperCase();
  if (URL_ONLY_DATA_URI_RETRY_CODES.has(code)) return true;
  const message = String(error?.message || error || "");
  return (
    /^could not read the image bytes:/i.test(message) ||
    /^the image reader returned nothing to upload$/i.test(message)
  );
}

export function isPermanentSemanticGroupingFailure(error) {
  const structured = error?.tpError || null;
  const code = String(structured?.code || error?.code || "").toLowerCase();
  const stage = String(structured?.stage || error?.stage || "").toLowerCase();
  const status = Number(error?.status || structured?.httpStatus || 0);
  const message = String(error?.message || error || "").toLowerCase();
  if (code === "vertical_grouping_unresolved") return true;
  if (code === "tree_fingerprint_mismatch") return true;
  if (message.includes("the grouping result does not fit this document"))
    return true;
  return (
    (stage === "grouping" || stage === "lens_grouping") &&
    status >= 400 &&
    status < 500 &&
    status !== 429
  );
}

export function createResultDelivery(deps) {
  const {
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
    workflow,
    log,
  } = deps;

  async function accountQueued(ctx, value, success) {
    if (!ctx?.serverQueued) return;
    if (success && value?.perf?.cache === "hit") {
      await persistProviderGeneration({ operationId: String(ctx.idempotencyKey || ""), engine: "runsapi", resolvePending: true });
      return;
    }
    const meta = success ? value?.Ai?.meta : null;
    const charged = success ? { ...meta, usage: meta?.usage } : failureUsageDetails(value);
    if (!charged?.provider || !charged?.model) {
      if (success || value?.generationAttempts === 0 || value?.requestDispatched === false)
        await persistProviderGeneration({ operationId: String(ctx.idempotencyKey || ""), engine: "runsapi", resolvePending: true });
      return;
    }
    await persistProviderGeneration({
      runtime: isLocalAiTarget(charged.provider, charged.baseUrl) ? "local" : "cloud",
      provider: charged.provider, model: charged.model, engine: "runsapi",
      operationId: String(ctx.idempotencyKey || ctx.metadata?.operation_id || ""),
      traceId: String(ctx.traceId || ""), startedAt: ctx.usageStartedAt ?? ctx.startedAt,
      usage: charged.usage, success,
      requests: Math.max(1, Number(charged.generation_attempts || charged.generationAttempts) || 1),
      replayed: value?.replayed === true || value?.perf?.replayed === true || value?.perf?.replayedFromLedger === true,
      reason: success ? "translation_success" : "provider_charged_failure",
    });
  }

  function failJobImmediately(
    tabId,
    imgUrl,
    message,
    frameId = 0,
    traceId = "",
  ) {
    if (tabId)
      sendToTab(
        tabId,
        imageErrorMessage({ imgUrl, traceId }, message),
        frameId,
      );
  }

  function handleStaleJob(jobId) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return;
    removeJob(jobId, ctx?.metadata?.image_id);
    const batchId = String(
      ctx?.batchId || ctx?.metadata?.batch_id || "",
    ).trim();
    const imageKey = String(
      ctx?.imageKey || ctx?.metadata?.image_id || "",
    ).trim();
    const batch = batchId
      ? ensureBatch(batchId, ctx.tabId || 0, ctx.frameId || 0)
      : null;
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "cancelled", {
        lastError: "navigation",
      });
      batchUpdateToast(batch, "Cancelled", true);
      finalizeBatch(batch);
    }
  }

  function handleJobError(
    jobId,
    error = {
      code: "PROCESSING_FAILED",
      message: "Job failed without error detail",
    },
  ) {
    const ctx = pendingByJob.get(jobId);
    // Ledger updates are serialized and independent of DOM delivery. Durable
    // cloud receipts remain on the API even if this worker disappears.
    void accountQueued(ctx, error?.tpError || error, false).catch(error =>
      log.warn("queued usage persistence failed", { message: error?.message || String(error) }));
    const errMsg = error?.message || String(error || "PROCESSING_FAILED");
    const aiGenerationAttempted = Boolean(ctx?.aiGenerationAttempted);
    let cls = classifyJobError(error, { aiGenerationAttempted });
    if (isPermanentSemanticGroupingFailure(error)) cls = { permanent: true };
    const terminalAiError =
      aiGenerationAttempted ||
      /(?:ai text was incomplete; no automatic retry was made|ai text layer cannot be rendered faithfully)/i.test(
        String(errMsg || ""),
      );
    const curSession = ctx?.tabId ? getTabSessionId(ctx.tabId) : "";
    const isStale = Boolean(
      ctx?.sessionId && curSession && ctx.sessionId !== curSession,
    );
    const batchId = String(
      ctx?.batchId || ctx?.metadata?.batch_id || "",
    ).trim();
    const imageKey = String(
      ctx?.imageKey || ctx?.metadata?.image_id || "",
    ).trim();
    const batch = batchId
      ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0)
      : null;
    const item = batch && imageKey ? batch.items.get(imageKey) : null;
    if (
      item?.payload &&
      deps.isUrlOnlyPayload(item.payload) &&
      isUrlOnlyImageAcquisitionFailure(error) &&
      !terminalAiError
    ) {
      markDomainNeedsDataUri(item.payload.src);
      if (cls.permanent) cls = { permanent: false };
    }
    if (ctx?.tabId && !isStale)
      sendToTab(ctx.tabId, imageErrorMessage(ctx, error), ctx.frameId || 0);
    removeJob(jobId, ctx?.metadata?.image_id);
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "error", {
        lastError: errMsg,
        permanent: !!cls.permanent,
      });
      batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
      finalizeBatch(batch);
    }
  }

  async function handleResult(jobId, result) {
    const ctx = findContext(jobId, result?.metadata?.image_id);
    if (!ctx) {
      log.warn("result for unknown job", { id: jobId });
      return;
    }
    await accountQueued(ctx, result, true);
    const { imgUrl, tabId } = ctx;
    const frameId = ctx.frameId || 0;
    const mode = ctx.mode || ctx.metadata?.mode || null;
    const batchId = String(ctx.batchId || ctx.metadata?.batch_id || "").trim();
    const imageKey = String(
      ctx.imageKey ||
        ctx.metadata?.image_id ||
        result?.metadata?.image_id ||
        "",
    ).trim();
    const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;
    const curSession = getTabSessionId(tabId);
    const settingsStale =
      typeof ctx.settingsEpoch === "number" &&
      ctx.settingsEpoch !== getSettingsEpoch();
    const isStale =
      Boolean(batch?.cancelled) ||
      Boolean(ctx.sessionId && curSession && ctx.sessionId !== curSession) ||
      settingsStale;
    if (isStale) {
      traceNote(
        "background/jobs/result-delivery.js",
        "jobCancellation",
        {
          jobId,
          batchId,
          imageId: imageKey,
          staleDrawPrevented: true,
          cancelRequestedAt: Number(batch?.cancelRequestedAt || Date.now()),
        },
        String(ctx.traceId || ""),
      );
      removeJob(jobId, result?.metadata?.image_id);
      if (batch && imageKey)
        markImagePhase(batchId, imageKey, "cancelled", {
          lastError: "stale result",
        });
      finalizeBatch(batch);
      return;
    }
    const { newImg, hasHtml, skipReason, shouldShowSkipBadge } =
      summarizeResultPresentation(result, mode);
    void (async () => {
      try {
        const key =
          (ctx.seriesKey && String(ctx.seriesKey)) ||
          (await resolveSeriesKey(ctx.pageUrl || "")) ||
          "default";
        await accumulateSeriesMemory(key, result);
      } catch {}
    })();
    const cacheKey = mdCacheKey(
      mdKeyFromUrl(imgUrl),
      ctx.lang || ctx.metadata?.lang,
      mode,
      ctx.source || ctx.metadata?.source,
    );
    if (cacheKey && (newImg || hasHtml)) {
      const sourceImageKey = result?.sourceImageDataUri
        ? normImgSrc(imgUrl)
        : "";
      if (sourceImageKey)
        setCachedDataUri(sourceImageKey, result.sourceImageDataUri);
      setCachedResult(cacheKey, {
        newImg: newImg || null,
        result: hasHtml
          ? {
              ...stripImageFields(result),
              ...(sourceImageKey ? { sourceImageKey } : {}),
            }
          : null,
      });
    }
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "rendering");
      batchUpdateToast(batch, "Inserting");
    }
    const workflowId = String(ctx.workflowId || "");
    await workflow.renderReady(workflowId);
    await workflow.applyRequested(workflowId, `apply:${jobId}`);
    const stopStaleDraw = () => {
      const stale =
        (typeof ctx.settingsEpoch === "number" && ctx.settingsEpoch !== getSettingsEpoch()) ||
        Boolean(batch?.cancelled) ||
        Boolean(
          ctx.sessionId &&
          getTabSessionId(tabId) &&
          ctx.sessionId !== getTabSessionId(tabId),
        );
      if (stale)
        traceNote(
          "background/jobs/result-delivery.js",
          "jobCancellation",
          {
            jobId,
            batchId,
            imageId: imageKey,
            staleDrawPrevented: true,
            cancelRequestedAt: Number(batch?.cancelRequestedAt || Date.now()),
          },
          String(ctx.traceId || ""),
        );
      return stale;
    };
    const stop = () => {
      removeJob(jobId, result?.metadata?.image_id);
      if (batch && imageKey)
        markImagePhase(batchId, imageKey, "cancelled", {
          lastError: "stale draw prevented",
        });
      finalizeBatch(batch);
    };
    if (stopStaleDraw()) return stop();
    let replaceOk = null;
    if (newImg && mode !== "lens_text") {
      if (stopStaleDraw()) return stop();
      replaceOk = await enqueueDomInsert(
        tabId,
        {
          type: "REPLACE_IMAGE",
          original: imgUrl,
          newSrc: newImg,
          tpTrace: ctx.traceId || "",
        },
        frameId,
      );
    }
    let overlayOk = null;
    if (hasHtml || shouldShowSkipBadge) {
      if (stopStaleDraw()) return stop();
      overlayOk = await enqueueDomInsert(
        tabId,
        {
          type: "OVERLAY_HTML",
          original: imgUrl,
          result,
          mode: mode || "",
          source: ctx.source || "",
          generation: ctx.generation || null,
          translationRun: ctx.translationRun || null,
          tpTrace: ctx.traceId || "",
        },
        frameId,
      );
    }
    let ok = true;
    let errMsg = "";
    if (!hasHtml && !(newImg && mode !== "lens_text") && !newImg) {
      if (
        evaluateTextNoOverlaySkippable(
          mode,
          ctx.source || result?.source || "",
          result,
          result?.Ai?.meta?.skipped_reason,
        )
      ) {
        const item = batch && imageKey ? batch.items.get(imageKey) : null;
        if (!skipReason && item && Number(item.attempt || 1) < 2) {
          ok = false;
          errMsg = "No text detected (retrying)";
        } else errMsg = "No text detected";
      } else {
        await enqueueDomInsert(
          tabId,
          imageErrorMessage(ctx, "API returned no overlay data"),
          frameId,
        );
        ok = false;
        errMsg = "API returned no overlay data";
      }
    }
    if (newImg && mode !== "lens_text" && !replaceOk?.ok) {
      ok = false;
      errMsg = "DOM replace failed";
    }
    if (hasHtml && (!overlayOk?.ok || overlayOk?.stale || overlayOk?.notFound || overlayOk?.expired)) {
      ok = false;
      errMsg = "Overlay insert failed";
    }
    await deps.onDelivered?.(ctx, ok && overlayOk?.applied === true && overlayOk?.stale !== true);
    if (ok) await workflow.applied(workflowId);
    else
      await workflow.failed(
        workflowId,
        errMsg || "the page did not take the overlay",
      );
    traceNote(
      "background/jobs/result-delivery.js",
      "imageStage",
      {
        stage: "insert",
        state: ok ? "finished" : "failed",
        imageId: imageKey,
        errorType: ok ? "" : "insert_rejected",
      },
      String(ctx.traceId || ""),
    );
    removeJob(jobId, result?.metadata?.image_id);
    if (batch && imageKey) {
      if (ok) {
        const skipped = errMsg === "No text detected";
        markImagePhase(batchId, imageKey, "done", {
          status: skipped ? "skipped" : "done",
          lastError: skipped ? errMsg : "",
        });
        batchUpdateToast(batch, skipped ? "Skipped: no text" : "1 image done");
      } else {
        const cls = classifyJobError(errMsg, {
          aiRouteEntered: Boolean(ctx?.aiRouteEntered),
          aiGenerationAttempted: Boolean(ctx?.aiGenerationAttempted),
        });
        markImagePhase(batchId, imageKey, "error", {
          lastError: errMsg || "PROCESSING_FAILED",
          permanent: !!cls.permanent,
        });
        batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
      }
      finalizeBatch(batch);
    }
  }

  return { failJobImmediately, handleStaleJob, handleJobError, handleResult };
}
