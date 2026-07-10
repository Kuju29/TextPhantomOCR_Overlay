/**
 * Job orchestration: enqueue → submit → handle result/error → finalise batch.
 *
 * This is the heart of the service worker. It ties together the transport, the
 * batch tracker, the registry and the content-script messaging layer.
 *
 * Result delivery: a job's result carries either a replacement image
 * (`imageDataUri`) and/or an HTML overlay (`Ai.aihtml` / `translatedhtml` /
 * `originalhtml`). For `lens_text` mode the overlay is preferred; other modes
 * swap the `<img>` source directly.
 */

import { createLogger } from "../shared/logger.js";
import { getApiBase } from "./api.js";
import {
  ensureBatch,
  batchMark,
  batchUpdateToast,
  batchStopKeepAlive,
  batchPassStats,
} from "./batches.js";
import { classifyJobError, fetchImageDataUriFromUrl, fetchImageDataUriFromTab } from "./images.js";
import { addTask } from "./job-queue.js";
import { imageKeyFromPayload, normImgSrc } from "./job-keys.js";
import { pendingByJob, pendingByImage, findContext, removeJob, rememberJob, restorePendingJobs } from "./job-registry.js";
import {
  getCachedDataUri,
  setCachedDataUri,
  isMangaDexPageUrl,
  mdKeyFromUrl,
  mdCacheKey,
  getCachedResult,
  setCachedResult,
  stripImageFields,
} from "./mangadex.js";
import { accumulateSeriesMemory } from "./series-memory.js";
import { resolveSeriesKey } from "../shared/series.js";
import { bumpTabSession, getTabSessionId } from "./tab-sessions.js";
import {
  sendToTab,
  requestFromTabEnsured,
} from "./tabs-messaging.js";
import { enqueueDomInsert } from "./insert-queue.js";
import {
  connectWebSocket,
  isWsReady,
  isWsBlocked,
  sendWsJob,
  submitJobViaRest,
  pollJobViaRest,
  subscribeJobEvents,
  shouldPreferRest,
  cancelJobsViaRest,
} from "./transport.js";

const log = createLogger("SW.jobs");

const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS = 3000;
const BATCH_RETRY_GAP_MS = 1800;

// --- Settings epoch --------------------------------------------------------
// Bumped whenever mode/lang/sources change; a result whose epoch no longer
// matches is dropped (the user changed what they wanted mid-flight).
let settingsEpoch = 0;
export const bumpSettingsEpoch = () => {
  settingsEpoch = (settingsEpoch + 1) >>> 0;
};

// --- Current batch id ------------------------------------------------------
let currentBatchId = null;
export const setCurrentBatchId = (id) => {
  currentBatchId = id;
};
export const getCurrentBatchId = () => currentBatchId;

// --- Failure helpers -------------------------------------------------------

/** Tell a tab an image failed (used when there is no job context to clean up). */
function failJobImmediately(tabId, imgUrl, message, frameId = 0) {
  if (tabId) {
    sendToTab(tabId, { type: "IMAGE_ERROR", original: imgUrl, message }, frameId);
  }
}

/** Fail every in-flight job (e.g. the WebSocket ended mid-batch). */
export function failAllPending(message) {
  for (const jobId of Array.from(pendingByJob.keys())) {
    const ctx = pendingByJob.get(jobId);
    const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
    const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
    const batch = batchId ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0) : null;

    failJobImmediately(ctx?.tabId, ctx?.imgUrl || null, message, ctx?.frameId || 0);
    removeJob(jobId, ctx?.metadata?.image_id);

    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: message });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
    }
  }
  pendingByImage.clear();
}

/** A job's REST poll detected a stale tab session — abort it cleanly. */
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

