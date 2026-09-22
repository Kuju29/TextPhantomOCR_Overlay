import { note as traceNote } from "../../shared/trace.js";

// Image jobs are admitted by their existing resource lanes. Preparing one
// image must not hold a chapter-wide permit until that image's AI has finished.
export function releasePreparedDataUri(payload) {
  if (!payload || typeof payload !== "object") return;
  // Repair/checkpoint has its own cache. Do not retain a second payload
  // reference in terminal batch records.
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
    acquireReader,
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
    { tabId, frameId = 0, pageUrl = "", signal = null } = {},
  ) {
    if (!shouldPrefetch(payload)) return { stopped: false };
    if (signal?.aborted) return { stopped: true, cancelled: true };
    onDownloadStarted();
    const src = String(payload.src || "").trim();
    const key = payload.reader?.runId ? `reader:${payload.reader.runId}:${src}` : normalizeImageKey(src);
    const cached = getCached(key);
    if (cached) {
      payload.imageDataUri = cached;
      return { stopped: false, cached: true };
    }

    const startedAt = Date.now();
    const browserOnlySrc =
      /^(?:blob:|file:|chrome-extension:|moz-extension:)/i.test(src);
    try {
      const dataUri = await (payload.reader?.runId && acquireReader
        ? acquireReader(payload,{tabId,frameId,pageUrl,signal})
        : src.startsWith("data:")
        ? src
        : browserOnlySrc
          ? fetchFromTab(tabId, src, frameId, signal)
          : fetchFromUrl(src, pageUrl, signal));
      if (signal?.aborted) {
        return { stopped: true, cancelled: true };
      }
      if (dataUri) {
        applyPreparedDataUri(payload, dataUri, key, "prefetch_datauri", {
          ms: Date.now() - startedAt,
          acquisitionMs: Date.now() - startedAt,
          kb: Math.round(dataUri.length / 1024),
        });
      }
      return { stopped: false };
    } catch (error) {
      if (error?.name === "AbortError")
        return { stopped: true, cancelled: true };
      let message = error?.message || String(error);
      if (!payload.reader && !browserOnlySrc && /\bHTTP 403\b/i.test(message) && tabId) {
        try {
          const fallbackAt = Date.now();
          const dataUri = await fetchFromTab(tabId, src, frameId, signal);
          if (signal?.aborted) {
            return { stopped: true, cancelled: true };
          }
          if (dataUri) {
            applyPreparedDataUri(
              payload, dataUri, key, "prefetch_datauri_tab",
              { ms: Date.now() - startedAt, acquisitionMs: Date.now() - fallbackAt,
                kb: Math.round(dataUri.length / 1024) },
              "datauri prefetch ok (tab fallback)",
            );
            message = null;
          }
        } catch (fallbackError) {
          if (fallbackError?.name === "AbortError")
            return { stopped: true, cancelled: true };
          message = fallbackError?.message || String(fallbackError);
          logWarn("datauri prefetch tab fallback failed", { err: message });
        }
      }

      if (!message) return { stopped: false };
      const classification = browserOnlySrc || payload.reader?.runId
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

  function applyPreparedDataUri(
    payload, dataUri, key, stage, details, message = "datauri prefetch ok",
  ) {
    try {
      logInfo(message, { ...details, admission: "stage_owned" });
      traceNote("background/pipeline/job-preparation.js", "imageAcquisition", {
        schema:'tp.audit/1',event:'image_status',phase:'downloading',reason:'finished',
        scope:{batchId:payload.metadata?.batch_id || '',imageId:payload.metadata?.image_id || '',
          runId:payload.reader?.runId || '',pageId:`p${payload.reader?.pageId ?? ((payload.context?.page_index ?? 0) + 1)}`},
        timing:{queueMs:0,readMs:details.acquisitionMs || 0,elapsedMs:details.ms || 0},
      }, payload.context?.tp_trace || "");
      applyDataUri(payload, dataUri, key, stage);
    } catch (error) {
      delete payload.imageDataUri;
      throw error;
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
