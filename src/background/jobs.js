// Orchestrates a translation job from enqueue through submit, result handling and batch finalisation.

import { createLogger, setLogLevel } from "../shared/logger.js";
import { setLogShippingEnabled } from "../shared/log-sink.js";
import { getApiBase } from "./api.js";
import {
  ensureBatch,
  getBatch,
  batchMark,
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
import { pendingByJob, pendingByImage, findContext, removeJob, rememberJob, restorePendingJobs } from "./job-registry.js";
import {
  getCachedDataUri,
  setCachedDataUri,
  isMangaDexPageUrl,
  mdKeyFromUrl,
  mdCacheKey,
  setCachedResult,
  stripImageFields,
} from "./mangadex.js";
import { accumulateSeriesMemory, getSeriesMemory, selectPromptMemory } from "./series-memory.js";
import { resolveSeriesKey } from "../shared/series.js";
import { bumpTabSession, getTabSessionId } from "./tab-sessions.js";
import {
  sendToTab,
  } from "./tabs-messaging.js";
import { enqueueDomInsert } from "./insert-queue.js";
import { imageErrorMessage } from "./error-message.js";
import {
  submitJobViaRest,
  pollJobViaRest,
  cancelJobsViaRest,
  translateViaSyncRest,
  groupParagraphsWithArtifactFallback,
  fetchLensRawViaRest,
} from "./transport.js";
import { engineCompatibilityIssue, forgetCapabilities, getCapabilities } from "./capabilities.js";
import {
  getTrace,
  newTraceId,
  note as traceNote,
  setTrace,
  setTracingEnabled,
} from "../shared/trace.js";
import * as wf from "./workflow-track.js";
import {
  translateUnits,
} from "./ai-local.js";
import {
  applyTranslations,
  attachBubbleGroups,
  canRenderFaithfully,
  classifyAiTranslationReport,
  requireAiLensDocument,
  translationUnits,
} from "../shared/lens-document.js";
import { eraseBoxesForAiPartial } from "../shared/erase-boxes.js";
import {
  authoritativeLensImageSize,
  decodeLensResponse,
  remapRawBubbleGroups,
} from "../shared/lens-decode.js";
import { decideVerticalMerge } from "../shared/vertical-verdict.js";
import { aiLayoutDecision } from "../shared/lens-axis.js";
import {
  acquire,
  releaseSuccess,
  releaseRejected,
  releaseDeferred,
  releaseGated,
  releaseFailed,
  laneKeyFor,
  describe as describeLane,
  setLaneCapacityHint,
  setLaneSlotCeiling,
  setLaneUnlimited,
} from "./scheduler.js";

const log = createLogger("SW.jobs");

// Whether a 429 came from the API's per-key AI rate gate rather than from the
// provider or from server overload. Read from the response body's `code`, not
// guessed from the status: the three arrive as the same 429 and only one of
// them means "narrow your concurrency".
function isRateGateBusy(error) {
  const code = String(error?.code || "");
  return code === "rate_gate_busy" || code === "local_rate_gate_busy";
}

// Lens/ONNX admission failures are safe to retry because the rejected request
// never entered the stage. Keep that backlog in the browser that owns the page
// instead of turning another user's burst into a permanent image error.
function isStageBackpressure(error) {
  const status = Number(error?.status) || 0;
  if (status !== 429 && status !== 503) return false;
  if (error?.permanent === true) return false;
  const code = String(error?.code || "");
  return error?.retryable === true || code === "server_busy" ||
    code === "lens_session_unavailable" || !code;
}

// Runs one extension-owned server stage in its own lane. A rejected admission
// releases the slot, observes Retry-After, and re-acquires later; it never holds
// a Lens slot while ONNX waits or vice versa.
async function runStageInLane(key, work, { signal = null, stage = "", imageId = "", traceId = "" } = {}) {
  let accumulatedQueueWaitMs = 0;
  let attempt = 0;
  while (true) {
    attempt++;
    const granted = await acquire(key, signal);
    accumulatedQueueWaitMs += Number(granted?.waitMs) || 0;
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
      traceNote("background/jobs.js", "imageStage", {
        stage, state: "requeued", imageId, lane: key, attempt,
        queueWaitMs: Number(granted?.waitMs) || 0, accumulatedQueueWaitMs,
        status: Number(error?.status) || 0, code, retryAfterMs,
        error: error?.message || String(error),
      }, traceId);
      await waitForRetry(retryAfterMs, signal);
    }
  }
}

const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS = 3000;
const BATCH_RETRY_GAP_MS = 1800;

let settingsEpoch = 0;
// Invalidates in-flight results after the user changes mode, language or source.
export const bumpSettingsEpoch = () => {
  settingsEpoch = (settingsEpoch + 1) >>> 0;
};

// Maps jobId to { tabId, ctrl } for requests that can still be aborted.
const inFlight = new Map();

// Registers an abort controller for a job and returns it.
function beginInFlight(jobId, tabId) {
  const ctrl = new AbortController();
  inFlight.set(jobId, { tabId: Number(tabId) || 0, ctrl });
  return ctrl;
}

function endInFlight(jobId) {
  inFlight.delete(jobId);
}

// Aborts every request belonging to a tab and returns how many were stopped.
function abortTabInFlight(tabId, reason) {
  let stopped = 0;
  for (const [jobId, rec] of Array.from(inFlight.entries())) {
    if (rec.tabId !== tabId) continue;
    inFlight.delete(jobId);
    stopped += 1;
    try {
      rec.ctrl.abort(reason);
    } catch (e) {
      log.warn("could not abort an in-flight request", { jobId, error: e?.message || String(e) });
    }
  }
  return stopped;
}

let currentBatchId = null;
// Sets the batch id new jobs are attributed to.
export const setCurrentBatchId = (id) => {
  currentBatchId = id;
};

// Tells a tab an image failed when there is no job context to clean up.
function failJobImmediately(tabId, imgUrl, message, frameId = 0, traceId = "") {
  if (tabId) {
    sendToTab(tabId, imageErrorMessage({ imgUrl, traceId }, message), frameId);
  }
}

// Aborts a job whose tab session went stale, updating its batch.
export function handleStaleJob(jobId) {
  const ctx = pendingByJob.get(jobId);
  if (!ctx) return;
  removeJob(jobId, ctx?.metadata?.image_id);
  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
  const batch = batchId ? ensureBatch(batchId, ctx.tabId || 0, ctx.frameId || 0) : null;
  if (batch && imageKey) {
    batchMark(batchId, imageKey, { status: "aborted" });
    batchUpdateToast(batch, "Cancelled", true);
    finalizeBatch(batch);
  }
}

// Reports a job error to its tab and marks the failure on its batch.
export function handleJobError(jobId, errMsg = "Unknown error") {
  const ctx = pendingByJob.get(jobId);
  const aiGenerationAttempted = Boolean(ctx?.aiGenerationAttempted);
  let cls = classifyJobError(errMsg, { aiGenerationAttempted });
  const terminalAiError = aiGenerationAttempted || /(?:ai text was incomplete; no automatic retry was made|ai text layer cannot be rendered faithfully)/i.test(
    String(errMsg || ""),
  );
  const curSession = ctx?.tabId ? getTabSessionId(ctx.tabId) : "";
  const isStale = Boolean(ctx?.sessionId && curSession && ctx.sessionId !== curSession);

  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
  const batch = batchId ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0) : null;

  const item = batch && imageKey ? batch.items.get(imageKey) : null;
  if (item?.payload && isUrlOnlyPayload(item.payload) && !terminalAiError) {
    markDomainNeedsDataUri(item.payload.src);
    if (cls.permanent) cls = { permanent: false };
  }

  if (ctx?.tabId && !isStale) {
    sendToTab(
      ctx.tabId,
      imageErrorMessage(ctx, errMsg),
      ctx.frameId || 0,
    );
  }

  removeJob(jobId, ctx?.metadata?.image_id);

  if (batch && imageKey) {
    batchMark(batchId, imageKey, {
      status: "error",
      lastError: errMsg,
      permanent: !!cls.permanent,
    });
    batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
    finalizeBatch(batch);
  }
}


// Records on a result that Lens found nothing a translator can act on, so the image is skipped.
function markNoTranslatableText(result, reason) {
  result.meta = { ...(result.meta || {}), skipped_reason: reason };
}

// Returns the explicit reason an engine gave for intentionally producing no
// text layer. Keep this shared by result handling and the visible page badge so
// "no text" can never silently fall through to the old "No AI key" label.
function textSkipReason(result) {
  return String(
    result?.meta?.skipped_reason ||
      result?.metadata?.skipped_reason ||
      result?.Ai?.meta?.skipped_reason ||
      result?.ai?.meta?.skipped_reason ||
      result?.translated?.meta?.skipped_reason ||
      result?.original?.meta?.skipped_reason ||
      ""
  ).trim().toLowerCase();
}

// Returns whether an overlay-less Lens text result counts as a skipped image rather than an error.
function isTextNoOverlaySkippable(mode, source, result) {
  if (String(mode || "") !== "lens_text") return false;
  const src = String(source || "").toLowerCase();
  const reason = textSkipReason(result);
  // AI is only skippable on an explicit reason: a silent empty AI result is still a failure.
  if (src === "ai") return /no[_ -]?text|no[_ -]?translatable[_ -]?text/.test(reason);
  return !reason || /no[_ -]?text|empty|no[_ -]?overlay|no[_ -]?paragraph/.test(reason);
}

// Returns the replacement-image URL carried by a result, or null.
function extractNewImage(result) {
  return (
    result?.imageDataUri ||
    result?.imageDataURI ||
    result?.image ||
    result?.imageUrl ||
    result?.image_url ||
    result?.imageURL ||
    null
  );
}

