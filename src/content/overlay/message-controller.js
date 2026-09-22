(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const translationReceipts = new WeakMap();
  const targetInserts = new WeakMap();
  const replacementOwners = new WeakMap();
  const pageHidden = () => globalThis.document?.visibilityState
    ? globalThis.document.visibilityState === "hidden" : null;

  function replacementOwnerIsCurrent(owner) {
    if (!owner || owner.pageInstanceId !== TP.pageInstanceId) return false;
    return TP.isStillCurrent?.(owner.target, owner.generation)?.ok !== false;
  }
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
    if (generation.readerRunId && runtime.readerErrorCurrent) {
      const anchor = runtime.findReaderErrorTarget?.(generation);
      return runtime.readerErrorCurrent(anchor, generation);
    }
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
    // An explicit current-generation failure must not be hidden by a prior
    // successful replacement of this URL, or wait for the failed IMG to load.
    if (!msg.generation && !error && !TP.shouldShowReplaceError(msg?.original))
      return { ok:true, applied:false, suppressed:true };
    const badged = TP.markImageError(msg?.original, error || text, msg?.generation);
    if (!badged) TP.showToast?.(`Not translated: ${text}`, 12000);
    return { ok:true, applied:badged === true, drawn:false, errorDisplayed:badged === true };
  }

  async function showPlacementError(msg) {
    // The reader owns its bounded retries. NORMAL has no deferred replay owner.
    if (msg.generation?.readerRunId) return;
    await applyImageErrorMessage({...msg,type:'IMAGE_ERROR',
      error:{schema:'tp.error/1',code:'INSERT_FAILED',userMessage:'ไม่สามารถแทรกผลแปลบนภาพได้'}});
  }

  async function applyOverlayMessage(msg) {
    const contentReceivedAt=Date.now();
    const hiddenAtStart=pageHidden();
    const visibilityEpoch=TP.getVisibilityEpoch?.() || 0;
    const ovMode = typeof msg?.mode === "string" ? msg.mode : "";
    if (!ovMode) return { ok: true, ignored: true };
    const isText = ovMode === "lens_text";
    const source = isText
      ? String(msg?.source || "")
          .trim()
          .toLowerCase()
      : "translated";
    if (isText && !source) return { ok: true, ignored: true };

    let img = msg.readerReplayTarget || TP.findTargetImage(msg.original, msg.generation);

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
          if (stamp.phase === 'repair' && seen.revision === stamp.revision &&
              (!msg.generation?.readerRunId || TP.overlayMount?.hasHtmlOverlay?.(msg.generation.targetKey,img)))
            return {ok:true, applied:true, replayed:true, drawn:seen.drawn!==false};
        }
        const canApply = () => {
          const target = TP.isStillCurrent?.(img, msg.generation);
          const binding = translationReceipts.get(img);
          return target?.ok !== false && !(stamp && binding &&
            (binding.runId !== stamp.runId || binding.generationId !== stamp.generationId));
        };
        const renderStartedAt=Date.now();
        const rendered = await TP.applyHtmlOverlay(
          img,
          msg.result,
          source,
          isText,
          msg.original,
          canApply,
          msg.tpTrace || "",
          JSON.stringify([msg.generation || null, stamp?.runId || "", stamp?.generationId || ""]),
          msg.generation?.readerRunId ? msg.generation.targetKey : "",
        );
        if (rendered?.stale || !canApply())
          return {ok:true, applied:false, stale:true, reason:'translation superseded during rendering'};
        const after = translationReceipts.get(img);
        if (stamp && after && (after.runId !== stamp.runId || after.generationId !== stamp.generationId))
          return {ok:true, applied:false, stale:true, reason:'translation superseded during rendering'};
        if (msg.streamError && canApply())
          TP.markImageError?.(msg.original, String(msg.streamError), msg.generation);
        if (stamp) translationReceipts.set(img, {...stamp, drawn:rendered?.drawn!==false});
        if(msg.tpStreamTiming){
          const timing={schema:'tp.audit/1',event:'page_stream_timing',reason:'dom_acknowledged',
            ...msg.tpStreamTiming,contentReceivedAt,renderStartedAt,renderFinishedAt:Date.now(),
            contentToAckMs:Date.now()-contentReceivedAt,
            domQueueMs:Number.isFinite(msg.tpStreamTiming.domEnqueuedAt)
              ? Math.max(0,contentReceivedAt-msg.tpStreamTiming.domEnqueuedAt):null,
            hiddenAtStart,hiddenAtFinish:pageHidden(),
            visibilityChanges:(TP.getVisibilityEpoch?.() || 0)-visibilityEpoch,
            reused:rendered?.reused===true,runId:stamp?.runId||'',generationId:stamp?.generationId||''};
          (TP.traceNoteFor?.bind(TP,msg.tpTrace||'')||TP.traceNote)?.(
            'content/overlay/message-controller.js','provisionalRenderAck',timing);
        }
        return { ok: true, applied: true, drawn:rendered?.drawn!==false, reused:rendered?.reused===true };
      } catch (e) {
        TP.log.warn("OVERLAY_HTML failed", e);
        await showPlacementError(msg);
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
    if (msg.generation?.readerRunId && !msg.readerReplay)
      return TP.stageReaderInsert?.(msg) || {ok:false,error:"Reader placement unavailable"};

    // IMAGE_ERROR must validate its generation before adopting the producer's
    // trace. Other message types are safe to attach immediately.
    if (msg.tpTrace && type !== "IMAGE_ERROR") TP.setTrace?.(msg.tpTrace);
    TP.traceNote?.("content/overlay.js", "applyInsertMessage", {
      ev: "insert message received",
      type,
      imageId: String(msg?.result?.metadata?.image_id || ""),
    });

    if (type === 'TP_TRANSLATION_BIND') {
      const img = msg.readerReplayTarget || TP.findTargetImage(msg.original, msg.generation);
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
      try {
        const applied = await replaceImageInDOM(msg.original, msg.newSrc, msg.generation, msg.readerReplayTarget);
        if (!applied && TP.isMangaDexHost())
          TP.mdRememberPending(msg.original, { newSrc: msg.newSrc });
        else if (!applied && TP.findTargetImage(msg.original,msg.generation))
          await showPlacementError(msg);
        return { ok: true, applied: !!applied };
      } catch(error) {
        if(msg.generation?.readerRunId) throw error; // reported once by reader retry owner
        TP.log.warn('REPLACE_IMAGE failed',error);
        await showPlacementError(msg);
        return {ok:false,applied:false,error:error?.message || String(error)};
      }
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
  async function replaceImageInDOM(original, newSrc, generation = null, replayTarget = null) {
    if (TP.isMangaDexHost?.() && TP.mdKeyFromUrl?.(original)) {
      return TP.replaceMangaDexImageWithOverlay(original, newSrc, generation);
    }

    // A reader replay pins the target across async bindings/conversion. Looking
    // up a fresh IMG here can draw on a new node while its caller still owns the
    // old node, losing the insertion receipt and blob ownership on fast scroll.
    const img = replayTarget || TP.findTargetImage(original, generation);
    if (img && TP.isStillCurrent?.(img, generation)?.ok === false) return 0;
    if (!img) {
      TP.log.warn("REPLACE_IMAGE target not found", {
        original: TP.truncate(original),
      });
      return 0;
    }

    // X owns its media <img> elements and may restore their src or recycle the
    // node after any React update. Keep the translated raster in the same
    // fixed, identity-aware portal used by X text overlays instead of mutating
    // page-owned image attributes.
    if (generation?.readerRunId || (TP.isXHost?.() && TP.imageIdentity?.(original))) {
      if (TP.isStillCurrent?.(img, generation)?.ok === false) return 0;
      let nextSrc = newSrc;
      let ownsNextBlob = false;
      if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
        const blobUrl = await TP.dataUriToBlobUrl(newSrc);
        if (blobUrl) {
          nextSrc = blobUrl;
          ownsNextBlob = true;
        }
      }
      if (TP.isStillCurrent?.(img, generation)?.ok === false) {
        if (ownsNextBlob) {
          try {
            URL.revokeObjectURL(nextSrc);
          } catch {}
        }
        return 0;
      }

      const key = generation?.readerRunId ? generation.targetKey : TP.normUrl(original);
      if (!key || !nextSrc) {
        if (ownsNextBlob) {
          try {
            URL.revokeObjectURL(nextSrc);
          } catch {}
        }
        return 0;
      }
      const rec = TP.overlayMount?.upsertHtmlOverlay?.(
        key,
        img,
        Number(img.naturalWidth) || Number(img.width) || 1,
        Number(img.naturalHeight) || Number(img.height) || 1,
        "raster",
      );
      if (!rec) {
        if (ownsNextBlob) {
          try {
            URL.revokeObjectURL(nextSrc);
          } catch {}
        }
        return 0;
      }

      if (
        rec.rasterBlobUrl?.startsWith("blob:") &&
        rec.rasterBlobUrl !== nextSrc
      ) {
        try {
          URL.revokeObjectURL(rec.rasterBlobUrl);
        } catch {}
      }
      rec.rasterBlobUrl =
        typeof nextSrc === "string" && nextSrc.startsWith("blob:")
          ? nextSrc
          : "";
      rec.scope?.replaceChildren?.();
      const raster = TP.overlayBackground?.layer?.(rec);
      if (!raster) {
        if (ownsNextBlob) {
          try {
            URL.revokeObjectURL(nextSrc);
          } catch {}
          rec.rasterBlobUrl = "";
        }
        return 0;
      }
      if (!raster.dataset.tpReplaceTracked) {
        raster.dataset.tpReplaceTracked = "1";
        raster.addEventListener(
          "load",
          () => {
            const owner = replacementOwners.get(raster);
            if (rec.original && replacementOwnerIsCurrent(owner))
              TP.setReplaceState(rec.original, "ok");
          },
          { passive: true },
        );
        raster.addEventListener(
          "error",
          () => {
            const owner = replacementOwners.get(raster);
            if (!rec.original || !replacementOwnerIsCurrent(owner)) return;
            TP.setReplaceState(rec.original, "fail");
            TP.markImageError(rec.original, "Failed to load replaced image", owner.generation);
          },
          { passive: true },
        );
      }
      rec.original = key;
      replacementOwners.set(raster, {
        target: img,
        generation,
        pageInstanceId: TP.pageInstanceId,
      });
      if (img.dataset && !generation?.readerRunId) img.dataset.tpOriginal = key;
      TP.noteReplaceState(original, "pending");
      // Clear the previous attempt's warning when applying a new result, not
      // on its delayed load event (which may follow a newer terminal error).
      TP.clearImageError?.(img);
      TP.overlayBackground.update(rec, img, nextSrc);
      rec.rasterSource = nextSrc;
      TP.overlayMount.scheduleHtmlOverlayUpdate(key);
      TP.emitViewerEvent("textphantom:image-updated", {
        original,
        newSrc: nextSrc,
        rawNewSrc: newSrc,
      });
      TP.log.info(generation?.readerRunId ? "Reader raster placed" : "REPLACE_IMAGE overlaid for X", {
        original: TP.truncate(original),
      });
      return 1;
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
        () => {
          const owner = replacementOwners.get(img);
          if (replacementOwnerIsCurrent(owner))
            TP.setReplaceState(owner.original, "ok");
        },
        { passive: true },
      );
      img.addEventListener(
        "error",
        () => {
          const owner = replacementOwners.get(img);
          if (!replacementOwnerIsCurrent(owner)) return;
          TP.setReplaceState(owner.original, "fail");
          TP.markImageError(owner.original, "Failed to load replaced image", owner.generation);
        },
        { passive: true },
      );
    }
    replacementOwners.set(img, {
      target: img,
      original: key,
      generation,
      pageInstanceId: TP.pageInstanceId,
    });

    const before = img.currentSrc || img.src;

    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await TP.dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    // Conversion yields. Fast scrolling may replace the target while it runs.
    // Validate BEFORE revoking/assigning per-IMG ownership, and release only the
    // new blob created by this attempt when its original target is gone.
    if (TP.isStillCurrent?.(img, generation)?.ok === false) {
      if (nextSrc !== newSrc && typeof nextSrc === 'string' && nextSrc.startsWith('blob:'))
        try { URL.revokeObjectURL(nextSrc); } catch {}
      return 0;
    }

    const prevBlob = img.dataset.tpBlobUrl;
    if (prevBlob && prevBlob !== nextSrc && prevBlob.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prevBlob);
      } catch {}
      delete img.dataset.tpBlobUrl;
    }
    if (typeof nextSrc === "string" && nextSrc.startsWith("blob:"))
      img.dataset.tpBlobUrl = nextSrc;

    if (TP.isStillCurrent?.(img, generation)?.ok === false) return 0;
    TP.noteAppliedImageSource?.(img, nextSrc);
    TP.clearImageError?.(img);
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
