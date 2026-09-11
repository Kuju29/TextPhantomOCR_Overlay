// Image acquisition happens before the Lens/AI lanes. Keep it independently
// bounded so a large chapter cannot fetch and base64-encode every image at once.
export function createPrefetchAdmission(maxActive = 4) {
  const limit = Math.max(1, Math.floor(Number(maxActive) || 4));
  let active = 0;
  const waiters = [];

  function pump() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException("The operation was aborted", "AbortError"));
        continue;
      }
      active += 1;
      waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
      waiter.resolve(() => {
        if (waiter.released) return;
        waiter.released = true;
        active = Math.max(0, active - 1);
        pump();
      });
    }
  }

  function acquire(signal = null) {
    if (signal?.aborted)
      return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const waiter = { signal, resolve, reject, released: false, onAbort: null };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
      pump();
    });
  }

  return {
    acquire,
    async run(work, signal = null) {
      const release = await acquire(signal);
      try {
        if (signal?.aborted)
          throw new DOMException("The operation was aborted", "AbortError");
        return await work();
      } finally {
        release();
      }
    },
    describe: () => ({ active, queued: waiters.length, limit }),
  };
}

export const imagePrefetchAdmission = createPrefetchAdmission(4);

// Fetch completion does not end the lifetime of a large base64 allocation.
// Keep its admission lease outside the serializable payload until the complete
// image job has consumed it (or stopped on any error/cancellation path).
const retainedPayloads = new WeakMap();

function retainPreparedDataUri(payload, release) {
  retainedPayloads.get(payload)?.();
  retainedPayloads.set(payload, release);
}

export function releasePreparedDataUri(payload) {
  if (!payload || typeof payload !== "object") return;
  const release = retainedPayloads.get(payload);
  if (release) {
    retainedPayloads.delete(payload);
    release();
  }
  // Repair/checkpoint owns an independently bounded cache entry.  Do not let
  // pending/batch records retain a second per-job reference after terminal.
  delete payload.imageDataUri;
}

// Injectable preparation lifecycle for one queued image. The composition root
// owns event order; this object owns the work performed inside each checkpoint.
export function createJobPreparation(dependencies) {
  const {
    batchIsCancelled,
    failWorkflow,
    shouldPrefetch,
    fetchFromTab,
    fetchFromUrl,
    getCached,
    setCached,
    normalizeImageKey,
    classifyError,
    onDownloadStarted,
    onPayloadUpdated,
    onPermanentReadError,
    logInfo,
    logWarn,
    prefetchAdmission = imagePrefetchAdmission,
  } = dependencies;

  async function stopIfBatchWasCancelled() {
    if (!batchIsCancelled()) return false;
    await failWorkflow("cancelled with batch");
    return true;
  }

  async function prefetchDataUri(
    payload,
    { tabId, frameId = 0, pageUrl = "", signal = null } = {},
  ) {
    if (!shouldPrefetch(payload)) return { stopped: false };
    if (signal?.aborted) return { stopped: true, cancelled: true };
    onDownloadStarted();
    const src = String(payload.src || "").trim();
    const key = normalizeImageKey(src);
    const cached = getCached(key);
    if (cached) {
      payload.imageDataUri = cached;
      return { stopped: false, cached: true };
    }

    const startedAt = Date.now();
    const browserOnlySrc =
      /^(?:blob:|file:|chrome-extension:|moz-extension:)/i.test(src);
    try {
      const { dataUri, release } = await fetchWithRetention(() => src.startsWith("data:")
        ? src
        : browserOnlySrc
          ? fetchFromTab(tabId, src, frameId, signal)
          : fetchFromUrl(src, pageUrl, signal), signal);
      if (signal?.aborted) {
        release();
        return { stopped: true, cancelled: true };
      }
      if (dataUri) {
        applyRetainedDataUri(payload, dataUri, key, "prefetch_datauri", release, {
          ms: Date.now() - startedAt,
          kb: Math.round(dataUri.length / 1024),
        });
      } else {
        release();
      }
      return { stopped: false };
    } catch (error) {
      if (error?.name === "AbortError")
        return { stopped: true, cancelled: true };
      let message = error?.message || String(error);
      if (!browserOnlySrc && /\bHTTP 403\b/i.test(message) && tabId) {
        try {
          const { dataUri, release } = await fetchWithRetention(
            () => fetchFromTab(tabId, src, frameId, signal), signal);
          if (signal?.aborted) {
            release();
            return { stopped: true, cancelled: true };
          }
          if (dataUri) {
            applyRetainedDataUri(
              payload, dataUri, key, "prefetch_datauri_tab", release,
              { ms: Date.now() - startedAt, kb: Math.round(dataUri.length / 1024) },
              "datauri prefetch ok (tab fallback)",
            );
            message = null;
          } else {
            release();
          }
        } catch (fallbackError) {
          if (fallbackError?.name === "AbortError")
            return { stopped: true, cancelled: true };
          message = fallbackError?.message || String(fallbackError);
          logWarn("datauri prefetch tab fallback failed", { err: message });
        }
      }

      if (!message) return { stopped: false };
      const classification = browserOnlySrc
        ? { permanent: true }
        : classifyError(message);
      logWarn("datauri prefetch failed", {
        err: message,
        permanent: classification.permanent,
      });
      if (!classification.permanent) return { stopped: false };

      const code = browserOnlySrc
        ? "IMG_BLOCKED"
        : /not an image/i.test(message)
          ? "IMG_INVALID"
          : /too large/i.test(message)
            ? "IMG_TOO_LARGE"
            : "IMG_READ_FAILED";
      await onPermanentReadError({ payload, message, code });
      return { stopped: true };
    }
  }

  async function fetchWithRetention(work, signal) {
    const release = await prefetchAdmission.acquire(signal);
    try {
      if (signal?.aborted)
        throw new DOMException("The operation was aborted", "AbortError");
      return { dataUri: await work(), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  function applyRetainedDataUri(
    payload, dataUri, key, stage, release, details, message = "datauri prefetch ok",
  ) {
    let transferred = false;
    try {
      logInfo(message, details);
      applyDataUri(payload, dataUri, key, stage);
      retainPreparedDataUri(payload, release);
      transferred = true;
    } finally {
      // Observer/cache failures are unusual, but must not leak an admission
      // slot and deadlock every later image in the chapter.
      if (!transferred) {
        delete payload.imageDataUri;
        release();
      }
    }
  }

  function applyDataUri(payload, dataUri, key, stage) {
    payload.imageDataUri = dataUri;
    if (key) setCached(key, dataUri);
    const metadata = payload.metadata;
    metadata.pipeline = (
      Array.isArray(metadata.pipeline) ? metadata.pipeline : []
    ).concat({
      stage,
      at: new Date().toISOString(),
    });
    metadata.timestamp = new Date().toISOString();
    onPayloadUpdated(payload);
  }

  return { stopIfBatchWasCancelled, prefetchDataUri };
}