/** Handle a job error: notify the tab (unless stale) and update the batch. */
export function handleJobError(jobId, errMsg = "Unknown error") {
  let cls = classifyJobError(errMsg);
  const ctx = pendingByJob.get(jobId);
  const curSession = ctx?.tabId ? getTabSessionId(ctx.tabId) : "";
  const isStale = Boolean(ctx?.sessionId && curSession && ctx.sessionId !== curSession);

  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
  const batch = batchId ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0) : null;

  // URL-first job failed: the server may simply have been unable to download
  // this domain's images (hotlink/cookie protection). Remember the domain and
  // keep the error TRANSIENT so pass 2 retries with browser-fetched bytes.
  const item = batch && imageKey ? batch.items.get(imageKey) : null;
  if (item?.payload && isUrlOnlyPayload(item.payload)) {
    markDomainNeedsDataUri(item.payload.src);
    if (cls.permanent) cls = { permanent: false };
  }

  if (ctx?.tabId && !isStale) {
    sendToTab(
      ctx.tabId,
      { type: "IMAGE_ERROR", original: ctx.imgUrl, message: errMsg },
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


function isTextNoOverlaySkippable(mode, source, result) {
  if (String(mode || "") !== "lens_text") return false;
  const src = String(source || "").toLowerCase();
  if (src === "ai") return false; // AI no-text gets its own badge/metadata.
  const reason = String(
    result?.meta?.skipped_reason ||
      result?.metadata?.skipped_reason ||
      result?.translated?.meta?.skipped_reason ||
      result?.original?.meta?.skipped_reason ||
      ""
  ).toLowerCase();
  return !reason || /no[_ -]?text|empty|no[_ -]?overlay|no[_ -]?paragraph/.test(reason);
}

// --- Result handling -------------------------------------------------------

/** Extract the replacement-image URL from a result, if any. */
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

/** Extract the (any) HTML overlay markup from a result. */
function extractHtml(result) {
  return {
    aiHtml: result?.Ai?.aihtml || result?.ai?.aihtml || null,
    translatedHtml: result?.translated?.translatedhtml || result?.translatedhtml || null,
    originalHtml: result?.original?.originalhtml || result?.originalhtml || null,
  };
}

/**
 * Handle a finished job: cache it (MangaDex), then inject the result into the
 * tab as an image replacement and/or HTML overlay.
 */
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
  // Per-series AI memory: glossary + character sheet, keyed by the series key
  // threaded through the payload (falls back to re-deriving it from the page
  // URL for jobs restored from an older registry).
  void (async () => {
    try {
      const key =
        (ctx.seriesKey && String(ctx.seriesKey)) ||
        (await resolveSeriesKey(ctx.pageUrl || "")) ||
        "default";
      await accumulateSeriesMemory(key, result);
    } catch {
      /* memory accumulation is best-effort */
    }
  })();
  const hasHtml = Boolean(aiHtml || translatedHtml || originalHtml);

  // MangaDex: cache the result so re-visiting the chapter renders instantly.
  const cacheKey = mdCacheKey(mdKeyFromUrl(imgUrl), ctx.lang || ctx.metadata?.lang, mode);
  if (cacheKey && (newImg || hasHtml)) {
    setCachedResult(cacheKey, {
      newImg: newImg || null,
      result: hasHtml ? stripImageFields(result) : null,
    });
  }

  // Drop the result if the tab navigated away or the user changed settings.
  const curSession = getTabSessionId(tabId);
  const settingsStale =
    typeof ctx.settingsEpoch === "number" && ctx.settingsEpoch !== settingsEpoch;
  const isStale =
    Boolean(ctx.sessionId && curSession && ctx.sessionId !== curSession) || settingsStale;

  if (isStale) {
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

  // Apply to the page: image swap for non-text modes, overlay for text modes.
  let replaceOk = null;
  if (newImg && mode !== "lens_text") {
    replaceOk = await enqueueDomInsert(
      tabId,
      { type: "REPLACE_IMAGE", original: imgUrl, newSrc: newImg },
      frameId,
    );
  }

  let overlayOk = null;
  if (hasHtml) {
    overlayOk = await enqueueDomInsert(
      tabId,
      { type: "OVERLAY_HTML", original: imgUrl, result, mode: mode || "", source: ctx.source || "" },
      frameId,
    );
  }

  let ok = true;
  let errMsg = "";
  if (!hasHtml && !(newImg && mode !== "lens_text")) {
    if (!newImg) {
      // Lens-direct text modes can legitimately return no overlay when Lens
      // found no text.  Treat that as a skipped image, not a red error badge.
      // BUT: Lens sometimes returns a transient empty payload under load (and
      // the server no longer caches those), so the FIRST no-overlay result is
      // retried once via the batch's pass 2; only a repeat becomes "skipped".
      if (isTextNoOverlaySkippable(mode, ctx.source || result?.source || "", result)) {
        const item = batch && imageKey ? batch.items.get(imageKey) : null;
        if (item && Number(item.attempt || 1) < 2) {
          ok = false;
          errMsg = "No text detected (retrying)";
        } else {
          ok = true;
          errMsg = "No text detected";
        }
      } else {
        await enqueueDomInsert(
          tabId,
          { type: "IMAGE_ERROR", original: imgUrl, message: "API returned no overlay data" },
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
      const cls = classifyJobError(errMsg);
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

// --- Batch finalisation / retry -------------------------------------------

/**
 * When every image in a pass has finished:
 * - pass 1: schedule a single retry pass for transiently-failed images.
 * - pass 2: announce completion and stop the tab keep-alive.
 */
export function finalizeBatch(b) {
  if (!b) return;
  const s = batchPassStats(b);
  if (!s.total || s.finished < s.total) return;

  if (b.pass === 1) {
    if (b.retryScheduled) return;

    const failed = [];
    let permanentErrors = 0;
    for (const [k, it] of b.items.entries()) {
      if (it?.attempt !== 1 || it.status !== "error") continue;
      if (it.permanent) permanentErrors++;
      else failed.push(k);
    }

    if (!failed.length) {
      batchUpdateToast(
        b,
        permanentErrors ? `Done (${permanentErrors} permanent errors)` : "Done",
        true,
      );
      batchStopKeepAlive(b);
      return;
    }

    // Schedule pass 2 for the transiently-failed images.
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

  // pass 2
  const s2 = batchPassStats(b);
  batchUpdateToast(b, s2.error > 0 ? `Done (${s2.error} still failing)` : "Done", true);
  batchStopKeepAlive(b);
}

/** Append a pipeline stage marker to a payload's metadata. */
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

/** Re-run the failed images of a batch (pass 2), re-attaching data URIs. */
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
      // 403 here is only the SW-origin fetch being hotlink-blocked; processJob's
      // prefetch retries through the content script (page origin) — not fatal.
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
          batchUpdateToast(b, "ผิดพลาด (ถาวร)");
          finalizeBatch(b);
        }
      }
      if (cls.permanent) skip = true;
    }
    if (!skip) enqueue(next, b.tabId, b.frameId || 0);
  }
}

// --- Job processing --------------------------------------------------------

// --- Ordered submission ------------------------------------------------------
// Payloads are ENQUEUED in page order, but each job's prefetch/setup runs in
// parallel and the REST submits raced each other over the network — so the
// server queue (which is strictly FIFO into the worker/rate-gate lanes) could
// receive page 2 last and process it last. These helpers make jobs WAIT their
// turn to submit: prefetches still overlap fully, but POST /translate happens
// in page order. A per-waiter timeout guarantees one slow image can only delay
// the batch briefly, never deadlock it.
const ORDER_WAIT_MAX_MS = 10000;
/** batchId -> { counter, next, waiters: Map<seq, Array<fn>> } */
const batchOrder = new Map();

function getBatchOrder(batchId) {
  let st = batchOrder.get(batchId);
  if (!st) {
    st = { counter: 0, next: 0, waiters: new Map() };
    batchOrder.set(batchId, st);
    // Bounded memory: drop the oldest finished batches.
    while (batchOrder.size > 32) {
      const oldest = batchOrder.keys().next().value;
      if (oldest === undefined || oldest === batchId) break;
      batchOrder.delete(oldest);
    }
  }
  return st;
}

/** Claim the next submission slot for a batch ("" -> unordered, -1). */
function nextSubmitSeq(batchId) {
  if (!batchId) return -1;
  return getBatchOrder(batchId).counter++;
}

/** Wait until it is `seq`'s turn to submit (or the grace timeout passes). */
function awaitSubmitTurn(batchId, seq) {
  if (!batchId || !(seq >= 0)) return Promise.resolve();
  const st = getBatchOrder(batchId);
  if (st.next >= seq) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const fire = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const list = st.waiters.get(seq) || [];
    list.push(fire);
    st.waiters.set(seq, list);
    setTimeout(fire, ORDER_WAIT_MAX_MS);
  });
}

/** Mark `seq` as submitted/abandoned and wake every unblocked waiter. */
function releaseSubmitTurn(batchId, seq) {
  if (!batchId || !(seq >= 0)) return;
  const st = batchOrder.get(batchId);
  if (!st) return;
  if (seq + 1 > st.next) st.next = seq + 1;
  for (const [s, fns] of Array.from(st.waiters.entries())) {
    if (s <= st.next) {
      st.waiters.delete(s);
      for (const fn of fns) fn();
    }
  }
}

// --- Job idempotency --------------------------------------------------------

function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableString).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableString(value[k])).join(",") + "}";
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