// Returns the AI, translated and original overlay markup carried by a result.
function extractHtml(result) {
  return {
    aiHtml: result?.Ai?.aihtml || result?.ai?.aihtml || null,
    translatedHtml: result?.translated?.translatedhtml || result?.translatedhtml || null,
    originalHtml: result?.original?.originalhtml || result?.originalhtml || null,
  };
}

// Caches a finished job's result and injects it into the tab as an image swap and/or overlay.
export async function handleResult(jobId, result) {
  const ctx = findContext(jobId, result?.metadata?.image_id);
  if (!ctx) {
    log.warn("result for unknown job", { id: jobId });
    return;
  }

  const { imgUrl, tabId } = ctx;
  const frameId = ctx.frameId || 0;
  const mode = ctx.mode || ctx.metadata?.mode || null;

  const batchId = String(ctx.batchId || ctx.metadata?.batch_id || "").trim();
  const imageKey = String(
    ctx.imageKey || ctx.metadata?.image_id || result?.metadata?.image_id || "",
  ).trim();
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;

  const newImg = extractNewImage(result);
  const { aiHtml, translatedHtml, originalHtml } = extractHtml(result);
  void (async () => {
    try {
      const key =
        (ctx.seriesKey && String(ctx.seriesKey)) ||
        (await resolveSeriesKey(ctx.pageUrl || "")) ||
        "default";
      await accumulateSeriesMemory(key, result);
    } catch {
    }
  })();
  const hasHtml = Boolean(
    aiHtml || translatedHtml || originalHtml || result?.lensDocument?.paragraphs?.length,
  );
  const skipReason = textSkipReason(result);
  const shouldShowSkipBadge = mode === "lens_text" && Boolean(skipReason);

  const cacheKey = mdCacheKey(
    mdKeyFromUrl(imgUrl),
    ctx.lang || ctx.metadata?.lang,
    mode,
    ctx.source || ctx.metadata?.source,
  );
  if (cacheKey && (newImg || hasHtml)) {
    const sourceImageKey = result?.sourceImageDataUri ? normImgSrc(imgUrl) : "";
    if (sourceImageKey) setCachedDataUri(sourceImageKey, result.sourceImageDataUri);
    setCachedResult(cacheKey, {
      newImg: newImg || null,
      result: hasHtml
        ? { ...stripImageFields(result), ...(sourceImageKey ? { sourceImageKey } : {}) }
        : null,
    });
  }

  const curSession = getTabSessionId(tabId);
  const settingsStale =
    typeof ctx.settingsEpoch === "number" && ctx.settingsEpoch !== settingsEpoch;
  const isStale =
    Boolean(ctx.sessionId && curSession && ctx.sessionId !== curSession) || settingsStale;

  if (isStale) {
    await wf.failed(
      String(ctx.workflowId || ""),
      settingsStale ? "settings changed while the job was in flight" : "tab navigated away",
    );
    removeJob(jobId, result?.metadata?.image_id);
    if (batch && imageKey) {
      if (ctx.keepCacheOnStale) {
        batchMark(batchId, imageKey, { status: "done", cachedOnly: true });
        batchUpdateToast(batch, "Saved", true);
      } else {
        batchMark(batchId, imageKey, { status: "aborted" });
        batchUpdateToast(batch, "Cancelled", true);
      }
      finalizeBatch(batch);
    }
    return;
  }

  if (batch && imageKey) {
    batchMark(batchId, imageKey, { status: "inserting" });
    batchUpdateToast(batch, "Inserting");
  }

  const workflowId = String(ctx.workflowId || "");
  await wf.renderReady(workflowId);
  await wf.applyRequested(workflowId, `apply:${jobId}`);

  let replaceOk = null;
  if (newImg && mode !== "lens_text") {
    replaceOk = await enqueueDomInsert(
      tabId,
      { type: "REPLACE_IMAGE", original: imgUrl, newSrc: newImg, tpTrace: ctx.traceId || "" },
      frameId,
    );
  }

  let overlayOk = null;
  if (hasHtml || shouldShowSkipBadge) {
    overlayOk = await enqueueDomInsert(
      tabId,
      {
        type: "OVERLAY_HTML",
        original: imgUrl,
        result,
        mode: mode || "",
        source: ctx.source || "",
        generation: ctx.generation || null,
        tpTrace: ctx.traceId || "",
      },
      frameId,
    );
  }

  let ok = true;
  let errMsg = "";
  if (!hasHtml && !(newImg && mode !== "lens_text")) {
    if (!newImg) {
      if (isTextNoOverlaySkippable(mode, ctx.source || result?.source || "", result)) {
        const item = batch && imageKey ? batch.items.get(imageKey) : null;
        // An explicit reason is the extension's own verdict on decoded text; re-running Lens cannot change it.
        const decided = Boolean(skipReason);
        if (!decided && item && Number(item.attempt || 1) < 2) {
          ok = false;
          errMsg = "No text detected (retrying)";
        } else {
          ok = true;
          errMsg = "No text detected";
        }
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
  }
  if (newImg && mode !== "lens_text" && !replaceOk?.ok) {
    ok = false;
    errMsg = "DOM replace failed";
  }
  if (hasHtml && !overlayOk?.ok) {
    ok = false;
    errMsg = "Overlay insert failed";
  }

  if (ok) await wf.applied(workflowId);
  else await wf.failed(workflowId, errMsg || "the page did not take the overlay");
  traceNote("background/jobs.js", "imageStage", {
    stage: "insert", state: ok ? "finished" : "failed", imageId: imageKey, error: errMsg,
  }, String(ctx.traceId || ""));

  removeJob(jobId, result?.metadata?.image_id);

  if (batch && imageKey) {
    if (ok) {
      const skipped = errMsg === "No text detected";
      batchMark(batchId, imageKey, {
        status: skipped ? "skipped" : "done",
        lastError: skipped ? errMsg : "",
      });
      batchUpdateToast(batch, skipped ? "Skipped: no text" : "1 image done");
    } else {
      const cls = classifyJobError(errMsg, {
        aiRouteEntered: Boolean(ctx?.aiRouteEntered),
        aiGenerationAttempted: Boolean(ctx?.aiGenerationAttempted),
      });
      batchMark(batchId, imageKey, {
        status: "error",
        lastError: errMsg || "Unknown error",
        permanent: !!cls.permanent,
      });
      batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
    }
    finalizeBatch(batch);
  }
}

// Closes a batch pass: schedules the single retry pass after pass 1, announces completion after pass 2.
export function finalizeBatch(b) {
  if (!b) return;
  const s = batchPassStats(b);
  if (!s.total || s.finished < s.total) return;

  if (b.pass === 1) {
    if (b.retryScheduled) return;

    const { failed, permanentErrors } = selectBatchRetryCandidates(b.items);

    if (!failed.length) {
      batchUpdateToast(b, permanentErrors ? `Done (${permanentErrors} errors)` : "Done", true);
      void batchStopKeepAlive(b);
      return;
    }

    b.retryScheduled = true;
    b.pass = 2;
    b.total2 = failed.length;
    for (const k of failed) {
      const it = b.items.get(k);
      if (!it) continue;
      b.items.set(k, {
        ...it,
        payload: withPipelineStage(it.payload, "retry_failed_once"),
        attempt: 2,
        status: "queued",
      });
    }
    batchUpdateToast(b, `Retrying ${failed.length} failed image(s) shortly`, true);
    addTask(() => runRetryPass(b));
    return;
  }

  batchUpdateToast(b, s.error ? `Done (${s.error} errors)` : "Done", true);
  void batchStopKeepAlive(b);
}

// Returns a copy of a payload with a pipeline stage marker appended to its metadata.
function withPipelineStage(payload, stage) {
  const meta = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const pipeline = Array.isArray(meta.pipeline) ? meta.pipeline : [];
  return {
    ...payload,
    metadata: {
      ...meta,
      pipeline: pipeline.concat({ stage, at: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    },
  };
}

// Re-runs the failed images of a batch as pass 2, re-attaching data URIs.
async function runRetryPass(b) {
  await new Promise((r) => setTimeout(r, BATCH_RETRY_GAP_MS));

  const payloads = [];
  for (const it of b.items.values()) {
    if (it?.attempt === 2 && it.status === "queued" && it.payload) payloads.push(it.payload);
  }
  batchUpdateToast(b, "Starting retry pass", true);

  for (const pl of payloads) {
    let next = pl;
    let skip = false;
    try {
      const src = String(pl?.src || "").trim();
      if (src && /^https?:/i.test(src) && !pl?.imageDataUri) {
        const pageUrl = pl?.context?.page_url || "";
        const key = normImgSrc(src);
        const du = getCachedDataUri(key) || (await fetchImageDataUriFromUrl(src, pageUrl));
        if (du) {
          next = withPipelineStage({ ...pl, imageDataUri: du }, "retry_attach_datauri");
          setCachedDataUri(key, du);
          const k = imageKeyFromPayload(next);
          if (k && b.items.has(k)) b.items.set(k, { ...b.items.get(k), payload: next });
        }
      }
    } catch (e) {
      const msg = String(e?.message || e);
      const cls = /\bHTTP 403\b/i.test(msg) ? { permanent: false } : classifyJobError(msg);
      const k = imageKeyFromPayload(pl);
      if (k && b.items.has(k)) {
        const it = b.items.get(k);
        b.items.set(k, {
          ...it,
          lastError: msg,
          status: cls.permanent ? "error" : it.status,
          permanent: cls.permanent,
        });
        if (cls.permanent) {
          batchUpdateToast(b, "Error (permanent)");
          finalizeBatch(b);
        }
      }
      if (cls.permanent) skip = true;
    }
    if (!skip) enqueue(next, b.tabId, b.frameId || 0);
  }
}

// Serialises a value with object keys sorted, so equal values hash equally.
function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableString).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableString(value[k])).join(",") + "}";
}

// Returns the hex SHA-256 digest of a string.
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Builds the idempotency key identifying a payload's mode, language, source, image and AI settings.
async function idempotencyKeyForPayload(payload) {
  const mode = String(payload?.mode || "");
  const lang = String(payload?.lang || "");
  const source = String(payload?.source || "");
  const src = normImgSrc(payload?.src || "");
  const dataUri = typeof payload?.imageDataUri === "string" ? payload.imageDataUri : "";
  const dataFingerprint = dataUri
    ? await sha256Hex(`${dataUri.length}:${dataUri.slice(0, 4096)}:${dataUri.slice(-4096)}`)
    : "";
  const ai = payload?.ai && typeof payload.ai === "object"
    ? { model: payload.ai.model || "", provider: payload.ai.provider || "", prompt: payload.ai.prompt || "" }
    : null;
  return sha256Hex(stableString({ mode, lang, source, src, dataFingerprint, ai }));
}

// Registrable domains whose images must be fetched in the browser; seeded with CDNs that reject datacenter IPs.
const dataUriDomains = new Set([
  "uploads.mangadex.org",
]);

// Returns the hostname of a URL, or "" when unparseable.
function hostOf(u) {
  try {
    return new URL(String(u || "")).hostname;
  } catch {
    return "";
  }
}

// Exact hostname is the domain-memory key.  Collapsing to the last two labels
// is unsafe for public suffixes such as co.uk and can make an unrelated site
// inherit another host's anti-hotlink workaround.
function domainKeyOf(u) {
  return hostOf(u).toLowerCase();
}

// Records that this image's domain needs browser-side bytes.
export function markDomainNeedsDataUri(src) {
  const key = domainKeyOf(src);
  if (key) dataUriDomains.add(key);
}

// Returns whether this payload's image must be downloaded in the browser as a data URI.
function shouldPrefetchDataUri(payload) {
  if (payload?.imageDataUri) return false;
  const src = String(payload?.src || "").trim();
  if (!src) return false;
  if (/^(?:blob:|data:|file:|chrome-extension:)/i.test(src)) return true;
  if (/^https?:/i.test(src)) {
    return dataUriDomains.has(domainKeyOf(src));
  }
  return (
    payload?.mode === "lens_text" &&
    String(payload?.source || "").toLowerCase() === "ai"
  );
}

// Returns whether a payload carries only an image URL and no inlined bytes.
function isUrlOnlyPayload(payload) {
  return Boolean(
    payload &&
    !payload.imageDataUri &&
    /^https?:/i.test(String(payload.src || "").trim()),
  );
}

// Processes one image payload end to end, from data-URI prefetch to the translate call.
export async function processJob(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;
  return processJobInner(payload, tabId, frameId);
}

async function processJobInner(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;

  if (!payload.metadata || typeof payload.metadata !== "object") payload.metadata = {};
  const batchId = String(payload.metadata.batch_id || currentBatchId || "").trim();
  if (batchId) payload.metadata.batch_id = batchId;
  // A batch may be cancelled after leaving the page but before this queued
  // function is admitted. Do not recreate workflow/status or contact Lens/AI.
  if (batchId && getBatch(batchId)?.cancelled) return;
  const imageKey = imageKeyFromPayload(payload);
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;
  let traceId = "";

  const pageUrl = payload?.context?.page_url || "";
  const isMd = isMangaDexPageUrl(pageUrl);

  const originSession = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  const curSession = getTabSessionId(tabId);
  if (originSession && curSession && originSession !== curSession && !isMd) {
    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: "navigation" });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
      batchStopKeepAlive(batch);
    }
    return;
  }

  if (batch && imageKey) {
    const it = batch.items.get(imageKey);
    if (it) batch.items.set(imageKey, { ...it, status: "processing" });
    batchUpdateToast(batch, "Processing");
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

  // CANCEL_BATCH can run while wf.begin yields. Close the workflow record but
  // do not register the image or begin any API/image request for this job.
  const stopIfBatchWasCancelled = async () => {
    if (!(batchId && getBatch(batchId)?.cancelled)) return false;
    await wf.failed(workflowId, "cancelled with batch");
    return true;
  };
  if (await stopIfBatchWasCancelled()) return;

  const base = await getApiBase();

  // getApiBase may yield to storage. Recheck immediately before the first
  // external prefetch and again later before registry/capability work.
  if (await stopIfBatchWasCancelled()) return;

  if (shouldPrefetchDataUri(payload)) {
    const src = String(payload.src || "").trim();
    const key = normImgSrc(src);
    const cached = getCachedDataUri(key);
    if (cached) {
      payload.imageDataUri = cached;
    } else {
      const tPrefetch = Date.now();
      const browserOnlySrc = /^(?:blob:|file:|chrome-extension:|moz-extension:)/i.test(src);
      try {
        const du = src.startsWith("data:")
          ? src
          : browserOnlySrc
            ? await fetchImageDataUriFromTab(tabId, src, frameId || 0)
            : await fetchImageDataUriFromUrl(src, pageUrl || "");
        if (du) {
          log.info("datauri prefetch ok", {
            ms: Date.now() - tPrefetch,
            kb: Math.round(du.length / 1024),
          });
          payload.imageDataUri = du;
          if (key) setCachedDataUri(key, du);
          const meta = payload.metadata;
          meta.pipeline = (Array.isArray(meta.pipeline) ? meta.pipeline : []).concat({
            stage: "prefetch_datauri",
            at: new Date().toISOString(),
          });
          meta.timestamp = new Date().toISOString();
          if (batch && imageKey) batchMark(batchId, imageKey, { payload });
        }
      } catch (e) {
        let errMsg = e?.message || String(e);
        if (!browserOnlySrc && /\bHTTP 403\b/i.test(errMsg) && tabId) {
          try {
            const du = await fetchImageDataUriFromTab(tabId, src, frameId || 0);
            if (du) {
              log.info("datauri prefetch ok (tab fallback)", {
                ms: Date.now() - tPrefetch,
                kb: Math.round(du.length / 1024),
              });
              payload.imageDataUri = du;
              if (key) setCachedDataUri(key, du);
              const meta = payload.metadata;
              meta.pipeline = (Array.isArray(meta.pipeline) ? meta.pipeline : []).concat({
                stage: "prefetch_datauri_tab",
                at: new Date().toISOString(),
              });
              meta.timestamp = new Date().toISOString();
              if (batch && imageKey) batchMark(batchId, imageKey, { payload });
              errMsg = null;
            }
          } catch (e2) {
            errMsg = e2?.message || String(e2);
            log.warn("datauri prefetch tab fallback failed", { err: errMsg });
          }
        }
        if (errMsg) {
          // blob:/file:/extension URLs are meaningful only inside the browser.
          // If the owning tab cannot provide bytes, sending that URL to the
          // server can only produce a guaranteed 400 and must never happen.
          const cls = browserOnlySrc ? { permanent: true } : classifyJobError(errMsg);
          log.warn("datauri prefetch failed", { err: errMsg, permanent: cls.permanent });
          if (cls.permanent) {
            if (payload?.metadata?.image_id) pendingByImage.delete(payload.metadata.image_id);
            if (batch && imageKey) {
              batchMark(batchId, imageKey, { status: "error", lastError: errMsg, permanent: true });
              batchUpdateToast(batch, "Error (permanent)");
              finalizeBatch(batch);
            }
            await wf.failed(workflowId, `image could not be fetched: ${errMsg}`);
            failJobImmediately(tabId, payload?.src || null, errMsg, frameId, traceId);
            return;
          }
        }
      }
    }
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
    settingsEpoch,
    traceId,
    ...extra,
  });

  // Create and stamp the trace before capability routing so a compatibility
  // stop and the registry context are correlated just like a request that
  // reaches either engine.
  traceId = newTraceId();
  if (!payload.context || typeof payload.context !== "object") payload.context = {};
  payload.context.tp_trace = traceId;
  setTrace(traceId);

  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, makeContext());
  }

  const caps = await getCapabilities(base);
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
      return getCapabilities(base);
    },
  );

  const compatibilityIssue = engineCompatibilityIssue(payload, caps);
  if (compatibilityIssue) {
    traceNote("background/jobs.js", "engineRoute", {
      engine: "extension", outcome: "stopped", reason: compatibilityIssue,
      mode: payload.mode, source: payload.source, syncPath: false,
    }, traceId);
    log.error("extension route stopped before legacy submit", { reason: compatibilityIssue });
    await wf.failed(workflowId, compatibilityIssue);
    if (payload?.metadata?.image_id) pendingByImage.delete(payload.metadata.image_id);
    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "error", lastError: compatibilityIssue, permanent: true });
      batchUpdateToast(batch, "Compatibility error");
      finalizeBatch(batch);
    }
    failJobImmediately(tabId, payload?.src || null, compatibilityIssue, frameId, traceId);
    return;
  }
  // The API reports the slots each of its lanes currently holds. Matching the
  // Lens lane to that number keeps the queue on this side, where it is visible,
  // instead of inside the API where the extension cannot see or measure it.
  const lensSlots = Number(caps?.adaptive?.lens?.limit) || Number(caps?.capacity?.limit) || 0;
  if (lensSlots > 0) setLaneSlotCeiling("lens:direct", lensSlots);
  const aiSlots = Number(caps?.adaptive?.ai?.limit) || Number(caps?.capacityAi?.limit) || 0;
  if (aiSlots > 0 && payload?.mode === "lens_text" && payload?.source === "ai") {
    const activeBurst = payload?.rate?.enabled === true ? Number(payload?.rate?.burst) || 0 : 0;
    setLaneCapacityHint(laneKeyFor(payload), aiSlots, activeBurst);
  }
  const onnxSlots = Number(caps?.adaptive?.onnx?.limit) || 0;
  if (onnxSlots > 0) setLaneSlotCeiling("onnx:groups", onnxSlots);
  await sendToTab(tabId, {
    type: "TP_DIAGNOSTICS_STATE",
    enabled: caps.trace,
    detail: caps.traceDetail,
    consoleLevel: caps.consoleLevel || "warn",
  }, frameId);

  traceNote("background/jobs.js", "runTranslateJob", {
    clientBuild: String(chrome?.runtime?.getManifest?.()?.version || "unknown"),
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
  }, traceId);

  if (caps.syncTranslate) {
    await runSyncTranslate(base, payload, makeContext, {
      tabId, frameId, batch, batchId, imageKey, workflowId,
    });
    return;
  }

  await submitAndPollRest(base, payload, makeContext, {
    tabId, frameId, batch, batchId, imageKey, workflowId,
  });
}

