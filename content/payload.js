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

  /** Collect translate-worthy images on the page (skips tiny icons). */
  async function collectImagesForScan(mode, lang, sourceTag) {
    const seen = new Set();
    const out = [];
    for (const img of Array.from(document.images || [])) {
      const r = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
      const w = Math.max(Number(r?.width) || 0, Number(img.naturalWidth) || 0);
      const h = Math.max(Number(r?.height) || 0, Number(img.naturalHeight) || 0);
      if (w && h) {
        if (Math.min(w, h) < 120) continue; // too small to hold meaningful text
        if (w * h < 60000) continue;
      }
      const payload = await buildPayloadFromImage(img, mode, lang, sourceTag);
      const key = TP.normUrl(payload?.src) || String(payload?.metadata?.image_id || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(payload);
    }
    return out.filter(Boolean);
  }

  Object.assign(TP, {
    buildPayload,
    getImageDataUriFromElement,
    buildPayloadFromImage,
    collectImagesForScan,
  });
})();