// --- URL-first upload (per-domain memory) -----------------------------------
// For public http(s) images the server downloads the bytes itself (it has far
// more bandwidth than the user's uplink), so the extension sends only the URL.
// Domains whose images the server could NOT fetch (login/cookie/Cloudflare
// protected) are remembered here; their images fall back to the old behaviour
// of downloading in the browser and uploading a data URI. Only the FIRST image
// of such a domain pays the extra round-trip (it is retried with bytes in the
// batch's pass 2).
//
// Matching is by REGISTRABLE DOMAIN (last two labels), not the full hostname:
// image CDNs rotate subdomains per request/server (xx1.cdn.example -> xx2...),
// so exact-host memory would relearn the same lesson once per subdomain.
//
// Pre-seeded entries are CDNs KNOWN to reject datacenter IPs, so their images
// must always carry browser-fetched bytes. Without the seed, any image whose
// bytes the site adapter could not attach went URL-only -> failed on the
// server -> retried in pass 2 -> finished LAST (users saw page 2 rendered
// after page 20).
const dataUriDomains = new Set([
  "mangadex.network", // at-home image CDN — blocks non-residential IPs
  "mangadex.org",     // uploads.mangadex.org covers/edge cases
]);

/** Hostname of a URL, or "" when unparseable. */
function hostOf(u) {
  try {
    return new URL(String(u || "")).hostname;
  } catch {
    return "";
  }
}

