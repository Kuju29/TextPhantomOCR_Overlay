import { persistProviderGeneration, failureUsageDetails } from "../../shared/ai-usage.js";
import { isLocalAiTarget } from "../../shared/constants.js";
const URL_ONLY_DATA_URI_RETRY_CODES = new Set([
  "IMAGE_FETCH_FAILED",
  "IMAGE_BYTES_UNAVAILABLE",
  "IMAGE_DATA_UNAVAILABLE",
]);

// Usage persistence is an accounting side effect, not a rendering prerequisite.
// Keep immutable receipts in an ordered retry queue so a slow/full browser
// storage area cannot suppress an otherwise valid translation result.
export function createResultAccountingQueue({
  persist = persistProviderGeneration,
  retryDelayMs = 250,
  maxRetryDelayMs = 2000,
  maxAttempts = 3,
  maxPending = 64,
  maxAgeMs = 30_000,
  attemptTimeoutMs = 3000,
  clock = Date.now,
  schedule = (fn, delay) => setTimeout(fn, delay),
  attemptSchedule = (fn, delay) => setTimeout(fn, delay),
  cancelAttemptSchedule = handle => clearTimeout(handle),
  onError = () => {},
  onTerminal = () => {},
} = {}) {
  const attemptLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 3;
  const pendingLimit = Number.isFinite(maxPending) ? Math.max(1, Math.floor(maxPending)) : 64;
  const ageLimitMs = Number.isFinite(maxAgeMs) ? Math.max(1, maxAgeMs) : 30_000;
  const timeoutLimitMs = Number.isFinite(attemptTimeoutMs) ? Math.max(1, attemptTimeoutMs) : 3000;
  const retryBaseMs = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 250;
  const retryCapMs = Number.isFinite(maxRetryDelayMs) ? Math.max(retryBaseMs, maxRetryDelayMs) : 2000;
  const pending = [];
  let running = false;
  let retryScheduled = false;
  let idleWaiters = [];
  const freezeTree = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeTree(child, seen);
    return Object.freeze(value);
  };

  const settleIdle = () => {
    if (running || pending.length || retryScheduled) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const requestDrain = () => {
    if (running || retryScheduled || !pending.length) return;
    queueMicrotask(() => void drain());
  };
  async function drain() {
    if (running || retryScheduled) return;
    running = true;
    try {
      while (pending.length) {
        const current = pending[0];
        if (current.attempts && clock() - current.queuedAt >= ageLimitMs) {
          pending.shift();
          const outcome = { confirmed: false, code: "accounting_unconfirmed",
            reason: "max_age", attempts: current.attempts,
            operationId: current.event.operationId || "" };
          onTerminal(current.lastError || new Error("Usage accounting receipt expired"), outcome);
          current.resolve(outcome);
          continue;
        }
        try {
          let timeout;
          try {
            await Promise.race([
              Promise.resolve().then(() => persist(current.event)),
              new Promise((_, reject) => { timeout = attemptSchedule(() =>
                reject(Object.assign(new Error("Usage accounting timed out"), {
                  code: "accounting_timeout",
                })), timeoutLimitMs); }),
            ]);
          } finally {
            cancelAttemptSchedule(timeout);
          }
          pending.shift();
          current.resolve({ confirmed: true, attempts: current.attempts + 1 });
        } catch (error) {
          current.attempts += 1;
          current.lastError = error;
          onError(error, { attempts: current.attempts, operationId: current.event.operationId || "" });
          if (current.attempts >= attemptLimit || clock() - current.queuedAt >= ageLimitMs) {
            pending.shift();
            const outcome = {
              confirmed: false,
              code: "accounting_unconfirmed",
              reason: current.attempts >= attemptLimit ? "max_attempts" : "max_age",
              attempts: current.attempts,
              operationId: current.event.operationId || "",
            };
            onTerminal(error, outcome);
            current.resolve(outcome);
            continue;
          }
          retryScheduled = true;
          const remainingAge = Math.max(0, ageLimitMs - (clock() - current.queuedAt));
          const delay = Math.min(retryCapMs,
            retryBaseMs * (2 ** Math.max(0, current.attempts - 1)), remainingAge);
          schedule(() => {
            retryScheduled = false;
            requestDrain();
          }, delay);
          break;
        }
      }
    } finally {
      running = false;
      if (pending.length && !retryScheduled) requestDrain();
      settleIdle();
    }
  }
  return {
    enqueue(event) {
      let resolve;
      const done = new Promise(doneResolve => { resolve = doneResolve; });
      if (pending.length >= pendingLimit) {
        const outcome = { confirmed: false, code: "accounting_unconfirmed",
          reason: "queue_full", attempts: 0, operationId: event?.operationId || "" };
        onTerminal(Object.assign(new Error("Usage accounting queue is full"), {
          code: "accounting_queue_full",
        }), outcome);
        resolve(outcome);
        return done;
      }
      let immutableEvent;
      try {
        immutableEvent = freezeTree(structuredClone(event));
      } catch (error) {
        const outcome = { confirmed: false, code: "accounting_unconfirmed",
          reason: "invalid_receipt", attempts: 0, operationId: event?.operationId || "" };
        onTerminal(error, outcome);
        resolve(outcome);
        return done;
      }
      pending.push({ event: immutableEvent, attempts: 0, resolve, queuedAt: clock() });
      requestDrain();
      return done;
    },
    describe: () => ({ pending: pending.length, running, retryScheduled }),
    flush() {
      if (!running && !pending.length && !retryScheduled) return Promise.resolve();
      return new Promise(resolve => idleWaiters.push(resolve));
    },
  };
}

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
    updateImagePresentation,
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
  const accounting = deps.accountingQueue || createResultAccountingQueue({
    persist: deps.persistUsage || persistProviderGeneration,
    onError: (error, details) => log.warn("queued usage persistence failed", {
      ...details, message: error?.message || String(error), recoverable: true,
    }),
    onTerminal: (error, details) => {
      log.warn("usage accounting remains unconfirmed", {
        ...details, code: "accounting_unconfirmed",
        message: error?.message || String(error), recoverable: true,
      });
      traceNote("background/jobs/result-delivery.js", "usageAccounting", {
        code: "accounting_unconfirmed", reason: details.reason || "unknown",
        attempts: details.attempts, operationId: details.operationId || "",
        recoverable: true,
      });
    },
  });
  const deliveringJobs = new Set();

  function deferImageError(ctx, batch, imageKey, error, terminalAiError = false) {
    return Boolean(
      batch &&
        imageKey &&
        deps.shouldDeferImageError?.({
          ctx,
          batch,
          imageKey,
          error,
          terminalAiError,
        }),
    );
  }

  function accountQueued(ctx, value, success) {
    if (!ctx?.serverQueued) return Promise.resolve();
    if (success && value?.perf?.cache === "hit") {
      return accounting.enqueue({ operationId: String(ctx.idempotencyKey || ""), engine: "runsapi", resolvePending: true });
    }
    const meta = success ? value?.Ai?.meta : null;
    const charged = success ? { ...meta, usage: meta?.usage } : failureUsageDetails(value);
    if (!charged?.provider || !charged?.model) {
      if (success || value?.generationAttempts === 0 || value?.requestDispatched === false)
        return accounting.enqueue({ operationId: String(ctx.idempotencyKey || ""), engine: "runsapi", resolvePending: true });
      return Promise.resolve();
    }
    return accounting.enqueue({
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
    void accountQueued(ctx, error?.tpError || error, false);
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
    const publicError = imageErrorMessage(ctx, error);
    const deferred = deferImageError(
      ctx,
      batch,
      imageKey,
      error,
      terminalAiError,
    );
    if (ctx?.tabId && !isStale && !deferred)
      sendToTab(ctx.tabId, publicError, ctx.frameId || 0);
    removeJob(jobId, ctx?.metadata?.image_id);
    if (batch && imageKey) {
      markImagePhase(batchId, imageKey, "error", {
        lastError: errMsg,
        permanent: !!cls.permanent,
        deferredImageError: deferred ? publicError : null,
        suppressToast: deferred,
      });
      if (!deferred)
        batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
      finalizeBatch(batch);
    }
  }

  // Render a complete image while its shared request is still open. Never
  // account, cache, remove the job, release the initial barrier or finalize it.
  async function handleProvisionalResult(jobId,result,state={}) {
    const ctx=findContext(jobId,result?.metadata?.image_id);
    if(!ctx||deliveringJobs.has(jobId))return;
    const batchId=String(ctx.batchId||ctx.metadata?.batch_id||'');
    const batch=batchId?ensureBatch(batchId,ctx.tabId,ctx.frameId||0):null;
    const stale=()=>state.isCancelled?.()||!pendingByJob.has(jobId)||batch?.cancelled||
      (typeof ctx.settingsEpoch==='number'&&ctx.settingsEpoch!==getSettingsEpoch())||
      (ctx.sessionId&&getTabSessionId(ctx.tabId)&&ctx.sessionId!==getTabSessionId(ctx.tabId));
    if(stale())return;
    const streamTiming={...state.streamTiming,domEnqueuedAt:Date.now(),
      runId:ctx.translationRun?.runId||'',generationId:ctx.translationRun?.generationId||''};
    traceNote('background/jobs/result-delivery.js','provisionalEnqueued',{
      schema:'tp.audit/1',event:'page_stream_timing',reason:'dom_enqueued',...streamTiming,jobId,batchId,imageId:ctx.imageKey||ctx.metadata?.image_id,
      complete:state.complete===true},ctx.traceId||'');
    const response=await enqueueDomInsert(ctx.tabId,{type:'OVERLAY_HTML',original:ctx.imgUrl,
      tpStreamTiming:streamTiming,
      result,mode:ctx.mode||ctx.metadata?.mode||'',source:ctx.source||'ai',
      generation:ctx.generation||null,translationRun:ctx.translationRun||null,tpTrace:ctx.traceId||'',
      streamError:state.invalidated||state.failure ? String(state.failure?.message||`AI output invalid: ${(state.missing||[]).join(', ')}`):''},ctx.frameId||0);
    if(stale())return;
    if(response===false||response?.ok===false||response?.applied!==true)
      throw new Error(`Provisional overlay not applied: ${response?.reason||response?.error||'no applied acknowledgement'}`);
    updateImagePresentation?.(batchId, ctx.imageKey || ctx.metadata?.image_id, {
      insertionAck: {present:response.drawn!==false, complete:state.complete===true && !state.invalidated && !state.failure,
        provisional:true, acknowledgedAt:Date.now()},
      progressEvent: {lane:'insert', state:'done', detail:response.drawn===false ? 'No translation layer; request still running' : state.complete===true && !state.invalidated && !state.failure
        ? 'Placed during stream; request still running' : 'Partial translation placed; validation incomplete'},
    });
    traceNote('background/jobs/result-delivery.js','provisionalOverlay',{
      schema:'tp.audit/1',event:'page_stream_timing',reason:'dom_acknowledged',jobId,batchId,imageId:ctx.imageKey||ctx.metadata?.image_id,
      ...streamTiming,domAckAt:Date.now(),
      completeToAckMs:Number.isFinite(streamTiming.recordsCompleteAt)
        ? Math.max(0,Date.now()-streamTiming.recordsCompleteAt):null,
      complete:state.complete===true,invalidated:state.invalidated===true,terminal:false},ctx.traceId||'');
  }

  async function handleResult(jobId, result) {
    const ctx = findContext(jobId, result?.metadata?.image_id);
    if (!ctx) {
      log.warn("result for unknown job", { id: jobId });
      return;
    }
    // A slow accounting commit lengthens ownership after DOM delivery. Claim
    // this result synchronously so duplicate poll/message delivery cannot draw
    // or enqueue the same receipt twice during that window.
    if (deliveringJobs.has(jobId)) return;
    deliveringJobs.add(jobId);
    try {
    const accountingDone = accountQueued(ctx, result, true);
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
      deliveringJobs.delete(jobId);
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
      ctx.settingsEpoch,
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
      deliveringJobs.delete(jobId);
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
          generation: ctx.generation || null,
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
          streamError: String(result?.aiRoute?.streamFailure?.message || ""),
          tpTrace: ctx.traceId || "",
        },
        frameId,
      );
    }
    if (stopStaleDraw()) return stop();
    let ok = true;
    let errMsg = "";
    let deferredImageError = null;
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
        const publicError = imageErrorMessage(ctx, "API returned no overlay data");
        if (
          deferImageError(
            ctx,
            batch,
            imageKey,
            "API returned no overlay data",
            Boolean(ctx?.aiGenerationAttempted || ctx?.aiRouteEntered),
          )
        ) deferredImageError = publicError;
        else await enqueueDomInsert(tabId, publicError, frameId);
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
    if (batch && imageKey && typeof updateImagePresentation === "function") {
      const inserted = Boolean((newImg && mode !== "lens_text") || hasHtml || shouldShowSkipBadge);
      const acknowledged = Boolean((hasHtml && overlayOk?.applied === true && !overlayOk?.stale && overlayOk?.drawn !== false) ||
        (newImg && mode !== "lens_text" && replaceOk?.ok === true));
      updateImagePresentation(batchId, imageKey, {
        ...((acknowledged || overlayOk?.applied === true) ? {insertionAck:{present:acknowledged,
          provisional:false, acknowledgedAt:Date.now()}} : {}),
        progressEvent: {
          lane: "insert",
          state: ok ? (inserted ? "done" : "skipped") : "error",
          detail: ok ? (inserted ? "Placed on page" : "No DOM insert needed") : (errMsg || "Insert failed"),
        },
      });
      if (ok) updateImagePresentation(batchId, imageKey, {
        progressEvent: { lane: "overall", state: "done", resultState: "pending", detail: "Visible complete; finalizing receipt" },
      });
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
    // The overlay is already visible. Keep this job/keepalive owned until its
    // immutable usage receipt reaches durable storage, including a transient
    // retry, without putting storage latency on the visible render path.
    await accountingDone;
    removeJob(jobId, result?.metadata?.image_id);
    deliveringJobs.delete(jobId);
    if (batch && imageKey) {
      if (ok) {
        const skipped = errMsg === "No text detected";
        markImagePhase(batchId, imageKey, "done", {
          status: skipped ? "skipped" : "done",
          lastError: skipped ? errMsg : "",
          deferredImageError: null,
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
          deferredImageError,
          suppressToast: Boolean(deferredImageError),
        });
        if (!deferredImageError)
          batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
      }
      finalizeBatch(batch);
    }
    } finally {
      deliveringJobs.delete(jobId);
    }
  }

  return {
    failJobImmediately, handleStaleJob, handleJobError, handleResult, handleProvisionalResult,
    flushAccounting: () => accounting.flush(),
    accountingState: () => accounting.describe(),
  };
}
