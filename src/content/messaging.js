/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * The content script's `chrome.runtime.onMessage` router.
 *
 * Handles control messages (ping / keep-alive / toast) and the four real
 * commands from the service worker:
 * - GET_IMAGES                       → list translate-worthy images
 * - GET_CONTEXT_IMAGE_PAYLOAD        → payload for the right-clicked image
 * - REPLACE_IMAGE                    → swap an image's source
 * - OVERLAY_HTML                     → apply an HTML overlay
 * plus RESOLVE_AND_REPLACE_MANGADEX_BLOB and IMAGE_ERROR.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  /** Collect images for a GET_IMAGES request (with the MangaDex fast path). */
  async function collectImages(mode, lang) {
    TP.removeLazyScriptsAndForceSrc();
    TP.normalizeLazyImages();

    if (!TP.isMangaDexHost()) {
      return TP.collectImagesForScan(mode, lang, "page_scan");
    }

    // MangaDex: prefer the chapter's at-home URL list, skip already-cached pages.
    TP.showToast("TextPhantom: loading MangaDex pages…", 2600);

    // Dedicated site adapter (content/site-mangadex.js): exact alt-filename
    // mapping + image bytes fetched via the site's own API in the page
    // context. Falls through to the legacy path if the adapter is missing
    // or returns nothing.
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

    // Positions of any page images currently in the DOM (for nicer metadata).
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

      // --- Control messages (no settings needed) --------------------------
      if (type === "TP_PING") return sendResponse({ ok: true });
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
      if (type === "WS_STATUS_UPDATE" || type === "API_STATUS_UPDATE") {
        return sendResponse({ ok: true });
      }
      if (type === "TP_BULK_INSERT") {
        const r = await TP.applyInsertBatch?.(msg?.items || [], { chunkSize: msg?.chunkSize });
        return sendResponse(r || { ok: false, bulk: true, error: "bulk insert unavailable" });
      }

      const { mode, lang } = await TP.getSettings();

      // --- GET_IMAGES -----------------------------------------------------
      if (type === "GET_IMAGES") {
        const resp = await collectImages(mode, lang);
        const items = Array.isArray(resp) ? resp : Array.isArray(resp?.items) ? resp.items : [];
        const stats = Array.isArray(resp) ? null : resp?.stats || null;
        TP.log.info("GET_IMAGES", { returned: items.length, skipped: stats?.skipped || 0, host: location.host });
        return sendResponse({ ok: true, items, stats });
      }

      // --- GET_CONTEXT_IMAGE_PAYLOAD --------------------------------------
      if (type === "GET_CONTEXT_IMAGE_PAYLOAD") {
        const lrc = TP.getLastRightClick();
        const img = lrc.img && lrc.img.isConnected ? lrc.img : null;
        const payload = img
          ? await TP.buildPayloadFromImage(img, mode, lang, "img_one", "context_menu_single", true)
          : null;
        return sendResponse({ ok: Boolean(payload), payload });
      }

      // --- REPLACE_IMAGE --------------------------------------------------
      if (type === "REPLACE_IMAGE") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: false, error: "replace unavailable" });
      }

      // --- RESOLVE_AND_REPLACE_MANGADEX_BLOB ------------------------------
      if (type === "RESOLVE_AND_REPLACE_MANGADEX_BLOB") {
        const resolved = await TP.resolveMangaDexOriginalForBlob(msg.blobUrl);
        return sendResponse({ resolved });
      }

      // --- IMAGE_ERROR ----------------------------------------------------
      if (type === "IMAGE_ERROR") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: true });
      }

      // --- OVERLAY_HTML ---------------------------------------------------
      if (type === "OVERLAY_HTML") {
        const r = await TP.applyInsertMessage?.(msg);
        return sendResponse(r || { ok: false, error: "overlay unavailable" });
      }

      // --- TP_FETCH_IMAGE (CDN 403 fallback) ---------------------------------
      // SW fetch fails with 403 on hotlink-protected CDNs because its Origin
      // is chrome-extension://... . Content scripts run in the page origin so
      // the CDN sees the correct Referer + cookies and allows the request.
      if (type === "TP_FETCH_IMAGE") {
        try {
          const url = String(msg?.url || "").trim();
          if (!url) return sendResponse({ ok: false, error: "no url" });
          const res = await fetch(url, { credentials: "include", redirect: "follow" });
          if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
          const mime =
            String(res.headers.get("content-type") || "").split(";")[0].trim() || "image/jpeg";
          const ab = await res.arrayBuffer();
          const bytes = new Uint8Array(ab);
          if (bytes.length < 64) return sendResponse({ ok: false, error: "response too small" });
          // base64-encode in 32 KB chunks to avoid call-stack overflow
          let bin = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK)
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          return sendResponse({ ok: true, dataUri: `data:${mime};base64,${btoa(bin)}` });
        } catch (e) {
          return sendResponse({ ok: false, error: e?.message || String(e) });
        }
      }

      sendResponse({ ok: true, ignored: true });
    })();
    return true; // keep the message channel open for the async response
  });
})();