/** Registrable-ish domain key (last two labels) for domain memory. */
function domainKeyOf(u) {
  const host = hostOf(u);
  if (!host) return "";
  const labels = host.split(".").filter(Boolean);
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

/** Remember that this image's domain needs browser-side bytes. */
export function markDomainNeedsDataUri(src) {
  const key = domainKeyOf(src);
  if (key) dataUriDomains.add(key);
}

/** Should this payload have its image pre-downloaded as a data URI? */
function shouldPrefetchDataUri(payload) {
  if (payload?.imageDataUri) return false;
  const src = String(payload?.src || "").trim();
  if (!src) return false;
  // Bytes only exist in the page/browser for these — must inline.
  if (/^(?:blob:|data:|file:|chrome-extension:)/i.test(src)) return true;
  if (/^https?:/i.test(src)) {
    // URL-first: let the server download public images itself. Prefetch only
    // for domains that already proved to need browser cookies/session.
    return dataUriDomains.has(domainKeyOf(src));
  }
  // Unknown scheme: keep the old behaviour for AI (bytes wanted server-side).
  return (
    payload?.mode === "lens_text" &&
    String(payload?.source || "").toLowerCase() === "ai"
  );
}

/** Was this job submitted URL-only (no inlined image bytes)? */
function isUrlOnlyPayload(payload) {
  return Boolean(
    payload &&
    !payload.imageDataUri &&
    /^https?:/i.test(String(payload.src || "").trim()),
  );
}

/**
 * Process one job payload end to end: optional data-URI prefetch, then submit
 * via REST (default) or WebSocket. Thin wrapper that guarantees the batch's
 * ordered-submission slot is ALWAYS released, whatever path the job takes.
 */
export async function processJob(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;
  const orderBatch = String(payload?.metadata?.batch_id || currentBatchId || "").trim();
  const orderSeq = Number(payload.__tpSubmitSeq ?? -1);
  try {
    return await processJobInner(payload, tabId, frameId);
  } finally {
    // Idempotent: normally released right after the POST inside
    // submitAndPollRest; this covers every early-return/error path.
    releaseSubmitTurn(orderBatch, orderSeq);
  }
}

async function processJobInner(payload, tabId, frameId = 0) {
  if (!payload || typeof payload !== "object") return;

  if (!payload.metadata || typeof payload.metadata !== "object") payload.metadata = {};
  const batchId = String(payload.metadata.batch_id || currentBatchId || "").trim();
  if (batchId) payload.metadata.batch_id = batchId;
  const imageKey = imageKeyFromPayload(payload);
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;

  const pageUrl = payload?.context?.page_url || "";
  const isMd = isMangaDexPageUrl(pageUrl);

  // Drop the job if it was queued under a now-stale tab session (non-MangaDex).
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

  const base = await getApiBase();
  const preferRest = shouldPreferRest(base, payload?.mode, payload?.source);

  // --- Data-URI prefetch ---------------------------------------------------
  if (shouldPrefetchDataUri(payload)) {
    const src = String(payload.src || "").trim();
    const key = normImgSrc(src);
    const cached = getCachedDataUri(key);
    if (cached) {
      payload.imageDataUri = cached;
    } else {
      const tPrefetch = Date.now();
      try {
        const du = src.startsWith("data:")
          ? src
          : await fetchImageDataUriFromUrl(src, pageUrl || "");
        if (du) {
          // "Waiting to start" diagnostics: how long downloading the image
          // took BEFORE the job could even be submitted to the server.
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
        // CDN hotlink protection (Origin: chrome-extension://) → retry via the
        // content script which runs in the page origin and has the right cookies.
        if (/\bHTTP 403\b/i.test(errMsg) && tabId) {
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
              errMsg = null; // success — skip failure handling below
            }
          } catch (e2) {
            errMsg = e2?.message || String(e2);
            log.warn("datauri prefetch tab fallback failed", { err: errMsg });
          }
        }
        if (errMsg) {
          const cls = classifyJobError(errMsg);
          log.warn("datauri prefetch failed", { err: errMsg, permanent: cls.permanent });
          if (cls.permanent) {
            if (payload?.metadata?.image_id) pendingByImage.delete(payload.metadata.image_id);
            if (batch && imageKey) {
              batchMark(batchId, imageKey, { status: "error", lastError: errMsg, permanent: true });
              batchUpdateToast(batch, "Error (permanent)");
              finalizeBatch(batch);
            }
            failJobImmediately(tabId, payload?.src || null, errMsg, frameId);
            return;
          }
        }
      }
    }
  }

  // --- WebSocket "blocked" guard ------------------------------------------
  if (isWsBlocked() && !preferRest) {
    const msg = "Connection closed. Please run the menu again.";
    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: msg });
      batchUpdateToast(batch, "Cancelled");
      finalizeBatch(batch);
    }
    failJobImmediately(tabId, payload?.src || null, msg, frameId);
    return;
  }

  const sessionId = getTabSessionId(tabId) || bumpTabSession(tabId, pageUrl);

  /** Build the context record stored in the registry for this job. */
  const makeContext = (extra = {}) => ({
    imgUrl: payload.src,
    tabId,
    frameId,
    mode: payload?.mode || null,
    lang: payload?.lang || null,
    source: payload?.source || null,
    metadata: payload.metadata,
    batchId,
    imageKey,
    pageUrl,
    // Per-series AI-memory key, threaded from the context-menu click so the
    // result accumulates under the SAME key the prompt-memory was read from.
    seriesKey: String(payload?.context?.series_key || "").trim(),
    sessionId: originSession || sessionId,
    keepCacheOnStale: isMd,
    settingsEpoch,
    ...extra,
  });

  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, makeContext());
  }

  // --- Ordered submission gate ---------------------------------------------
  // Prefetch/setup above ran fully in parallel; from here the job waits for
  // its page-order turn so the server queue receives the batch in order.
  const orderSeq = Number(payload.__tpSubmitSeq ?? -1);
  await awaitSubmitTurn(batchId, orderSeq);
  const releaseTurn = () => releaseSubmitTurn(batchId, orderSeq);

  // --- REST path -----------------------------------------------------------
  if (preferRest) {
    await submitAndPollRest(base, payload, makeContext, {
      tabId, frameId, batch, batchId, imageKey, releaseTurn,
    });
    return;
  }

  // --- WebSocket path ------------------------------------------------------
  for (let attempt = 0; attempt <= MAX_FIRST_TRY_RETRIES; attempt++) {
    if (!isWsReady()) {
      const connected = await connectWebSocket();
      if (!connected) {
        if (attempt < MAX_FIRST_TRY_RETRIES) {
          await new Promise((r) => setTimeout(r, FIRST_TRY_GAP_MS));
          continue;
        }
        // WS unavailable — fall back to REST for this job.
        await submitAndPollRest(base, payload, makeContext, {
          tabId,
          frameId,
          batch,
          batchId,
          imageKey,
        });
        return;
      }
    }

    const jobId = crypto.randomUUID();
    rememberJob(jobId, makeContext({ startedAt: Date.now(), base }));
    try {
      sendWsJob(jobId, payload);
      releaseTurn(); // submitted — let the next page in the batch go
      return;
    } catch (e) {
      handleJobError(jobId, "Send failed: " + (e?.message || e));
      if (attempt < MAX_FIRST_TRY_RETRIES) {
        await new Promise((r) => setTimeout(r, FIRST_TRY_GAP_MS));
        continue;
      }
      return;
    }
  }
}