// Returns a payload's image as compact binary bytes with its mime type and data URI.
async function imageBytesFor(payload, tabId, frameId) {
  const inline = String(payload?.imageDataUri || "").trim();
  if (inline.startsWith("data:")) {
    const res = await fetch(inline);
    const buffer = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      mime: res.headers.get("content-type") || "image/jpeg",
      dataUri: inline,
    };
  }

  const src = String(payload?.src || "").trim();
  if (!src) return null;
  const dataUri = await fetchImageDataUriFromUrl(src, payload?.context?.page_url || "").catch(
    async (e) => {
      if (/\bHTTP 403\b/i.test(e?.message || "") && tabId) {
        return fetchImageDataUriFromTab(tabId, src, frameId || 0);
      }
      throw e;
    },
  );
  if (!dataUri) return null;
  const res = await fetch(dataUri);
  const buffer = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    mime: res.headers.get("content-type") || "image/jpeg",
    dataUri,
  };
}

// Decodes and lays out one image locally from `/v1/lens/raw`, returning a result, or null with
// `decline.reason` set to the reason this image could not be drawn in the browser.
// The API owns the Lens upload because Lens rejects extension-origin uploads.
async function runLensDirectPath(base, payload, { tabId, frameId, signal = null, decline = {} }) {
  const stop = (reason) => {
    decline.reason = String(reason || "the local route declined this image");
    return null;
  };
  if (payload?.mode !== "lens_text") return stop("not a lens_text job");

  if (!payload?.render?.lensDocument) return stop("this job did not ask for a local document");

  const size = payload?.naturalSize;
  if (!(size?.width > 0) || !(size?.height > 0)) {
    log.info("lens path skipped: the page did not report the image size", {
      src: payload?.src,
    });
    return stop("the page did not report the image size");
  }

  let image;
  try {
    image = await imageBytesFor(payload, tabId, frameId);
  } catch (e) {
    log.info("lens path skipped: could not read the image bytes", {
      error: e?.message || String(e),
    });
    return stop(`could not read the image bytes: ${e?.message || String(e)}`);
  }
  if (!image) return stop("the image reader returned nothing to upload");

  let lens;
  let lensImageSize;
  let imageArtifactToken = "";
  try {
    const stageTrace = String(payload?.context?.tp_trace || "");
    traceNote("background/jobs.js", "imageStage", {
      stage: "lens", state: "started", imageId: payload?.metadata?.image_id || "",
    }, stageTrace);
    const answer = await runStageInLane("lens:direct", () => fetchLensRawViaRest(base, {
      imageBytes: image.bytes,
      mime: image.mime,
      lang: payload.lang,
      signal,
      traceId: String(payload?.context?.tp_trace || getTrace() || ""),
      batchId: String(payload?.metadata?.batch_id || ""),
      tabSession: String(payload?.context?.tp_tab_session || ""),
      apiUnlimited: payload?.limits?.apiUnlimited === true,
    }), {
      signal, stage: "lens", imageId: payload?.metadata?.image_id || "", traceId: stageTrace,
    });
    traceNote("background/jobs.js", "imageStage", {
      stage: "lens", state: "finished", imageId: payload?.metadata?.image_id || "",
    }, stageTrace);
    lens = answer?.lens;
    if (!lens || typeof lens !== "object") {
      throw new Error("the raw Lens reply carried no `lens` object");
    }
    lensImageSize = authoritativeLensImageSize(answer?.image);
    imageArtifactToken = String(answer?.imageArtifact?.token || "").trim();
    traceNote("background/jobs.js", "lensImageDimensions", {
      authoritative: lensImageSize,
      domNatural: { width: Number(size.width), height: Number(size.height) },
      mismatch: lensImageSize.width !== Number(size.width) || lensImageSize.height !== Number(size.height),
      artifactToken: imageArtifactToken ? "present" : "absent",
    }, stageTrace);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    log.warn("lens upload failed for this image; extension route stopped", {
      error: e?.message || String(e),
      permanent: Boolean(e?.permanent),
    });
    log.info("tp.route", {
      stage: "lens",
      outcome: "stopped",
      reason: `/v1/lens/raw failed: ${e?.message || String(e)}`,
      source: payload.source,
    });
    return stop(`/v1/lens/raw failed: ${e?.message || String(e)}`);
  }

  let decoded;
  try {
    decoded = decodeLensResponse(lens, {
      width: lensImageSize.width,
      height: lensImageSize.height,
      targetLang: payload.lang,
    });
  } catch (e) {
    log.warn("local lens decode failed; extension route stopped", {
      error: e?.message || String(e),
      name: e?.name || "Error",
    });
    log.info("tp.route", {
      stage: "lens",
      outcome: "stopped",
      reason: `local decode threw ${e?.name || "Error"}: ${e?.message || String(e)}`,
      source: payload.source,
    });
    return stop(`local Lens decode threw ${e?.name || "Error"}: ${e?.message || String(e)}`);
  }

  if (decoded.warnings.length) {
    log.warn("lens decode dropped part of this page", {
      src: payload?.src,
      warnings: decoded.warnings,
    });
  }

  log.info("lens axis decided here", {
    src: payload?.src,
    needsGroups: decoded.groups.needed,
    reason: decoded.groups.reason,
    counts: decoded.groups.counts,
  });
  let document = decoded.document;
  if (decoded.groups.needed) {
    let grouped;
    try {
      if (!image.dataUri) {
        throw new Error("the image reader returned no data URI to group with");
      }
      const stageTrace = String(payload?.context?.tp_trace || "");
      traceNote("background/jobs.js", "imageStage", {
        stage: "onnx", state: "started", imageId: payload?.metadata?.image_id || "",
      }, stageTrace);
      grouped = await runStageInLane("onnx:groups", () => groupParagraphsWithArtifactFallback(base, {
        imageDataUri: image.dataUri,
        imageArtifactToken,
        tree: decoded.trees.grouping,
        context: {
          tp_trace: String(payload?.context?.tp_trace || ""),
          tp_tab_session: String(payload?.context?.tp_tab_session || ""),
          batch_id: String(payload?.metadata?.batch_id || ""),
        },
        signal,
        apiUnlimited: payload?.limits?.apiUnlimited === true,
      }), {
        signal, stage: "onnx", imageId: payload?.metadata?.image_id || "", traceId: stageTrace,
      });
      traceNote("background/jobs.js", "imageStage", {
        stage: "onnx", state: "finished", imageId: payload?.metadata?.image_id || "",
        coverage: grouped?.coverage || null,
        mergeApplied: Boolean(grouped?.merge?.applied),
        mergeUsable: grouped?.merge?.usable === true,
        mergeOutcome: String(grouped?.merge?.outcome || ""),
        mergeAuthority: String(grouped?.merge?.authority || ""),
        uncovered: grouped?.merge?.uncovered || null,
        retry: grouped?.retry || null,
      }, stageTrace);
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      log.warn("grouping failed for this vertical page; extension route stopped", {
        error: e?.message || String(e),
        permanent: Boolean(e?.permanent),
      });
      log.info("tp.route", {
        stage: "lens",
        outcome: "stopped",
        reason: `/v1/groups failed: ${e?.message || String(e)}`,
        source: payload.source,
      });
      return stop(`/v1/groups failed: ${e?.message || String(e)}`);
    }

    // The detector deliberately saw the raw Lens paragraph set. Convert its
    // memberships back to the furigana-filtered document before deciding
    // usability; otherwise a ruby-only accepted group could make AI appear
    // grouped even though attach would produce no translation unit.
    if (Array.isArray(grouped?.tree?.bubble_groups)) {
      grouped.tree.bubble_groups = remapRawBubbleGroups(
        grouped.tree.bubble_groups,
        decoded.groupingRawToDocument,
      );
    }
    const coverage = grouped?.coverage || {};
    const mergeContract = decideVerticalMerge(grouped, payload?.source);
    const mergeUsable = mergeContract.usable;
    const mergeOutcome = String(grouped?.merge?.outcome || "unusable");
    const uncovered = grouped?.merge?.uncovered || {};
    const uncoveredIndices = Array.isArray(uncovered?.indices)
      ? uncovered.indices.map((value) => Number(value)).filter(Number.isInteger)
      : [];
    const isAiSource = mergeContract.ai;
    traceNote("background/jobs.js", "verticalVerdict", {
      outcome: mergeOutcome,
      usable: mergeUsable,
      contract: mergeContract.contract,
      malformed: mergeContract.malformed,
      authority: String(grouped?.merge?.authority || ""),
      uncoveredDisposition: String(uncovered?.disposition || ""),
      uncoveredIndices,
      source: String(payload?.source || ""),
      decision: mergeContract.decision,
    }, String(payload?.context?.tp_trace || ""));

    if (!mergeUsable && isAiSource) {
      log.info("tp.route", {
        stage: "lens",
        outcome: "stopped",
        reason: `vertical grouping is unusable: ${grouped?.merge?.reason || "no reason given"}`,
        source: payload.source,
        uncoveredIndices,
      });
      return stop(
        "ONNX grouped nothing on this vertical page " +
        `(columns ${Number(coverage.vertical) || 0}, stamped ${Number(coverage.stampedVertical) || 0}, ` +
        `uncovered [${uncoveredIndices.join(", ") || "unknown"}]): ` +
        `${grouped?.merge?.reason || "the merge did not apply"}`,
      );
    }
    if (!mergeUsable) {
      log.warn("vertical grouping unusable; final Lens text continues ungrouped", {
        src: payload?.src,
        source: payload?.source,
        outcome: mergeOutcome,
        uncoveredIndices,
        reason: grouped?.merge?.reason || "no reason given",
      });
    } else if (mergeOutcome === "partial") {
      log.warn("using verified ONNX groups with isolated uncovered units", {
        src: payload?.src,
        coverage,
        reason: grouped?.merge?.reason || "partial ONNX coverage",
      });
    }
    if (grouped.warnings?.length) {
      log.warn("grouping came back partial", {
        src: payload?.src,
        warnings: grouped.warnings,
      });
    }

    try {
      if (mergeUsable) document = attachBubbleGroups(document, grouped.tree?.bubble_groups);
    } catch (e) {
      log.warn("the grouping does not fit this document; extension route stopped", {
        error: e?.message || String(e),
      });
      log.info("tp.route", {
        stage: "lens",
        outcome: "stopped",
        reason: `grouping did not fit the document: ${e?.message || String(e)}`,
        source: payload.source,
      });
      return stop(`the ONNX grouping does not fit this document: ${e?.message || String(e)}`);
    }
    log.info(mergeUsable ? "vertical page grouped before translation" : "vertical page kept ungrouped", {
      src: payload?.src,
      paragraphs: document.paragraphs.length,
      units: translationUnits(document).length,
    });
  }

  const requestedSource = String(payload.source || "translated");
  const fidelitySource = requestedSource === "ai" ? "original" : requestedSource;
  const fidelity = canRenderFaithfully(document, fidelitySource);
  if (!fidelity.ok) {
    log.info("tp.route", {
      stage: "lens",
      outcome: "stopped",
      reason: `lens-direct produced a document the renderer cannot draw: ${fidelity.reason}`,
      source: payload.source,
    });
    return stop(`the local renderer cannot draw this document: ${fidelity.reason}`);
  }

  return {
    mode: payload.mode,
    backgroundMode: "boxes",
    eraseBoxes: decoded.eraseBoxes,
    // sourceImageDataUri is an internal extension hand-off and is never sent to the API.
    sourceImageDataUri: image.dataUri,
    lensDocument: document,
    layout: payload?.layout || null,
    htmlMeta: { baseW: size.width, baseH: size.height, format: "tp", path: "lens_direct" },
    originalTextFull: String(lens?.originalTextFull || ""),
    metadata: payload.metadata,
    perf: { path: "lens_raw" },
  };
}

