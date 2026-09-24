// Routes runtime messages from the service worker to the content-script handlers.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Collects the payloads for a GET_IMAGES request, including the MangaDex path.
  async function collectImages(mode, lang) {
    const reader = await TP.collectReaderImages?.(mode, lang);
    if (reader) return reader;
    TP.cancelReaderRun?.("normal_run", true);
    TP.removeLazyScriptsAndForceSrc();
    TP.normalizeLazyImages();

    if (!TP.isMangaDexHost()) {
      TP.scanDiag?.emit('route.selected', {route:'NORMAL', reason:'no_dynamic_reader'});
      return TP.collectImagesForScan(mode, lang, "page_scan");
    }

    TP.scanDiag?.emit('route.selected', {route:'MANGADEX', reason:'site_adapter'});

    TP.showToast("TextPhantom: loading MangaDex pages…", 2600);

    if (typeof TP.collectMangaDexPages === "function") {
      const viaAdapter = await TP.collectMangaDexPages(mode, lang).catch(
        () => null,
      );
      if (Array.isArray(viaAdapter) && viaAdapter.length) return viaAdapter;
    }

    TP.scheduleMangaDexMapping();
    await TP.ensureMangaDexDomMapping();
    const hydrated = await TP.hydrateMangaDexFromCache().catch(() => null);
    const cacheItems = hydrated?.items || null;
    const wantsHtml = String(mode || "").includes("text");

    const isCached = (src) => {
      if (!cacheItems) return false;
      const rec = cacheItems[TP.mdKeyFromUrl(String(src || ""))];
      if (!rec) return false;
      return wantsHtml ? Boolean(rec.result) : Boolean(rec.hasNewImg);
    };

    const seen = new Set();
    const out = [];

    const posBySrc = new Map();
    TP.getMangaDexPageImagesInDOM().forEach((img) => {
      const src = TP.normUrl(TP.getBestImgUrl(img));
      if (TP.isHttpish(src) && !isCached(src) && !posBySrc.has(src)) {
        posBySrc.set(src, TP.buildPositionFromElement(img));
      }
    });

    const urls = (await TP.getMangaDexManifest())?.urls || [];
    for (const src of urls) {
      const u = TP.normUrl(src);
      if (!TP.isHttpish(u) || isCached(u) || seen.has(u)) continue;
      seen.add(u);
      out.push(
        TP.buildPayload(
          { original_image_url: u, position: posBySrc.get(u) || null },
          mode,
          lang,
          "page_scan",
          "collected_mangadex_api",
        ),
      );
    }
    for (const [src, pos] of posBySrc.entries()) {
      if (!TP.isHttpish(src) || isCached(src) || seen.has(src)) continue;
      seen.add(src);
      out.push(
        TP.buildPayload(
          { original_image_url: src, position: pos || null },
          mode,
          lang,
          "page_scan",
          "collected_mangadex_dom",
        ),
      );
    }
    const items = out.filter(Boolean);
    return {
      ok: true,
      items,
      stats: {
        candidates: urls.length + posBySrc.size,
        accepted: items.length,
        skipped: 0,
        duplicates: 0,
        reasons: {},
      },
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      const type = String(msg?.type || "");

      if (type === "TP_PING") return sendResponse({ ok: true });
      if (type === 'TP_IMAGE_SCAN_DIAGNOSTIC') {
        if (TP.scanDiag?.has(msg.scanId) || TP.scanDiag?.begin(msg.scanId,msg.detail?.trigger))
          TP.scanDiag.emit(`worker.${String(msg.phase || 'event')}`,msg.detail,msg.scanId);
        return sendResponse({ok:true});
      }
      if (type === "TP_DIAGNOSTICS_STATE") {
        const detail =
          msg?.detail === "full" ? "full" : msg?.enabled ? "compact" : "off";
        TP.setLogLevel?.(msg?.consoleLevel || "warn");
        TP.setTracingEnabled?.(Boolean(msg?.enabled), detail);
        const wrapped = detail === "full" ? TP.installTrace?.() || 0 : 0;
        return sendResponse({
          ok: true,
          detail,
          consoleLevel: TP.getLogLevel?.() || "warn",
          wrapped,
        });
      }
      if (type === "TP_KEEPALIVE_START") {
        TP.keepAlive.start(msg?.ms, msg?.batchId);
        return sendResponse({ ok: true });
      }
      if (type === "TP_KEEPALIVE_STOP") {
        TP.keepAlive.stop(msg?.batchId);
        return sendResponse({ ok: true });
      }
      if (type === "TP_TOAST") {
        TP.showToast(msg?.text || msg?.message || "", msg?.ms ?? 1600, msg?.progress);
        return sendResponse({ ok: true });
      }
      if (type === "BATCH_STATUS_UPDATE") {
        TP.updateBatchProgress?.(msg?.batch || null);
        return sendResponse({ ok: true });
      }
      if (type === "API_STATUS_UPDATE") {
        return sendResponse({ ok: true });
      }
      if (type === "TP_BULK_INSERT") {
        const r = await TP.applyInsertBatch?.(msg?.items || [], {
          chunkSize: msg?.chunkSize,
        });
        return sendResponse(
          r || { ok: false, bulk: true, error: "bulk insert unavailable" },
        );
      }

      if (type === "TP_READER_DOM_FETCH") {
        if(msg?.diagnosticId)TP.scanDiag?.emit('content.dom_fetch_start',{
          pageId:String(msg.pageId || ''),source:TP.scanDiag.describeSource(msg.url,msg.diagnosticId)},msg.diagnosticId);
        const result=await TP.readReaderDomImage(msg);
        if(msg?.diagnosticId)TP.scanDiag?.emit('content.dom_fetch_result',{
          pageId:String(msg.pageId || ''),ok:result?.ok === true,
          encodedChars:result?.dataUri?.length || 0,
          error:result?.ok ? null : TP.scanDiag.error(result?.error)},msg.diagnosticId);
        return sendResponse(result);
      }
      if (type === "TP_READER_RELEASE") return sendResponse(await TP.releaseReaderPlacement(msg.readerRunId));
      if (type === "TP_READER_CANCEL") {
        if (!msg.readerRunId || TP.readerOwnsRun?.(msg.readerRunId)) TP.cancelReaderRun?.(msg.reason || "worker_cancel");
        return sendResponse({ok:true});
      }

      if (type === 'GET_IMAGES') {
        if(msg?.diagnosticId)TP.scanDiag?.begin(msg.diagnosticId,msg.diagnosticTrigger);
        else TP.scanDiag?.deactivate();
      }
      if (type === 'GET_CONTEXT_IMAGE_PAYLOAD') TP.scanDiag?.deactivate();
      const { mode, lang } = await TP.getSettings();

      if (type === "GET_IMAGES") {
        const startedAt=Date.now();
        TP.scanDiag?.emit('content.scan_start', {mode,lang,frame:window.top===window?'top':'child'});
        const resp = await collectImages(mode, lang);
        const items = Array.isArray(resp)
          ? resp
          : Array.isArray(resp?.items)
            ? resp.items
            : [];
        const stats = Array.isArray(resp) ? null : resp?.stats || null;
        TP.log.info("GET_IMAGES", {
          returned: items.length,
          skipped: stats?.skipped || 0,
          host: location.host,
        });
        TP.scanDiag?.emit('content.scan_result', {accepted:items.length,stats,
          reader:items.some(item=>Boolean(item?.reader?.runId)),elapsedMs:Date.now()-startedAt});
        TP.scanDiag?.snapshot('at_response');
        TP.scanDiag?.followup();
        return sendResponse({ ok: true, items, stats });
      }

      if (type === "GET_CONTEXT_IMAGE_PAYLOAD") {
        const img = TP.getFreshRightClickImageForTarget?.({
          srcUrl: msg?.srcUrl,
          clickedSrcUrl: msg?.clickedSrcUrl,
        });
        // The requester may be running this one image on its own mode/language
        // (the Auto translate tab does). Build the payload for THAT mode:
        // `render.lensDocument` and the background mode are decided here, and
        // deciding them from the shared setting would describe a different job
        // than the one that is about to run.
        const wantMode = String(msg?.overrides?.mode || "").trim() || mode;
        const wantLang = String(msg?.overrides?.lang || "").trim() || lang;
        const readerPayload = img ? await TP.buildReaderImagePayload?.(img,wantMode,wantLang) : null;
        const payload = readerPayload || (img
          ? await TP.buildPayloadFromImage(
              img,
              wantMode,
              wantLang,
              "img_one",
              "context_menu_single",
              true,
            )
          : null);
        return sendResponse({ ok: Boolean(payload), payload });
      }

      if (type === "TP_IMAGE_STATUS") {
        return sendResponse(TP.updateImageStatus?.(msg) || {ok:false});
      }

      if (type === "REPLACE_IMAGE") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: false, error: "replace unavailable" });
      }

      if (type === "RESOLVE_AND_REPLACE_MANGADEX_BLOB") {
        const resolved = await TP.resolveMangaDexOriginalForBlob(msg.blobUrl);
        return sendResponse({ resolved });
      }

      if (type === "IMAGE_ERROR") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: true });
      }

      if (type === "OVERLAY_HTML" || type === "TP_TRANSLATION_BIND") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: false, error: "overlay unavailable" });
      }

      if (type === "TP_FETCH_IMAGE") {
        const fail=error=>{
          if(msg?.diagnosticId)TP.scanDiag?.emit('content.blob_fetch_result', {
            ok:false,error:TP.scanDiag.error(error),pageId:String(msg?.pageId || ''),
            pageIndex:Number(msg?.pageIndex ?? -1)},msg.diagnosticId);
          return sendResponse({ok:false,error:String(error)});
        };
        try {
          const url = String(msg?.url || "").trim();
          if(msg?.diagnosticId) TP.scanDiag?.emit('content.blob_fetch_start', {
            source:TP.scanDiag.describeSource(url,msg.diagnosticId),
            pageId:String(msg?.pageId || ''),pageIndex:Number(msg?.pageIndex ?? -1)},msg.diagnosticId);
          if (!url) return fail('no url');
          const res = await fetch(url, {
            credentials: "include",
            redirect: "follow",
          });
          if (!res.ok) return fail(`HTTP ${res.status}`);
          const mime = String(res.headers.get("content-type") || "")
            .split(";")[0]
            .trim();
          if (mime && !mime.toLowerCase().startsWith("image/")) return fail(`Not an image: ${mime}`);
          const ab = await res.arrayBuffer();
          const bytes = new Uint8Array(ab);
          if (bytes.length < 64) return fail('Image too small');
          if (bytes.length > 25 * 1024 * 1024) {
            return fail('Image too large');
          }
          if(msg?.diagnosticId) TP.scanDiag?.emit('content.blob_fetch_result', {
            ok:true,bytes:bytes.length,mime:/^image\/[a-z0-9.+-]{1,30}$/i.test(mime)?mime:'unknown',
            pageId:String(msg?.pageId || ''),pageIndex:Number(msg?.pageIndex ?? -1)},msg.diagnosticId);
          let bin = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK)
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          return sendResponse({
            ok: true,
            dataUri: `data:${mime || "image/jpeg"};base64,${btoa(bin)}`,
          });
        } catch (e) {
          return fail(e?.message || String(e));
        }
      }

      sendResponse({ ok: true, ignored: true });
    })().catch(error => {
      if(msg?.type==='GET_IMAGES' && msg?.diagnosticId){
        TP.scanDiag?.emit('content.scan_error',{error:TP.scanDiag.error(error)},msg.diagnosticId);
        TP.scanDiag?.snapshot('after_error',msg.diagnosticId);
        TP.scanDiag?.followup(msg.diagnosticId);
      }
      TP.log.warn("content request failed", {type:msg?.type,error:error?.message || String(error)});
      sendResponse({ok:false,error:error?.message || String(error),code:error?.code || ""});
    });
    return true;
  });
})();