/** Submit a job over REST and long-poll it to completion. */
async function submitAndPollRest(
  base, payload, makeContext,
  { tabId, frameId, batch, batchId, imageKey, releaseTurn = () => {} },
) {
  let jobId = "";
  try {
    const idempotencyKey = await idempotencyKeyForPayload(payload);
    payload.idempotency_key = idempotencyKey;
    const submitted = await submitJobViaRest(base, payload, { idempotencyKey });
    // The server queue has this job now — release the batch's ordered slot
    // BEFORE the (long) poll, so the next page submits immediately.
    releaseTurn();
    jobId = String(submitted.id || "");
    const ctx = makeContext({
      startedAt: Date.now(),
      base,
      idempotencyKey,
      serverHints: submitted,
    });
    rememberJob(jobId, ctx);
    subscribeJobEvents(jobId).catch(() => {});
    await pollJobViaRest(base, jobId);
  } catch (e) {
    releaseTurn(); // submit failed/interrupted — never block the batch
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
    failJobImmediately(tabId, payload?.src || null, msg, frameId);
  }
}

/** Resume REST long-polls after a Manifest V3 service-worker restart. */
export async function resumePendingRestJobs() {
  const jobIds = await restorePendingJobs();
  for (const jobId of jobIds) {
    const ctx = pendingByJob.get(jobId);
    const base = String(ctx?.base || "").trim();
    if (!base) continue;
    subscribeJobEvents(jobId).catch(() => {});
    addTask(() => pollJobViaRest(base, jobId).catch((e) => handleJobError(jobId, e?.message || String(e))));
  }
}