// Builds the extension-first AI route plan for a payload, or null when the payload is not an AI text job.
async function planLocalAi(payload) {
  if (payload?.mode !== "lens_text" || payload?.source !== "ai") return null;
  if (!payload?.render?.lensDocument) return null;

  const ai = payload.ai && typeof payload.ai === "object" ? payload.ai : null;
  const route = "server";
  const reason = "AI text translation is API-owned; geometry and HTML are extension-owned";
  const plan = { route, reason, ai, originalSource: payload.source };
  log.info(route === "server" ? "AI will use the text-only API" : "AI will run in the browser", {
    route,
    reason,
  });
  return plan;
}

// Returns a payload copy that asks the full server endpoint to render the background image.
function payloadForFullServer(payload) {
  return {
    ...payload,
    render: {
      ...(payload?.render || {}),
      background: "image",
      // On the API engine the server also owns the document, so it must not be
      // asked for one the extension would then have to render itself.
      ...(payload?.engine === "api" ? { lensDocument: false } : {}),
    },
  };
}

// Translates the result's LensDocument and patches it back, returning true when the AI text is complete.
// No retry: an incomplete AI answer is reported, not re-requested.
async function runLocalAi(
  base, payload, result, plan, cancelBatchId = "", signal = null,
  telemetry = null, onGenerationAttempt = null,
) {
  const doc = requireAiLensDocument(result);
  const units = translationUnits(doc);
  // Units Lens read as digits, punctuation or symbols only are kept verbatim and never sent.
  const sendable = units.filter((u) => u.translatable);
  const passthrough = units
    .filter((u) => !u.translatable)
    .map((u) => ({ id: u.id, text: u.text }));
  if (!units.length) {
    log.info("no text to translate; nothing for the AI layer to do");
    markNoTranslatableText(result, "no_text");
    return { usable: true, complete: true, skipped: true, translated: 0, missing: [] };
  }
  if (!sendable.length) {
    log.info("no translatable text; every unit is digits or symbols", { units: units.length });
    markNoTranslatableText(result, "no_translatable_text");
    return { usable: true, complete: true, skipped: true, translated: 0, missing: [] };
  }

  const memoryMode = String(plan.ai?.memory_mode || "off");
  const seriesKey = String(payload?.context?.series_key || "");
  if (seriesKey && memoryMode !== "off") {
    const recent = selectPromptMemory(await getSeriesMemory(seriesKey));
    const pageIndex = Number(payload?.context?.page_index);
    const memoryBatchId = String(payload?.context?.batch_id || payload?.metadata?.batch_id || "");
    const previousPage = Number.isInteger(pageIndex) && pageIndex > 0
      ? recent.pageContexts?.[memoryBatchId]?.[String(pageIndex - 1)] || []
      : [];
    plan.ai = {
      ...plan.ai,
      glossary: memoryMode === "terms" || memoryMode === "full" ? recent.glossary : [],
      characters: memoryMode === "full" ? recent.characters : [],
      series_state: memoryMode === "full" ? recent.state : "",
      prev_context: memoryMode === "full" ? previousPage : [],
    };
  }

  // Prompt composition lives exclusively in `/v1/ai/translate`.
  const systemText = "";
  const promptAudit = null;

  const operationBase = `ai:${String(payload?.idempotency_key || payload?.metadata?.image_id || "")}`;
  const translate = (selectedUnits, operationId) => translateUnits(selectedUnits, {
    route: plan.route,
    ai: plan.ai,
    rate: payload?.rate || null,
    unlimited: payload?.limits?.aiUnlimited === true,
    imageDataUri: plan.ai?.send_image ? String(result?.sourceImageDataUri || payload?.imageDataUri || "") : "",
    targetLang: String(payload.lang || ""),
    sourceLang: String(doc?.languages?.source || ""),
    systemText,
    promptAudit,
    base,
    operationId,
    batchId: cancelBatchId,
    signal,
    traceId: String(payload?.context?.tp_trace || getTrace() || ""),
    trace: (event, data) => traceNote(
      "background/ai-local.js",
      "translateUnits",
      { event, ...data },
      String(payload?.context?.tp_trace || getTrace() || ""),
    ),
  });

  let outcome;
  const memoryCharacters = [];
  const memoryGlossary = [];
  const collectMemoryDelta = (answer) => {
    const delta = answer?.memoryDelta || {};
    if (Array.isArray(delta.characters)) memoryCharacters.push(...delta.characters);
    if (Array.isArray(delta.glossary)) memoryGlossary.push(...delta.glossary);
  };
  try {
    outcome = await translate(sendable, operationBase);
    if (Number(outcome?.meta?.generationAttempts || 0) > 0) onGenerationAttempt?.();
    collectMemoryDelta(outcome);
  } catch (e) {
    // A request can fail BEFORE the model was ever called (server admission, an
    // optional rate gate, cancellation). Preserve that distinction so the lane
    // may safely re-submit the same idempotency key without spending another
    // generation. Only mark a generation when the server explicitly says a
    // model generation occurred.
    if (Number(e?.generationAttempts || 0) > 0) onGenerationAttempt?.();
    log.warn("text-only AI failed", {
      route: plan.route,
      code: e?.code,
      providerAttempts: Number(e?.providerAttempts || 0),
      error: e?.message || String(e),
      willRetryFullPipeline: false,
    });
    const traceId = String(payload?.context?.tp_trace || getTrace() || "");
    traceNote("background/jobs.js", "imageStage", {
      stage: "ai",
      state: e?.name === "AbortError" ? "cancelled" : "failed",
      imageId: String(payload?.metadata?.image_id || ""),
      failureKind: e?.name === "AbortError" ? "cancelled" :
        (Number(e?.status) ? "http_or_provider" : "transport_or_output_contract"),
      status: Number(e?.status) || 0,
      code: String(e?.code || ""),
      providerAttempts: Number(e?.providerAttempts || 0),
      errorType: e?.name || "Error",
      error: e?.message || String(e),
      automaticContentRetry: false,
    }, traceId);
    throw e;
  }

  if (telemetry) {
    const m = outcome?.meta || {};
    telemetry.providerMs = Number(m.providerMs);
    telemetry.serverTotalMs = Number(m.dt_ms);
    telemetry.replayed = outcome?.replayed === true;
    telemetry.rateWaitMs = Number(m.rateWaitMs);
    telemetry.admissionWaitMs = Number(m.admissionWaitMs);
    telemetry.rate = m.rate && typeof m.rate === "object" ? m.rate : null;
  }
  let mergedTranslations = Array.isArray(outcome.translations) ? [...outcome.translations] : [];
  if (passthrough.length) mergedTranslations.push(...passthrough);
  let applied = applyTranslations(doc, mergedTranslations);
  const missingUnitIds = applied.report.missing.map(String);
  const missingUnits = missingUnitIds.map((id) => {
    const unit = sendable.find((candidate) => candidate.id === id);
    return { id, paragraphIds: (unit?.paragraphIds || []).map(String) };
  });
  const translatedCount = sendable.length - missingUnitIds.length;
  // `outcome.missing` is the SERVER's list of units with no usable text — the
  // same set as `missingUnitIds`. Logging it under `omittedByProvider` named
  // the effect after a cause it had not established, and made every partial
  // page read as a broken output contract. The provider's own two answers come
  // from meta: `omittedIds` (the entry was never returned) and `declinedIds`
  // (the entry came back holding an empty string).
  const omittedByProvider = Array.isArray(outcome?.meta?.omittedIds)
    ? outcome.meta.omittedIds.map(String) : [];
  const declinedByProvider = Array.isArray(outcome?.meta?.declinedIds)
    ? outcome.meta.declinedIds.map(String) : [];
  if (missingUnitIds.length) {
    const traceId = String(payload?.context?.tp_trace || getTrace() || "");
    // A partial answer is drawn as far as it goes; the units the model skipped are named, not filled.
    log.warn("AI answered part of this page; the rest is left untranslated", {
      route: plan.route,
      expected: sendable.length,
      translated: translatedCount,
      missing: missingUnitIds.length,
      missingUnitIds,
      missingUnits,
      omittedByProvider,
      declinedByProvider,
    });
    traceNote("background/jobs.js", "imageStage", {
      stage: "ai",
      state: translatedCount > 0 ? "partial" : "empty",
      imageId: String(payload?.metadata?.image_id || ""),
      failureKind: "missing_translation_units",
      expected: sendable.length,
      translated: translatedCount,
      missing: missingUnitIds.length,
      missingUnitIds,
      missingSourceText: missingUnitIds.map((id) => {
        const unit = sendable.find((u) => u.id === id);
        return { id, chars: String(unit?.text || "").length };
      }),
      omittedByProvider,
      declinedByProvider,
      passthroughUnits: passthrough.length,
      automaticContentRetry: false,
    }, traceId);
  }
  if (translatedCount <= 0) {
    log.warn("AI returned nothing usable for this page", { route: plan.route, expected: sendable.length });
    return {
      usable: false, complete: false, translated: 0, missing: missingUnitIds,
      reason: "AI returned no usable translations",
    };
  }
  const { document: patched, report } = applied;
  result.lensDocument = patched;
  const pageIndex = Number(payload?.context?.page_index);
  if (
    memoryCharacters.length ||
    memoryGlossary.length ||
    memoryMode === "full" ||
    Boolean(outcome?.meta?.vision)
  ) {
    result.Ai = {
      ...(result.Ai || {}),
      characters: memoryCharacters,
      glossary: memoryGlossary,
      meta: {
        ...(result.Ai?.meta || {}),
        vision: Boolean(outcome?.meta?.vision),
        ...(Number.isInteger(pageIndex) ? { pageIndex } : {}),
        ...(payload?.metadata?.batch_id ? { batchId: String(payload.metadata.batch_id) } : {}),
      },
    };
  }
  result.aiRoute = { ...plan, ...outcome.meta, ...report };
  delete result.aiRoute.ai;

  if (report.missing.length) {
    const safeErase = eraseBoxesForAiPartial(result.lensDocument, result.eraseBoxes);
    if (!safeErase.ok) {
      return {
        usable: false,
        complete: false,
        translated: report.translated,
        missing: report.missing.map(String),
        reason: safeErase.reason,
      };
    }
    result.eraseBoxes = safeErase.eraseBoxes;
    log.warn("text-only AI answered only part of the page", {
      route: plan.route,
      translated: report.translated,
      missing: report.missing.length,
    });
    result.aiPartial = {
      partial: true,
      translated: report.translated,
      missing: report.missing.map(String),
      missingUnits,
      omitted: omittedByProvider,
      declined: declinedByProvider,
    };
    // Say WHICH failure it was. "Unanswered" covers two causes with two
    // different fixes, and the page looks identical either way.
    const cause = declinedByProvider.length && !omittedByProvider.length
      ? "the model returned them empty"
      : omittedByProvider.length && !declinedByProvider.length
        ? "the model did not return them at all"
        : "the model returned some empty and left others out";
    result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []),
      `AI left ${report.missing.length} translation unit(s) unanswered (${cause}): ` +
      `${report.missing.join(", ")}`];
  }
  return classifyAiTranslationReport(report);
}

