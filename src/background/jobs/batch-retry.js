export function withPipelineStage(payload, stage) {
  const meta =
    payload?.metadata && typeof payload.metadata === "object"
      ? payload.metadata
      : {};
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

export function createBatchRetryCoordinator({
  retryGapMs,
  batchPassStats,
  selectRetryCandidates,
  updateToast,
  stopKeepAlive,
  markImagePhase,
  batchMark,
  addTask,
  imageKeyFromPayload,
  normalizeImageKey,
  getCachedDataUri,
  fetchImageDataUriFromUrl,
  setCachedDataUri,
  classifyJobError,
  enqueue,
  onComplete = null,
}) {
  function finalizeBatch(batch) {
    if (!batch) return;
    const stats = batchPassStats(batch);
    if (!stats.total || stats.finished < stats.total) return;

    if (batch.pass === 1) {
      if (batch.retryScheduled) return;
      const { failed, permanentErrors } = selectRetryCandidates(batch.items);
      if (!failed.length) {
        const label = permanentErrors ? `Done (${permanentErrors} errors)` : "Done";
        if (onComplete) void onComplete(batch, label);
        else { updateToast(batch, label, true); void stopKeepAlive(batch); }
        return;
      }
      batch.retryScheduled = true;
      batch.pass = 2;
      batch.total2 = failed.length;
      for (const key of failed) {
        const item = batch.items.get(key);
        if (!item) continue;
        markImagePhase(batch.id, key, "waiting", {
          attempt: 2,
          lastError: "",
          permanent: false,
          initialAiTerminal: false,
          phaseAt: Date.now(),
        });
        batchMark(batch.id, key, {
          payload: withPipelineStage(item.payload, "retry_failed_once"),
        });
      }
      updateToast(
        batch,
        `Retrying ${failed.length} failed image(s) shortly`,
        true,
      );
      addTask(() => runRetryPass(batch));
      return;
    }

    const label = stats.error ? `Done (${stats.error} errors)` : "Done";
    if (onComplete) void onComplete(batch, label);
    else { updateToast(batch, label, true); void stopKeepAlive(batch); }
  }

  async function runRetryPass(batch) {
    await new Promise((resolve) => setTimeout(resolve, retryGapMs));
    const payloads = Array.from(batch.items.values())
      .filter(
        (item) =>
          item?.attempt === 2 && item.status === "queued" && item.payload,
      )
      .map((item) => item.payload);
    updateToast(batch, "Starting retry pass", true);

    for (const payload of payloads) {
      let next = payload;
      let skip = false;
      try {
        const src = String(payload?.src || "").trim();
        if (src && /^https?:/i.test(src) && !payload?.imageDataUri) {
          const key = normalizeImageKey(src);
          const dataUri =
            getCachedDataUri(key) ||
            (await fetchImageDataUriFromUrl(
              src,
              payload?.context?.page_url || "",
            ));
          if (dataUri) {
            next = withPipelineStage(
              { ...payload, imageDataUri: dataUri },
              "retry_attach_datauri",
            );
            setCachedDataUri(key, dataUri);
            const imageKey = imageKeyFromPayload(next);
            if (imageKey && batch.items.has(imageKey)) {
              batch.items.set(imageKey, {
                ...batch.items.get(imageKey),
                payload: next,
              });
            }
          }
        }
      } catch (error) {
        const message = String(error?.message || error);
        const classification = /\bHTTP 403\b/i.test(message)
          ? { permanent: false }
          : classifyJobError(message);
        const imageKey = imageKeyFromPayload(payload);
        if (imageKey && batch.items.has(imageKey)) {
          const item = batch.items.get(imageKey);
          if (classification.permanent) {
            markImagePhase(batch.id, imageKey, "error", {
              lastError: message,
              permanent: true,
            });
            updateToast(batch, "Error (permanent)");
            finalizeBatch(batch);
          } else {
            batch.items.set(imageKey, {
              ...item,
              lastError: message,
              permanent: false,
            });
          }
        }
        skip = classification.permanent === true;
      }
      if (!skip) enqueue(next, batch.tabId, batch.frameId || 0);
    }
  }

  return { finalizeBatch };
}