/**
 * Queue a payload for processing, skipping it if the tab session it was minted
 * under is already stale.
 */
export function enqueue(payload, tabId, frameId = 0) {
  const expected = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  // Number this payload within its batch (enqueue order == page order) so the
  // ordered-submission gate can hand jobs to the server in page order. Pass-2
  // retries keep their original seq — already released, so they never wait.
  const orderBatch = String(payload?.metadata?.batch_id || currentBatchId || "").trim();
  if (payload && typeof payload === "object" && payload.__tpSubmitSeq == null) {
    payload.__tpSubmitSeq = nextSubmitSeq(orderBatch);
  }
  addTask(() => {
    const cur = getTabSessionId(tabId);
    if (expected && (!cur || expected !== cur)) {
      // Skipped without running processJob — free its ordered slot.
      releaseSubmitTurn(orderBatch, Number(payload?.__tpSubmitSeq ?? -1));
      return;
    }
    return processJob(payload, tabId, frameId);
  });
}

/** Cancel every in-flight job for a tab (called on navigation / tab close). */
export function cancelTabWork(tabId, reason = "navigation") {
  if (!Number.isFinite(tabId)) return;
  const msg = String(reason || "navigation");
  const cancelledJobIds = [];

  for (const [jobId, ctx] of Array.from(pendingByJob.entries())) {
    if ((ctx?.tabId || 0) !== tabId) continue;
    const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
    const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
    const batch = batchId ? ensureBatch(batchId, tabId, ctx?.frameId || 0) : null;

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

  // Drop these jobs on the backend too (queue + rate gate) so a closed or
  // navigated-away tab stops consuming provider budget.
  if (cancelledJobIds.length) {
    cancelJobsViaRest({ jobIds: cancelledJobIds, session: getTabSessionId(tabId) || "" });
  }
}