const PROVIDER_BACKPRESSURE_MAX_WAIT_MS = 90_000;

// Abortable delay used only for safe no-generation orchestration retries.
async function waitForRetry(ms, signal) {
  const base = Math.max(0, Math.floor(Number(ms) || 0));
  if (base <= 0) return;
  // A small positive jitter prevents many browsers rejected by the same full HF
  // worker pool from waking on the same millisecond and recreating the burst.
  // Keep it small enough that it never becomes meaningful user-visible pacing.
  const jitter = base >= 100 ? Math.floor(Math.random() * Math.min(500, base * 0.2)) : 0;
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
  return code === "rate_gate_busy" || code === "local_rate_gate_busy" ||
    code === "server_busy" || code === "provider_rate_limited";
}

// Runs runLocalAi inside the payload's scheduler lane. Pre-provider admission
// backpressure is re-queued indefinitely (until cancellation) with the SAME
// operation id; a real provider/model attempt is never generated again here.
async function runLocalAiInLane(base, payload, result, plan, batchId, signal, onGenerationAttempt = null) {
  const key = laneKeyFor(payload);
  const unlimited = payload?.limits?.aiUnlimited === true;
  setLaneUnlimited(key, unlimited);
  const traceId = String(payload?.context?.tp_trace || getTrace() || "");
  const imageId = String(payload?.metadata?.image_id || "");
  let orchestrationAttempts = 0;
  let accumulatedQueueWaitMs = 0;
  let providerBackpressureSince = 0;

  while (true) {
    orchestrationAttempts++;
    traceNote("background/jobs.js", "imageStage", {
      stage: "ai", state: "queued", route: "extension", imageId,
      orchestrationAttempts,
    }, traceId);

    const slot = await acquire(key, signal);
    const queueWaitMs = Number(slot?.waitMs) || 0;
    accumulatedQueueWaitMs += queueWaitMs;
    traceNote("background/jobs.js", "imageStage", {
      stage: "ai", state: "started", route: "extension", imageId,
      queueWaitMs, accumulatedQueueWaitMs,
      window: Number(slot?.window) || 0,
      maxWindow: Number(slot?.maxWindow) || 0,
      unlimited, orchestrationAttempts,
    }, traceId);

    const started = Date.now();
    const telemetry = {};
    try {
      const done = await runLocalAi(
        base, payload, result, plan, batchId, signal, telemetry, onGenerationAttempt,
      );
      const roundTripMs = Date.now() - started;
      const serverWaitMs =
        (Number.isFinite(telemetry.rateWaitMs) ? telemetry.rateWaitMs : 0) +
        (Number.isFinite(telemetry.admissionWaitMs) ? telemetry.admissionWaitMs : 0);
      const replayed = telemetry.replayed === true;
      const reportedProviderMs = Number.isFinite(telemetry.providerMs) && telemetry.providerMs > 0
        ? telemetry.providerMs : 0;
      const providerMs = replayed
        ? 0
        : (reportedProviderMs > 0 ? reportedProviderMs : Math.max(1, roundTripMs - serverWaitMs));
      const serverTotalMs = Number.isFinite(telemetry.serverTotalMs) && telemetry.serverTotalMs > 0
        ? telemetry.serverTotalMs : 0;
      const transportProxyMs = replayed || serverTotalMs <= 0
        ? 0
        : Math.max(0, roundTripMs - serverTotalMs);
      const latencySource = replayed
        ? "idempotent-replay"
        : (reportedProviderMs > 0 ? "server.providerMs" : "roundTrip-minus-serverWait");
      // A ledger replay did not call the provider now. Do not pollute the
      // scheduler's latency telemetry with the original generation's duration.
      releaseSuccess(key, replayed ? 0 : providerMs);
      const rpmNow = Number(telemetry.rate?.rpm) || 0;
      const ceiling = Number(describeLane(key)?.effectiveMax) || 0;
      traceNote("background/jobs.js", "imageStage", {
        stage: "ai", state: "finished", route: "extension", imageId,
        queueWaitMs, accumulatedQueueWaitMs, providerMs, reportedProviderMs,
        roundTripMs, serverWaitMs, serverTotalMs, transportProxyMs, replayed,
        latencySource, rpmNow, laneCeiling: ceiling, orchestrationAttempts,
        usable: done?.usable === true,
        complete: done?.complete === true,
        missingUnitIds: Array.isArray(done?.missing) ? done.missing : [],
      }, traceId);
      return done;
    } catch (e) {
      const status = Number(e?.status) || 0;
      const code = String(e?.code || "");
      const gated = isRateGateBusy(e);
      const providerBackpressure = code === "provider_rate_limited";
      const serverDeferred = code === "server_busy";
      if (providerBackpressure && !providerBackpressureSince) providerBackpressureSince = Date.now();
      if (!providerBackpressure) providerBackpressureSince = 0;
      const providerBackpressureMs = providerBackpressureSince
        ? Math.max(0, Date.now() - providerBackpressureSince)
        : 0;
      const providerBackpressureExpired = providerBackpressure &&
        providerBackpressureMs >= PROVIDER_BACKPRESSURE_MAX_WAIT_MS;
      const retryableBeforeProvider = isSafeNoGenerationBackpressure(e) && !providerBackpressureExpired;
      const backpressure = status === 429 || status === 503 || providerBackpressure;
      const retryAfterMs = Math.max(50, Number(e?.retryAfterMs) || 250);
      // A full shared HF process should never become a hot 503 loop across many
      // browsers. Keep the work client-side, preserve provider concurrency, and
      // spread retries exponentially (capped) until a real server slot opens.
      const serverRetryMs = serverDeferred
        ? Math.min(5000, Math.max(retryAfterMs, 300 * (2 ** Math.min(4, orchestrationAttempts - 1))))
        : retryAfterMs;

      if (gated) releaseGated(key, retryAfterMs);
      else if (providerBackpressure) releaseRejected(key, retryAfterMs);
      else if (serverDeferred) releaseDeferred(key, serverRetryMs);
      else if (backpressure) releaseRejected(key, retryAfterMs);
      else releaseFailed(key);

      if (providerBackpressureExpired) {
        e.message = `${e?.message || "AI provider rate limited"} (provider backpressure persisted for ${Math.round(providerBackpressureMs / 1000)}s)`;
      }

      traceNote("background/jobs.js", "imageStage", {
        stage: "ai",
        state: retryableBeforeProvider ? "requeued" : "failed",
        route: "extension", imageId,
        queueWaitMs, accumulatedQueueWaitMs,
        providerMs: Date.now() - started,
        status, backpressure, gated, retryableBeforeProvider,
        providerBackpressure, providerBackpressureMs, providerBackpressureExpired,
        retryAfterMs, serverRetryMs, orchestrationAttempts,
        code,
        providerAttempts: Number(e?.providerAttempts || 0),
        generationAttempts: Number(e?.generationAttempts || 0),
        error: e?.message || String(e),
      }, traceId);

      if (!retryableBeforeProvider || signal?.aborted) throw e;
      // The lane itself may already be paused until Retry-After. Shared-server
      // pressure gets a progressively wider client-side retry delay so many
      // browsers do not synchronize into a hot 503 loop.
      await waitForRetry(serverDeferred ? serverRetryMs : retryAfterMs, signal);
    }
  }
}

