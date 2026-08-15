// Builds the job payloads the service worker forwards to the API.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Builds a payload from raw fields.
  function buildPayload({ original_image_url, position, imageDataUri, background, generation, naturalSize }, mode, lang, menuSource = "page_scan", customStage) {
    const payload = {
      mode,
      lang,
      type: "image",
      src: original_image_url || null,
      imageDataUri: imageDataUri || null,
      render: {
        background: background || "image",
        lensDocument: mode === "lens_text",
      },
      menu: menuSource,
      context: {
        page_url: location.href,
        timestamp: new Date().toISOString(),
      },
      generation: generation || null,
      naturalSize: naturalSize || null,
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

  const UPLOAD_DEFAULTS = { format: "webp", quality: 0.92 };
  const UPLOAD_FORMATS = new Set(["webp", "png", "jpeg"]);
  let uploadPrefsPromise = null;
  let encodeFallbackWarned = false;

  // Reads the upload format and quality from storage, once per page.
  function readUploadPrefs() {
    if (uploadPrefsPromise) return uploadPrefsPromise;
    uploadPrefsPromise = new Promise((resolve) => {
      try {
        chrome.storage.local.get(["uploadFormat", "uploadQuality"], (it) => {
          void chrome.runtime.lastError;
          const fmt = String(it?.uploadFormat || "").trim().toLowerCase();
          const q = Number(it?.uploadQuality);
          resolve({
            format: UPLOAD_FORMATS.has(fmt) ? fmt : UPLOAD_DEFAULTS.format,
            quality: Number.isFinite(q) && q > 0 && q <= 1 ? q : UPLOAD_DEFAULTS.quality,
          });
        });
      } catch (e) {
        TP.log.warn("upload prefs unreadable; using defaults", {
          error: e?.message || String(e),
          ...UPLOAD_DEFAULTS,
        });
        resolve({ ...UPLOAD_DEFAULTS });
      }
    });
    return uploadPrefsPromise;
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && ("uploadFormat" in changes || "uploadQuality" in changes))
        uploadPrefsPromise = null;
    });
  } catch {
  }

  // Encodes a canvas, reporting when the browser could not honour the format.
  function encodeCanvas(canvas, prefs) {
    if (prefs.format === "png") return canvas.toDataURL("image/png");
    const mime = `image/${prefs.format}`;
    const du = canvas.toDataURL(mime, prefs.quality);
    if (du && !du.startsWith(`data:${mime}`) && !encodeFallbackWarned) {
      encodeFallbackWarned = true;
      TP.log.warn("canvas cannot encode requested format; browser produced PNG instead", {
        requested: mime,
        got: du.slice(5, du.indexOf(";")),
      });
    }
    return du;
  }

  // Returns a data URI for an image element via its src, a canvas draw, or a fetch.
  async function getImageDataUriFromElement(img) {
    const src = TP.normUrl(TP.getBestImgUrl(img));
    if (!src) return "";
    if (src.startsWith("data:")) return src;

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
          const du = encodeCanvas(canvas, await readUploadPrefs());
          if (du && du.startsWith("data:image/")) return du;
        }
      }
    } catch {
    }

    try {
      const res = await fetch(src, { cache: "force-cache" });
      const du = await TP.blobToDataUri(await res.blob());
      if (du) return du;
    } catch {
    }
    return "";
  }

  TP.localRenderEnabled = false;
  TP.clientBackgroundEnabled = true;
  try {
    chrome.storage.local.get(["localRender"], (it) => {
      void chrome.runtime.lastError;
      TP.localRenderEnabled = it?.localRender === true;
      TP.clientBackgroundEnabled = true;
      if (TP.localRenderEnabled) TP.log.info("local overlay rendering is ON");
      if (TP.clientBackgroundEnabled) TP.log.info("client-painted background is ON");
    });
  } catch {
  }

  // Returns "boxes" when this page will paint the erased background itself, else "image".
  function chooseBackgroundMode(img, mode) {
    if (String(mode || "") !== "lens_text") return "image";
    if (TP.clientBackgroundEnabled !== true) return "image";
    if (!TP.buildErasedBackground) return "image";
    return "boxes";
  }

  // Builds a payload from an image element, optionally inlining its bytes.
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
        background: chooseBackgroundMode(img, mode),
        generation: TP.generationFor ? TP.generationFor(img) : null,
        naturalSize: {
          width: Number(img?.naturalWidth) || 0,
          height: Number(img?.naturalHeight) || 0,
        },
      },
      mode,
      lang,
      menuSource,
      customStage,
    );
  }



  const SKIP_URL_RE =
    /\b(?:favicon|sprites?|icons?|logos?|avatars?|emojis?|badges?|buttons?|spinner|loaders?|placeholder|blank|pixel|tracking|analytics|ads?|adverts?|banners?|doubleclick|googletag|gravatar)\b/i;
  const SKIP_CLASS_RE =
    /(?:^|[\s_-])(?:avatars?|icons?|logos?|emojis?|badges?|buttons?|spinner|loaders?|placeholder|ads?|lazy-placeholder|profile|thumbnails?|thumb)(?:$|[\s_-])/i;
  const REACTION_ASSET_RE =
    /(?:^|[-_.])(?:upvote|downvote|reaction|funny|angry|sad|surprised)(?:[-_.]|$)/i;
  const BAD_EXT_RE = /\.(?:svg|ico)(?:[?#].*)?$/i;

  function isReactionAssetUrl(src) {
    try {
      const url = new URL(src, location.href);
      const pathname = url.pathname.toLowerCase();
      if (!/(?:^|\/)static\/(?:img|images)\//.test(pathname)) return false;
      return REACTION_ASSET_RE.test(pathname.split("/").pop() || "");
    } catch {
      return false;
    }
  }

  function scanMinSizeForMode(mode) {
    return String(mode || "") === "lens_text"
      ? { minSide: 140, minArea: 80_000 }
      : { minSide: 120, minArea: 60_000 };
  }

  // Returns why an image is not a translation candidate, or "" when it is one.
  function imageSkipReason(img, mode = "") {
    if (!img || !img.isConnected) return "detached";
    const srcRaw = TP.getBestImgUrl(img) || img.currentSrc || img.src || "";
    const src = TP.normUrl(srcRaw);
    const classText = [
      img.id || "",
      String(img.className || ""),
      img.getAttribute?.("role") || "",
      img.getAttribute?.("aria-label") || "",
    ].join(" ");

    if (!src && !img.getAttribute?.("data-src") && !img.getAttribute?.("data-original")) return "no_src";
    if (src && /^(?:chrome-extension:|moz-extension:|about:|javascript:)/i.test(src)) return "internal_url";
    if (src && BAD_EXT_RE.test(src)) return "vector_icon";
    if (
      (src && (SKIP_URL_RE.test(src) || isReactionAssetUrl(src))) ||
      SKIP_CLASS_RE.test(classText)
    ) return "ui_asset";

    const r = typeof img.getBoundingClientRect === "function" ? img.getBoundingClientRect() : null;
    const cssW = Math.max(0, Number(r?.width) || Number(img.width) || Number(img.clientWidth) || 0);
    const cssH = Math.max(0, Number(r?.height) || Number(img.height) || Number(img.clientHeight) || 0);
    const natW = Math.max(0, Number(img.naturalWidth) || 0);
    const natH = Math.max(0, Number(img.naturalHeight) || 0);
    const w = Math.max(cssW, natW);
    const h = Math.max(cssH, natH);

    const lazyManaged = Boolean(
      img.getAttribute?.("data-src") ||
        img.getAttribute?.("data-original") ||
        img.getAttribute?.("data-lazy-src"),
    );

    if ((cssW <= 1 || cssH <= 1) && (!natW || !natH) && !lazyManaged) return "not_visible";

    const { minSide, minArea } = scanMinSizeForMode(mode);
    if (w && h) {
      if (Math.min(w, h) < minSide) return "too_small";
      if (w * h < minArea) return "too_small_area";
    }

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

  // Collects payloads for every translate-worthy image on the page.
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
