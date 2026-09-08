(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const translationReceipts = new WeakMap();
  const targetInserts = new WeakMap();
  function sleepFrame() {
    return TP.nextFrame();
  }

  // Validates an error against the same page-generation contract as a
  // successful overlay. Kept pure so the stale branch cannot mutate trace,
  // status or image state before the decision is made.
  function checkImageErrorGeneration(runtime, msg) {
    const generation = msg?.generation;
    if (!generation || typeof generation !== "object")
      return { ok: true, legacy: true };
    if (typeof runtime?.isStillCurrent !== "function")
      return { ok: true, legacy: true };
    const img = runtime.findTargetImage?.(msg?.original, msg?.generation) || null;
    return runtime.isStillCurrent(img, generation);
  }

  async function applyImageErrorMessage(msg) {
    const current = checkImageErrorGeneration(TP, msg);
    if (!current.ok) {
      TP.log.info("IMAGE_ERROR dropped: stale target", {
        reason: current.reason || "generation changed",
      });
      return {
        ok: true,
        applied: false,
        stale: true,
        reason: current.reason || "generation changed",
      };
    }
    if (msg.tpTrace) TP.setTrace?.(msg.tpTrace);
    const error =
      msg?.error && msg.error.schema === "tp.error/1" ? msg.error : null;
    const text = error
      ? `${error.userMessage} · ${error.code}`
      : String(msg?.message || "PROCESSING_FAILED");
    // Pages that drive translation themselves (the local viewer, the Auto
    // translate tab) have no context menu to watch and no toast in view.
    // Without this event they would sit on "Translating…" forever whenever a
    // job ends in an error instead of an overlay.
    TP.emitViewerEvent("textphantom:image-error", {
      original: msg?.original,
      message: text,
      error,
    });
    setTimeout(() => {
      if (TP.shouldShowReplaceError(msg?.original)) {
        if (!checkImageErrorGeneration(TP, msg).ok) return;
        const badged = TP.markImageError(msg?.original, error || text, msg?.generation);
        if (!badged) TP.showToast?.(`Not translated: ${text}`, 12000);
      }
    }, 1200);
    return { ok: true };
  }

  async function applyOverlayMessage(msg) {
    const ovMode = typeof msg?.mode === "string" ? msg.mode : "";
    if (!ovMode) return { ok: true, ignored: true };
    const isText = ovMode === "lens_text";
    const source = isText
      ? String(msg?.source || "")
          .trim()
          .toLowerCase()
      : "translated";
    if (isText && !source) return { ok: true, ignored: true };

    let img = TP.findTargetImage(msg.original, msg.generation);

    if (!img && TP.waitForTarget && msg?.generation?.targetKey) {
      img = await TP.waitForTarget(msg.generation.targetKey, () =>
        TP.findTargetImage(msg.original, msg.generation),
      );
      if (!img) {
        return {
          ok: true,
          applied: false,
          expired: true,
          reason: "target never remounted",
        };
      }
    }

    if (img && TP.isStillCurrent) {
      const current = TP.isStillCurrent(img, msg.generation);
      if (!current.ok) {
        TP.log.info("OVERLAY_HTML dropped: stale target", {
          reason: current.reason,
        });
        return {
          ok: true,
          applied: false,
          stale: true,
          reason: current.reason,
        };
      }
    }

    TP.log.info("OVERLAY_HTML", {
      key: TP.mdKeyFromUrl ? TP.mdKeyFromUrl(msg.original) : "",
      found: Boolean(img),
      source,
    });
    if (img) {
      const stamp = msg.translationRun;
      const previous = targetInserts.get(img) || Promise.resolve();
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      targetInserts.set(img, pending);
      await previous.catch(() => {});
      try {
        const seen = translationReceipts.get(img);
        const current = TP.isStillCurrent?.(img, msg.generation);
        if (current && !current.ok) return {ok:true, applied:false, stale:true, reason:current.reason};
        if (stamp && seen && (seen.runId !== stamp.runId || seen.generationId !== stamp.generationId))
          return {ok:true, applied:false, stale:true, reason:'repair generation changed'};
        if (stamp && seen?.runId === stamp.runId && seen?.generationId === stamp.generationId) {
          if (seen.phase === 'repair' && stamp.phase === 'initial')
            return {ok:true, applied:false, stale:true, reason:'initial result arrived after repair'};
          if (stamp.phase === 'repair' && seen.revision === stamp.revision)
            return {ok:true, applied:true, replayed:true};
        }
        const canApply = () => {
          const target = TP.isStillCurrent?.(img, msg.generation);
          const binding = translationReceipts.get(img);
          return target?.ok !== false && !(stamp && binding &&
            (binding.runId !== stamp.runId || binding.generationId !== stamp.generationId));
        };
        const rendered = await TP.applyHtmlOverlay(
          img,
          msg.result,
          source,
          isText,
          msg.original,
          canApply,
        );
        if (rendered?.stale || !canApply())
          return {ok:true, applied:false, stale:true, reason:'translation superseded during rendering'};
        const after = translationReceipts.get(img);
        if (stamp && after && (after.runId !== stamp.runId || after.generationId !== stamp.generationId))
          return {ok:true, applied:false, stale:true, reason:'translation superseded during rendering'};
        if (stamp) translationReceipts.set(img, {...stamp});
        return { ok: true, applied: true };
      } catch (e) {
        TP.log.warn("OVERLAY_HTML failed", e?.message || String(e));
        return { ok: false, applied: false, error: e?.message || String(e) };
      } finally {
        release();
        if (targetInserts.get(img) === pending) targetInserts.delete(img);
      }
    }

    if (TP.isMangaDexHost()) {
      TP.mdRememberPending(msg.original, {
        overlay: { result: msg.result, source, isTextMode: isText },
      });
      TP.scheduleMangaDexMapping?.();
      return { ok: true, applied: false, pending: true };
    }
    return { ok: true, applied: false, notFound: true };
  }

  // Applies one insert message from the background to the page.
  async function applyInsertMessage(message) {
    const msg = message || {};
    const type = String(msg.type || "");

    // IMAGE_ERROR must validate its generation before adopting the producer's
    // trace. Other message types are safe to attach immediately.
    if (msg.tpTrace && type !== "IMAGE_ERROR") TP.setTrace?.(msg.tpTrace);
    TP.traceNote?.("content/overlay.js", "applyInsertMessage", {
      ev: "insert message received",
      type,
      imageId: String(msg?.result?.metadata?.image_id || ""),
    });

    if (type === 'TP_TRANSLATION_BIND') {
      const img = TP.findTargetImage(msg.original, msg.generation);
      if (!img) return {ok:true, applied:false, notFound:true};
      const current = TP.isStillCurrent?.(img, msg.generation);
      if (current && !current.ok) return {ok:true, applied:false, stale:true};
      const seen = translationReceipts.get(img);
      const stamp = msg.translationRun;
      if (stamp && !(seen?.runId === stamp.runId && seen?.generationId === stamp.generationId))
        translationReceipts.set(img, {...stamp, phase:'bound'});
      return {ok:true, applied:true};
    }

    if (type === "REPLACE_IMAGE") {
      const applied = await replaceImageInDOM(msg.original, msg.newSrc, msg.generation);
      if (!applied && TP.isMangaDexHost())
        TP.mdRememberPending(msg.original, { newSrc: msg.newSrc });
      return { ok: true, applied: !!applied };
    }
    if (type === "OVERLAY_HTML") return applyOverlayMessage(msg);
    if (type === "IMAGE_ERROR") return applyImageErrorMessage(msg);
    return { ok: true, ignored: true };
  }

  // Applies insert messages in chunks, yielding a frame between chunks.
  async function applyInsertBatch(items, options = {}) {
    const list = Array.isArray(items) ? items : [];
    const chunkSize = Math.max(
      1,
      Math.min(32, Number(options?.chunkSize) || 16),
    );
    const results = [];
    for (let i = 0; i < list.length; i += chunkSize) {
      if (i > 0) await sleepFrame();
      const chunk = list.slice(i, i + chunkSize);
      const settled = await Promise.all(
        chunk.map(async (item) => {
          const id = String(item?.id || "");
          try {
            const r = await applyInsertMessage(item?.message || item);
            return { id, ...(r || { ok: true }) };
          } catch (e) {
            return { id, ok: false, error: e?.message || String(e) };
          }
        }),
      );
      results.push(...settled);
    }
    return { ok: true, bulk: true, results };
  }

  // Swaps an image's src for a translated one, returning 1 when applied.
  async function replaceImageInDOM(original, newSrc, generation = null) {
    if (TP.isMangaDexHost?.() && TP.mdKeyFromUrl?.(original)) {
      return TP.replaceMangaDexImageWithOverlay(original, newSrc);
    }

    const img = TP.findTargetImage(original, generation);
    if (img && TP.isStillCurrent?.(img, generation)?.ok === false) return 0;
    if (!img) {
      TP.log.warn("REPLACE_IMAGE target not found", {
        original: TP.truncate(original),
      });
      return 0;
    }

    const mdKey = TP.mdKeyFromUrl?.(original);
    if (mdKey) img.dataset.tpOriginalKey = mdKey;
    const key = TP.normUrl(original);
    if (key) img.dataset.tpOriginal = key;
    TP.noteReplaceState(original, "pending");

    if (!img.dataset.tpReplaceTracked) {
      img.dataset.tpReplaceTracked = "1";
      img.addEventListener(
        "load",
        () => TP.setReplaceState(TP.normUrl(img.dataset.tpOriginal), "ok"),
        { passive: true },
      );
      img.addEventListener(
        "error",
        () => {
          const k = TP.normUrl(img.dataset.tpOriginal);
          TP.setReplaceState(k, "fail");
          TP.markImageError(k, "Failed to load replaced image");
        },
        { passive: true },
      );
    }

    const before = img.currentSrc || img.src;

    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await TP.dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    const prevBlob = img.dataset.tpBlobUrl;
    if (prevBlob && prevBlob.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prevBlob);
      } catch {}
      delete img.dataset.tpBlobUrl;
    }
    if (typeof nextSrc === "string" && nextSrc.startsWith("blob:"))
      img.dataset.tpBlobUrl = nextSrc;

    if (TP.isStillCurrent?.(img, generation)?.ok === false) return 0;
    TP.noteAppliedImageSource?.(img, nextSrc);
    img.src = nextSrc;
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("data-src");
    img.removeAttribute("data-srcset");
    img.removeAttribute("loading");
    img.decoding = "sync";
    img.loading = "eager";
    TP.emitViewerEvent("textphantom:image-updated", {
      original,
      newSrc: nextSrc,
      rawNewSrc: newSrc,
    });
    TP.log.info("REPLACE_IMAGE done", {
      before: TP.truncate(before),
      original: TP.truncate(original),
    });
    return 1;
  }
  Object.assign(TP, {
    applyInsertBatch,
    applyInsertMessage,
    replaceImageInDOM,
  });
})();