// Translates one image with `POST /v1/translate`, taking a scheduler slot and reporting how it was released.
async function runSyncTranslate(
  base, payload, makeContext,
  { tabId, frameId, batch, batchId, imageKey, workflowId = "" },
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
  } catch {
  }
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
  const mayUseLensDirect = !apiEngine && (payload.source !== "ai" || Boolean(plan));
  // Why the browser could not draw this image, filled in by runLensDirectPath.
  const decline = { reason: "" };

  await wf.lensRequested(workflowId, `lens-direct:${jobId}`);
  let lensDone = false;
  try {
    if (!mayUseLensDirect) {
      if (apiEngine) {
        traceNote("background/jobs.js", "engineRoute", {
          engine: "api", reason: "user selected the API server engine",
          mode: payload.mode, source: payload.source,
        }, String(payload?.context?.tp_trace || getTrace() || ""));
      }
      throw Object.assign(
        new Error(apiEngine ? "API engine selected" : "AI has no text-only route"),
        { skipDirect: true },
      );
    }
    const lensCtrl = beginInFlight(jobId, tabId);
    let direct;
    try {
      const directPayload = payload;
      decline.reason = "";
      direct = await runLensDirectPath(base, directPayload, {
        tabId, frameId, signal: lensCtrl.signal, decline,
      });
    } finally {
      endInFlight(jobId);
    }
    if (direct) {
      await wf.lensReady(workflowId);
      lensDone = true;
      if (plan) {
        const aiContext = pendingByJob.get(jobId);
        if (aiContext) aiContext.aiRouteEntered = true;
        await wf.aiRequested(workflowId, `ai-route:${jobId}`);
        const layoutDecision = aiLayoutDecision(direct.lensDocument, payload.lang);
        log.info("AI layout stays in the extension", {
          ...layoutDecision,
          route: plan.route,
        });

        // Do not make an empty page wait behind real AI work. Lens has already
        // supplied the authoritative units here, so zero translatable units is
        // a terminal skip and needs neither a scheduler slot nor a provider call.
        const preAiUnits = translationUnits(direct.lensDocument);
        const hasTranslatableAiText = preAiUnits.some((unit) => unit?.translatable);
        if (!preAiUnits.length || !hasTranslatableAiText) {
          markNoTranslatableText(
            direct,
            preAiUnits.length ? "no_translatable_text" : "no_text",
          );
          traceNote("background/jobs.js", "imageStage", {
            stage: "ai", state: "skipped", route: "extension", imageId: imageKey,
            reason: direct.meta.skipped_reason, queueWaitMs: 0, providerMs: 0,
          }, String(payload?.context?.tp_trace || ""));
          await wf.textReady(workflowId);
          await handleResult(jobId, direct);
          return;
        }

        const aiCtrl = beginInFlight(jobId, tabId);
        const aiRunning = runLocalAiInLane(
          base, payload, direct, plan, batchId, aiCtrl.signal,
          () => {
            const c = pendingByJob.get(jobId);
            if (c) c.aiGenerationAttempted = true;
          },
        )
          .finally(() => endInFlight(jobId));
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
          : { ok: false, reason: aiOutcome?.reason || "AI produced no usable translation" };
        if (!aiOutcome?.usable || !finalFidelity.ok) {
          const reason = aiOutcome?.usable
            ? `extension AI geometry was not faithful: ${finalFidelity.reason}`
            : aiOutcome?.reason || "AI produced no usable translation; no automatic retry was made";
          log.warn("extension-first AI stopped without invoking the full image pipeline", { reason });
          await wf.failed(workflowId, reason);
          handleJobError(jobId, reason);
          return;
        }
        if (!aiOutcome.complete) {
          log.warn("extension-first AI is inserting a partial single response", {
            translated: aiOutcome.translated,
            missingUnitIds: aiOutcome.missing,
            automaticContentRetry: false,
          });
        }
        log.info("tp.route", {
          stage: "text", outcome: "new", reason: "",
          route: plan.route, source: plan.originalSource, lens: "direct",
        });
      }
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
    if (!e?.skipDirect) {
      log.warn("the extension route threw before it could draw", {
        error: e?.message || String(e),
      });
      if (!decline.reason) decline.reason = `the extension route threw: ${e?.message || String(e)}`;
    }
    await wf.lensDegraded(workflowId, `lens direct threw: ${e?.message || String(e)}`);
  }

  // The extension engine does not quietly hand a text page to the server. When the
  // browser cannot draw it, that is a failure with a reason, not a different engine:
  // a page that silently arrives rendered by the API looks like the engine switch did
  // nothing, and the ONNX miss behind it never gets seen. `lens_images` is unaffected
  // (its only route has always been `/v1/translate`), and so is the API engine, where
  // the server owning the whole pipeline is the point.
  if (!apiEngine && payload.mode === "lens_text") {
    const reason = decline.reason ||
      (payload.source === "ai"
        ? "extension-first AI could not obtain a faithful LensDocument"
        : "the extension route declined this image");
    traceNote("background/jobs.js", "engineRoute", {
      engine: "extension", outcome: "stopped", reason,
      mode: payload.mode, source: payload.source,
    }, String(payload?.context?.tp_trace || getTrace() || ""));
    await wf.failed(workflowId, reason);
    handleJobError(jobId, reason);
    return;
  }

  let browserImageFallbackUsed = false;
  let syncProviderBackpressureSince = 0;
  for (let attempt = 0; ; attempt++) {
    const serverPayload = payloadForFullServer(payload);
    const outbound = serverPayload;
    try {
      outbound.idempotency_key = await idempotencyKeyForPayload(outbound);
    } catch {
      delete outbound.idempotency_key;
    }
    const requestLane = laneKeyFor(outbound);
    const ctrl = beginInFlight(jobId, tabId);
    let slotHeld = false;
    let queueWaitMs = 0;
    const t0 = Date.now();
    let requestStartedAt = 0;
    const serverTraceId = String(payload?.context?.tp_trace || getTrace() || "");
    const serverImageId = String(payload?.metadata?.image_id || "");
    traceNote("background/jobs.js", "imageStage", {
      stage: "ai", state: "queued", route: "api", imageId: serverImageId,
    }, serverTraceId);
    try {
      const slot = await acquire(requestLane, ctrl.signal);
      queueWaitMs = Number(slot?.waitMs) || 0;
      requestStartedAt = Date.now();
      slotHeld = true;
      traceNote("background/jobs.js", "imageStage", {
        stage: "ai", state: "started", route: "api", imageId: serverImageId,
        queueWaitMs, window: Number(slot?.window) || 0,
        maxWindow: Number(slot?.maxWindow) || 0,
        unlimited: slot?.unlimited === true,
      }, serverTraceId);
      if (lensDone) await wf.aiRequested(workflowId, `ai-server:${jobId}:${attempt}`);
      else await wf.lensRequested(workflowId, `sync:${jobId}:${attempt}`);
      let result;
      try {
        result = await translateViaSyncRest(base, outbound, {
          signal: ctrl.signal,
        });
      } finally {
        endInFlight(jobId);
      }
      const requestMs = Date.now() - requestStartedAt;
      const serverProcessingMs = Number(result?.perf?.total_ms) || 0;
      // On plain-http localhost Chrome normally exposes only a handful of
      // HTTP/1.1 connections per origin. requestMs - serverProcessingMs makes
      // that browser/proxy transport wait visible instead of misdiagnosing it
      // as an API scheduler queue. On an HTTP/2 HF front door this should be
      // close to ordinary network overhead.
      const transportProxyMs = serverProcessingMs > 0
        ? Math.max(0, requestMs - serverProcessingMs) : 0;
      releaseSuccess(requestLane, requestMs);
      slotHeld = false;
      traceNote("background/jobs.js", "imageStage", {
        stage: "ai", state: "finished", route: "api", imageId: serverImageId,
        queueWaitMs, requestMs, serverProcessingMs, transportProxyMs,
        totalElapsedMs: Date.now() - t0,
        laneCeiling: Number(describeLane(requestLane)?.effectiveMax) || 0,
      }, serverTraceId);
      if (!lensDone) {
        await wf.lensReady(workflowId);
        lensDone = true;
      }
      await wf.textReady(workflowId);
      await handleResult(jobId, result);
      return;
    } catch (e) {
      endInFlight(jobId);
      traceNote("background/jobs.js", "imageStage", {
        stage: "ai", state: e?.name === "AbortError" ? "cancelled" : "failed",
        route: "api", imageId: serverImageId, queueWaitMs,
        status: Number(e?.status) || 0,
        retryAfterMs: Number(e?.retryAfterMs) || 0,
      }, serverTraceId);
      if (e?.cancelled || e?.name === "AbortError") {
        if (slotHeld) releaseFailed(requestLane);
        log.info("request cancelled with the tab", { jobId });
        await wf.failed(workflowId, "cancelled with the tab");
        removeJob(jobId, payload?.metadata?.image_id);
        return;
      }

      const retryAfterMs = Number(e?.retryAfterMs) || 0;
      const status = Number(e?.status) || 0;
      const failedStage = String(e?.failedStage || "");

      // Server-side URL downloads can be rejected by anti-hotlink/CDN rules
      // even while the page is visibly displaying the image. Recover only when
      // the server explicitly says it failed before Lens/AI at image_fetch.
      // This is NOT an AI retry: the first request never reached OCR/model work.
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
          let du = "";
          if (tabId) {
            try {
              du = await fetchImageDataUriFromTab(tabId, src, frameId || 0);
            } catch (tabError) {
              browserFetchError = tabError?.message || String(tabError);
            }
          }
          if (!du) {
            // Still browser-side (extension service worker / user's IP). Useful
            // when the CDN blocks datacenter IPs but does not require page cookies.
            du = await fetchImageDataUriFromUrl(src, payload?.context?.page_url || "");
          }
          if (du) {
            payload.imageDataUri = du;
            const key = normImgSrc(src);
            if (key) setCachedDataUri(key, du);
            markDomainNeedsDataUri(src);
            payload = withPipelineStage(payload, "server_image_fetch_browser_fallback");
            log.info("server image fetch failed; recovered bytes in browser", {
              src: src.slice(0, 180),
              kb: Math.round(du.length / 1024),
              tabFallbackError: browserFetchError || "",
            });
            await wf.lensDegraded(workflowId, "server image fetch failed; browser supplied bytes");
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

      // Backpressure is a response contract, not the presence of an optional
      // Retry-After header. A bare 429/503 must narrow the lane as well —
      // unless it came from the API's own rate gate, which is pacing this API
      // key rather than protecting the server, and hands back the exact wait.
      const isBusy = status === 429 || status === 503 || retryAfterMs > 0;
      const gated = isRateGateBusy(e);
      const code = String(e?.code || "");
      const generationAttempts = Number(e?.generationAttempts || 0);
      const safeDeferred = generationAttempts === 0 && (
        code === "server_busy" || code === "local_rate_gate_busy" ||
        code === "lens_session_unavailable" || code === "provider_rate_limited"
      );

      if (isBusy && safeDeferred) {
        const serverRetryMs = code === "server_busy"
          ? Math.min(5000, Math.max(retryAfterMs, 300 * (2 ** Math.min(4, attempt))))
          : retryAfterMs;
        if (slotHeld) {
          if (gated) releaseGated(requestLane, retryAfterMs);
          else if (code === "provider_rate_limited") releaseRejected(requestLane, retryAfterMs);
          else releaseDeferred(requestLane, serverRetryMs);
          slotHeld = false;
        }

        if (code === "provider_rate_limited") {
          if (!syncProviderBackpressureSince) syncProviderBackpressureSince = Date.now();
          if (Date.now() - syncProviderBackpressureSince >= PROVIDER_BACKPRESSURE_MAX_WAIT_MS) {
            const msg = "AI provider stayed rate limited for 90s; the request was never generated.";
            await wf.failed(workflowId, msg);
            handleJobError(jobId, msg);
            return;
          }
        } else {
          syncProviderBackpressureSince = 0;
        }

        log.info(
          gated ? "this API key is out of tokens; the image waits its turn"
                : code === "lens_session_unavailable"
                  ? "Lens session is refreshing; the image stays with us"
                  : code === "provider_rate_limited"
                    ? "AI provider rejected before generation; the image stays with us"
                    : "server busy; the image stays with us",
          { laneKey: requestLane, attempt: attempt + 1, retryAfterMs, serverRetryMs, gated, code, generationAttempts },
        );
        traceNote("background/jobs.js", "imageStage", {
          stage: "ai", state: "requeued", route: "api", imageId: serverImageId,
          queueWaitMs, status, retryAfterMs, serverRetryMs, code, generationAttempts, attempt: attempt + 1,
        }, serverTraceId);
        const why = gated
          ? `AI key paced by the server's rate gate (wait ${retryAfterMs}ms)`
          : `${code || "server busy"} (retry-after ${retryAfterMs}ms)`;
        if (lensDone) await wf.aiDegraded(workflowId, why);
        else await wf.lensDegraded(workflowId, why);
        // Keep the rejected work in this browser. Shared-server pressure gets
        // an exponential client-side retry delay; provider/rate signals keep
        // their own advertised delay. Only a REAL provider rejection is allowed
        // to reduce learned provider concurrency.
        await waitForRetry(code === "server_busy" ? serverRetryMs : retryAfterMs, ctrl.signal);
        continue;
      }

      if (slotHeld) {
        if (isBusy) releaseRejected(requestLane, retryAfterMs);
        else releaseFailed(requestLane);
      }

      const msg = e?.message || String(e);
      await wf.failed(workflowId, msg);
      handleJobError(jobId, msg);
      return;
    }
  }
}

// Submits a job over REST and long-polls it to completion.
async function submitAndPollRest(
  base, payload, makeContext,
  { tabId, frameId, batch, batchId, imageKey, workflowId = "" },
) {
  let jobId = "";
  try {
    const idempotencyKey = await idempotencyKeyForPayload(payload);
    payload.idempotency_key = idempotencyKey;
    await wf.lensRequested(workflowId, `rest:${idempotencyKey}`);
    const submitted = await submitJobViaRest(base, payload, { idempotencyKey });
    jobId = String(submitted.id || "");
    const ctx = makeContext({
      startedAt: Date.now(),
      base,
      idempotencyKey,
      serverHints: submitted,
    });
    rememberJob(jobId, ctx);
    await pollJobViaRest(base, jobId);
  } catch (e) {
    const msg = e?.message || String(e);
    if (jobId) {
      handleJobError(jobId, msg);
      return;
    }
    if (payload?.metadata?.image_id) pendingByImage.delete(payload.metadata.image_id);
    if (batch && imageKey) {
      const cls = classifyJobError(msg);
      batchMark(batchId, imageKey, { status: "error", lastError: msg, permanent: !!cls.permanent });
      batchUpdateToast(batch, cls.permanent ? "Error (permanent)" : "Error");
      finalizeBatch(batch);
    }
    failJobImmediately(
      tabId,
      payload?.src || null,
      msg,
      frameId,
      String(payload?.context?.tp_trace || ""),
    );
  }
}

// Resumes REST long-polls after a Manifest V3 service-worker restart.
export async function resumePendingRestJobs() {
  const jobIds = await restorePendingJobs();
  for (const jobId of jobIds) {
    const ctx = pendingByJob.get(jobId);
    const base = String(ctx?.base || "").trim();
    if (!base) continue;
    addTask(
      () => pollJobViaRest(base, jobId).catch((e) => handleJobError(jobId, e?.message || String(e))),
      { shouldStart: () => pendingByJob.has(jobId) },
    );
  }
}

// Queues a payload for processing, skipping it when its tab session is already stale.
export function enqueue(payload, tabId, frameId = 0) {
  const expected = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  const sessionIsCurrent = () => {
    const cur = getTabSessionId(tabId);
    return !(expected && (!cur || expected !== cur));
  };
  const queuedBatchId = String(payload?.metadata?.batch_id || "").trim();
  const isAdmissible = () => (
    sessionIsCurrent() && !(queuedBatchId && getBatch(queuedBatchId)?.cancelled)
  );
  addTask(() => {
    if (!isAdmissible()) return;
    return processJob(payload, tabId, frameId);
  }, {
    shouldStart: isAdmissible,
    // In runs:Extension the image is only orchestration; Lens and AI each have
    // their own scheduler lanes. Do not let an image waiting for AI consume the
    // top-level slot that a later image needs in order to start Lens.
    laneManaged: payload?.engine !== "api",
  });
}

// Cancels every in-flight job for a tab, on the extension and on the server.
export function cancelTabWork(tabId, reason = "navigation") {
  if (!Number.isFinite(tabId)) return;
  const msg = String(reason || "navigation");
  const cancelledJobIds = [];
  const cancelledBatchIds = new Set();

  for (const [jobId, ctx] of Array.from(pendingByJob.entries())) {
    if ((ctx?.tabId || 0) !== tabId) continue;
    const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
    const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
    const batch = batchId ? ensureBatch(batchId, tabId, ctx?.frameId || 0) : null;
    if (batchId) cancelledBatchIds.add(batchId);

    cancelledJobIds.push(jobId);
    removeJob(jobId, ctx?.metadata?.image_id);

    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: msg });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
      batchStopKeepAlive(batch);
    }
  }

  for (const [imageId, rec] of Array.from(pendingByImage.entries())) {
    if ((rec?.tabId || 0) === tabId) pendingByImage.delete(imageId);
  }

  const stopped = abortTabInFlight(tabId, "tp:cancelled");
  if (stopped) log.info("stopped in-flight requests for a gone tab", { tabId, stopped, reason: msg });

  wf.cancelTab(tabId, msg);

  if (cancelledJobIds.length || cancelledBatchIds.size) {
    if (cancelledBatchIds.size) {
      for (const batchId of cancelledBatchIds) {
        cancelJobsViaRest({ jobIds: cancelledJobIds, batchId, session: getTabSessionId(tabId) || "" });
      }
    } else {
      cancelJobsViaRest({ jobIds: cancelledJobIds, session: getTabSessionId(tabId) || "" });
    }
  }
}

// Marks a batch's unfinished items as aborted so their results are never shown.
export function discardBatchResults(batchId, reason = "user_cancelled") {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  const batch = ensureBatch(bid, 0, 0);
  batch.cancelled = true;
  for (const [key, item] of batch.items.entries()) {
    if (["done", "error", "aborted", "skipped"].includes(item?.status)) continue;
    batch.items.set(key, { ...item, status: "aborted", lastError: reason });
  }
  batchUpdateToast(batch, "Cancelled", true);
  batchStopKeepAlive(batch);
}
