/**
 * Building job payloads from image elements.
 *
 * A payload is what the service worker forwards to the API: the source URL (or
 * an inlined data URI), the mode/language, and metadata (image id, on-page
 * position, a pipeline trail for debugging).
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  /** Build a payload from raw fields. */
  function buildPayload({ original_image_url, position, imageDataUri }, mode, lang, menuSource = "page_scan", customStage) {
    const payload = {
      mode,
      lang,
      type: "image",
      src: original_image_url || null,
      imageDataUri: imageDataUri || null,
      menu: menuSource,
      context: {
        page_url: location.href,
        timestamp: new Date().toISOString(),
      },
      metadata: {
        image_id: crypto.randomUUID(),
        original_image_url: original_image_url || null,
        position,
        pipeline: [TP.buildPipelineEvent(customStage || "collected")],
        ocr_image: null,
        extra: null,
      },
    };
    TP.log.debug("built payload", {
      src: TP.truncate(original_image_url),
      hasData: Boolean(imageDataUri),
      menu: menuSource,
      mode,
      lang,
    });
    return payload;
  }

  /**
   * Get a data URI for an image element: its own `src` if already inline, else
   * draw it to a canvas, else fetch the bytes.
   */
  async function getImageDataUriFromElement(img) {
    const src = TP.normUrl(TP.getBestImgUrl(img));
    if (!src) return "";
    if (src.startsWith("data:")) return src;

    // Try canvas (works for same-origin / CORS-clean images).
    try {
      const w = Number(img?.naturalWidth) || Number(img?.width) || 0;
      const h = Number(img?.naturalHeight) || Number(img?.height) || 0;
      if (w > 0 && h > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: false });
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const du = canvas.toDataURL("image/png");
          if (du && du.startsWith("data:image/")) return du;
        }
      }
    } catch {
      /* tainted canvas — fall through */
    }

    // Fall back to fetching the bytes.
    try {
      const res = await fetch(src, { cache: "force-cache" });
      const du = await TP.blobToDataUri(await res.blob());
      if (du) return du;
    } catch {
      /* cross-origin / network error */
    }
    return "";
  }

  /**
   * Build a payload from an `<img>` element.
   * @param {boolean} includeDataUri - inline the bytes for blob/data/file URLs
   */
  async function buildPayloadFromImage(img, mode, lang, menuSource = "page_scan", customStage, includeDataUri = false) {
    const src = TP.normUrl(TP.getBestImgUrl(img));
    const imageDataUri =
      includeDataUri && TP.isInlineableImageUrl(src) ? await getImageDataUriFromElement(img) : "";
    if (!src && !imageDataUri) return null;
    return buildPayload(
      {
        original_image_url: src || null,
        position: TP.buildPositionFromElement(img),
        imageDataUri: imageDataUri || null,
      },
      mode,
      lang,
      menuSource,
      customStage,
    );
  }



  // --- Page-scan image filtering -----------------------------------------
  // These rules keep icons / avatars / tracking pixels / placeholders out of
  // bulk translation runs.  Skipped candidates are not errors: they were never
  // eligible translation jobs.
  //
  // IMPORTANT: both regexes are word/token-bounded and are tested ONLY
  // against the URL (SKIP_URL_RE) or class/id/role (SKIP_CLASS_RE) — never
  // against alt/title.  Manga page images carry the series title in alt text,
  // and substring matching used to skip whole galleries (e.g. alt containing
  // "Hegemonicon" matched `icon`, "Karada" matched `ads?`, and any URL with
  // "download"/"uploads" matched `ad`).
  const SKIP_URL_RE =
    /\b(?:favicon|sprites?|icons?|logos?|avatars?|emojis?|badges?|buttons?|spinner|loaders?|placeholder|blank|pixel|tracking|analytics|ads?|adverts?|banners?|doubleclick|googletag|gravatar)\b/i;
  const SKIP_CLASS_RE =
    /(?:^|[\s_-])(?:avatars?|icons?|logos?|emojis?|badges?|buttons?|spinner|loaders?|placeholder|ads?|lazy-placeholder|profile|thumbnails?|thumb)(?:$|[\s_-])/i;
  const BAD_EXT_RE = /\.(?:svg|ico)(?:[?#].*)?$/i;

  function scanMinSizeForMode(mode) {
    // Text overlay modes need larger images than lens_images because tiny UI
    // thumbnails rarely contain useful readable text and often cause false
    // errors later.
    return String(mode || "") === "lens_text"
      ? { minSide: 140, minArea: 80_000 }
      : { minSide: 120, minArea: 60_000 };
  }

  function imageSkipReason(img, mode = "") {
    if (!img || !img.isConnected) return "detached";
    const srcRaw = TP.getBestImgUrl(img) || img.currentSrc || img.src || "";
    const src = TP.normUrl(srcRaw);
    // class/id/role only — alt/title are page CONTENT (series titles, page
    // numbers) and must never be matched against UI-asset keywords.
    const classText = [
      img.id || "",
      String(img.className || ""),
      img.getAttribute?.("role") || "",
      img.getAttribute?.("aria-label") || "",
    ].join(" ");

    if (!src && !img.getAttribute?.("data-src") && !img.getAttribute?.("data-original")) return "no_src";
    if (src && /^(?:chrome-extension:|moz-extension:|about:|javascript:)/i.test(src)) return "internal_url";
    if (src && BAD_EXT_RE.test(src)) return "vector_icon";
    if ((src && SKIP_URL_RE.test(src)) || SKIP_CLASS_RE.test(classText)) return "ui_asset";

    const r = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
    const cssW = Math.max(0, Number(r?.width) || Number(img.width) || Number(img.clientWidth) || 0);
    const cssH = Math.max(0, Number(r?.height) || Number(img.height) || Number(img.clientHeight) || 0);
    const natW = Math.max(0, Number(img.naturalWidth) || 0);
    const natH = Math.max(0, Number(img.naturalHeight) || 0);
    const w = Math.max(cssW, natW);
    const h = Math.max(cssH, natH);

    // Lazy-managed images (real URL parked in data-src) are page CONTENT the
    // browser simply hasn't fetched yet.  The background fetches image bytes
    // by URL itself, so "not loaded in the DOM" must not skip them — on
    // long-strip readers only the ~4 images near the viewport are loaded at
    // scan time and every other page used to be dropped here.
    const lazyManaged = Boolean(
      img.getAttribute?.("data-src") ||
        img.getAttribute?.("data-original") ||
        img.getAttribute?.("data-lazy-src"),
    );

    // Explicitly hidden / collapsed DOM images are usually templates or lazy
    // sentinels.  If natural size is also missing, skip them.
    if ((cssW <= 1 || cssH <= 1) && (!natW || !natH) && !lazyManaged) return "not_visible";

    const { minSide, minArea } = scanMinSizeForMode(mode);
    if (w && h) {
      if (Math.min(w, h) < minSide) return "too_small";
      if (w * h < minArea) return "too_small_area";
    }

    // Common transparent placeholders often have a valid large CSS box but no
    // loaded image bytes yet.  Do not send them as failed jobs — unless the
    // image is lazy-managed (see above): then the URL is real and fetchable.
    if (!img.complete && !natW && !natH && !src.startsWith("data:") && !lazyManaged)
      return "not_loaded";

    return "";
  }

  function rememberScanSkip(stats, reason) {
    if (!stats) return;
    const key = reason || "unknown";
    stats.skipped++;
    stats.reasons[key] = (stats.reasons[key] || 0) + 1;
  }

  /** Collect translate-worthy images on the page (skips tiny icons). */
  async function collectImagesForScan(mode, lang, sourceTag) {
    const seen = new Set();
    const out = [];
    const stats = { candidates: 0, accepted: 0, skipped: 0, duplicates: 0, reasons: {} };
    for (const img of Array.from(document.images || [])) {
      stats.candidates++;
      const reason = imageSkipReason(img, mode);
      if (reason) {
        rememberScanSkip(stats, reason);
        continue;
      }
      const payload = await buildPayloadFromImage(img, mode, lang, sourceTag);
      const key = TP.normUrl(payload?.src) || String(payload?.metadata?.image_id || "");
      if (!key) {
        rememberScanSkip(stats, "no_payload");
        continue;
      }
      if (seen.has(key)) {
        stats.duplicates++;
        continue;
      }
      seen.add(key);
      // Bind the job to this node the same way a right-click does: lazy-load
      // sites swap `src` back to a placeholder as the user scrolls, so by the
      // time a batch result arrives URL-based lookup fails. `data-tp-original`
      // lives on the element and survives any src churn, so findTargetImage()
      // can always locate the right <img> for the overlay.
      if (img?.dataset && !img.dataset.tpOriginal) img.dataset.tpOriginal = key;
      out.push(payload);
    }
    stats.accepted = out.length;
    TP.log.info("image scan filtered", stats);
    return { items: out.filter(Boolean), stats };
  }

  Object.assign(TP, {
    buildPayload,
    getImageDataUriFromElement,
    buildPayloadFromImage,
    imageSkipReason,
    collectImagesForScan,
  });
})();
