// Routes runtime messages from the service worker to the content-script handlers.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Collects the payloads for a GET_IMAGES request, including the MangaDex path.
  async function collectImages(mode, lang) {
    TP.removeLazyScriptsAndForceSrc();
    TP.normalizeLazyImages();

    if (!TP.isMangaDexHost()) {
      return TP.collectImagesForScan(mode, lang, "page_scan");
    }

    TP.showToast("TextPhantom: loading MangaDex pages…", 2600);

    if (typeof TP.mdSiteCollect === "function") {
      const viaAdapter = await TP.mdSiteCollect(mode, lang).catch(() => null);
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

    const urls = (await TP.fetchMangaDexChapterUrls())?.urls || [];
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
      stats: { candidates: urls.length + posBySrc.size, accepted: items.length, skipped: 0, duplicates: 0, reasons: {} },
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      const type = String(msg?.type || "");

      if (type === "TP_PING") return sendResponse({ ok: true });
      if (type === "TP_DIAGNOSTICS_STATE") {
        const detail = msg?.detail === "full" ? "full" : msg?.enabled ? "compact" : "off";
        TP.setLogLevel?.(msg?.consoleLevel || "warn");
        TP.setTracingEnabled?.(Boolean(msg?.enabled), detail);
        const wrapped = detail === "full" ? (TP.installTrace?.() || 0) : 0;
        return sendResponse({ ok: true, detail, consoleLevel: TP.getLogLevel?.() || "warn", wrapped });
      }
      if (type === "TP_KEEPALIVE_START") {
        TP.keepAlive.start(msg?.ms);
        return sendResponse({ ok: true });
      }
      if (type === "TP_KEEPALIVE_STOP") {
        TP.keepAlive.stop();
        return sendResponse({ ok: true });
      }
      if (type === "TP_TOAST") {
        TP.showToast(msg?.text || msg?.message || "", msg?.ms || 1600);
        return sendResponse({ ok: true });
      }
      if (type === "API_STATUS_UPDATE") {
        return sendResponse({ ok: true });
      }
      if (type === "TP_BULK_INSERT") {
        const r = await TP.applyInsertBatch?.(msg?.items || [], { chunkSize: msg?.chunkSize });
        return sendResponse(r || { ok: false, bulk: true, error: "bulk insert unavailable" });
      }

      const { mode, lang } = await TP.getSettings();

      if (type === "GET_IMAGES") {
        const resp = await collectImages(mode, lang);
        const items = Array.isArray(resp) ? resp : Array.isArray(resp?.items) ? resp.items : [];
        const stats = Array.isArray(resp) ? null : resp?.stats || null;
        TP.log.info("GET_IMAGES", { returned: items.length, skipped: stats?.skipped || 0, host: location.host });
        return sendResponse({ ok: true, items, stats });
      }

      if (type === "GET_CONTEXT_IMAGE_PAYLOAD") {
        const img = TP.getFreshRightClickImageForTarget?.({
          srcUrl: msg?.srcUrl,
          clickedSrcUrl: msg?.clickedSrcUrl,
        });
        const payload = img
          ? await TP.buildPayloadFromImage(img, mode, lang, "img_one", "context_menu_single", true)
          : null;
        return sendResponse({ ok: Boolean(payload), payload });
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

      if (type === "OVERLAY_HTML") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: false, error: "overlay unavailable" });
      }

      if (type === "TP_FETCH_IMAGE") {
        try {
          const url = String(msg?.url || "").trim();
          if (!url) return sendResponse({ ok: false, error: "no url" });
          const res = await fetch(url, { credentials: "include", redirect: "follow" });
          if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
          const mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
          if (mime && !mime.toLowerCase().startsWith("image/")) {
            return sendResponse({ ok: false, error: `Not an image: ${mime}` });
          }
          const ab = await res.arrayBuffer();
          const bytes = new Uint8Array(ab);
          if (bytes.length < 64) return sendResponse({ ok: false, error: "Image too small" });
          if (bytes.length > 25 * 1024 * 1024) {
            return sendResponse({ ok: false, error: "Image too large" });
          }
          let bin = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK)
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          return sendResponse({ ok: true, dataUri: `data:${mime || "image/jpeg"};base64,${btoa(bin)}` });
        } catch (e) {
          return sendResponse({ ok: false, error: e?.message || String(e) });
        }
      }

      sendResponse({ ok: true, ignored: true });
    })();
    return true;
  });
})();
