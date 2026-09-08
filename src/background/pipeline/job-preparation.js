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
  } = dependencies;

  async function stopIfBatchWasCancelled() {
    if (!batchIsCancelled()) return false;
    await failWorkflow("cancelled with batch");
    return true;
  }

  async function prefetchDataUri(
    payload,
    { tabId, frameId = 0, pageUrl = "" } = {},
  ) {
    if (!shouldPrefetch(payload)) return { stopped: false };
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
      const dataUri = src.startsWith("data:")
        ? src
        : browserOnlySrc
          ? await fetchFromTab(tabId, src, frameId)
          : await fetchFromUrl(src, pageUrl);
      if (dataUri) {
        logInfo("datauri prefetch ok", {
          ms: Date.now() - startedAt,
          kb: Math.round(dataUri.length / 1024),
        });
        applyDataUri(payload, dataUri, key, "prefetch_datauri");
      }
      return { stopped: false };
    } catch (error) {
      let message = error?.message || String(error);
      if (!browserOnlySrc && /\bHTTP 403\b/i.test(message) && tabId) {
        try {
          const dataUri = await fetchFromTab(tabId, src, frameId);
          if (dataUri) {
            logInfo("datauri prefetch ok (tab fallback)", {
              ms: Date.now() - startedAt,
              kb: Math.round(dataUri.length / 1024),
            });
            applyDataUri(payload, dataUri, key, "prefetch_datauri_tab");
            message = null;
          }
        } catch (fallbackError) {
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
