/**
 * HTML-overlay rendering + in-DOM image replacement.
 *
 * An "overlay" is an absolutely-positioned host element kept aligned over the
 * target image. Its `.tp-ol-scope` holds the API's overlay markup, scaled so
 * the (image-space) markup lines up with the (rendered) image. A "clean layer"
 * `<img>` underneath shows the text-erased background for text mode.
 *
 * MangaDex uses a parallel set of overlay maps (see `mangadex.js`); this module
 * exposes the generic machinery and routes to the MangaDex variant when the
 * target image carries an `md:` key.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const OVERLAY_STYLE_ID = "textphantom_overlay_css";

  // key -> { host, scope, img, baseW, baseH, kind, ro, cleanImg }
  const htmlOverlaysByKey = new Map();
  let htmlOverlayRaf = 0;

  // --- User font-scale (popup +/- buttons) --------------------------------
  //
  // The popup writes a single `fontScale` number (1.0 = 100%) to storage and
  // broadcasts `FONT_SCALE_CHANGED`. We mirror that into the CSS variable
  // `--tp-font-scale` on every `.tp-ol-scope`; every `.tp-line` inside reads
  // it through `font-size: calc(var(--tp-font-scale,1) * Npx)` and resizes
  // immediately — no DOM walking, no relayout of the host element.
  const FONT_SCALE_MIN = 0.5;
  const FONT_SCALE_MAX = 2.0;
  let currentFontScale = 1;

  /**
   * Clamp any input to a finite scale in [MIN, MAX]. Falls back to 1 for
   * garbage values so a corrupt storage entry can't break the overlay.
   */
  function clampFontScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  }

  /** Push the current scale onto a single scope element. */
  function applyFontScaleToScope(scope) {
    if (!scope) return;
    scope.style.setProperty("--tp-font-scale", String(currentFontScale));
  }

  /** Re-apply the scale to every overlay this content script knows about. */
  function applyFontScaleEverywhere() {
    for (const rec of htmlOverlaysByKey.values()) {
      if (rec?.scope) applyFontScaleToScope(rec.scope);
    }
    // MangaDex maintains its own overlay map; let it apply the same scale.
    try {
      TP.mdApplyFontScaleAll?.(currentFontScale);
    } catch {
      /* MangaDex overlay map absent on non-MangaDex hosts */
    }
  }

  /** Read the saved scale from storage and broadcast to all scopes. */
  async function loadAndApplyFontScale() {
    try {
      const r = await chrome.storage.local.get("fontScale");
      currentFontScale = clampFontScale(r?.fontScale ?? 1);
    } catch {
      currentFontScale = 1;
    }
    applyFontScaleEverywhere();
  }

  loadAndApplyFontScale();

  // Live updates: popup writes `fontScale` -> storage event fires here.
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes?.fontScale) return;
      currentFontScale = clampFontScale(changes.fontScale.newValue);
      applyFontScaleEverywhere();
    });
  } catch {
    /* storage.onChanged unavailable in this context */
  }

  // Some popups also broadcast a message so the change feels instant even
  // when storage events are throttled.
  try {
    chrome.runtime.onMessage?.addListener((msg) => {
      if (msg?.type === "FONT_SCALE_CHANGED") {
        currentFontScale = clampFontScale(msg.fontScale);
        applyFontScaleEverywhere();
      }
    });
  } catch {
    /* runtime.onMessage unavailable */
  }

  // --- Style injection -----------------------------------------------------

  /** Inject (once) the API-provided overlay CSS plus our hardening rules. */
  function ensureOverlayStyle(cssText = "") {
    let styleEl = document.getElementById(OVERLAY_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = OVERLAY_STYLE_ID;
      styleEl.type = "text/css";
      document.head.appendChild(styleEl);
    }
    // Hardening: pages have aggressive resets; force the overlay to stay put.
    const harden =
      "\n/* TextPhantom harden */\n" +
      ".tp-ol-root{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;transform-origin:0 0!important;}" +
      ".tp-ol-scope{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;}" +
      ".tp-ol-scope *{box-sizing:border-box!important;pointer-events:none!important;}" +
      ".tp-ol-container{position:relative!important;display:inline-block!important;line-height:0!important;overflow:visible!important;}";
    const next = String(cssText) + harden;
    if (styleEl.textContent !== next) styleEl.textContent = next;
  }

  // --- Small builders ------------------------------------------------------

  /** A small status badge ("AI…", "No text", …). */
  function createOverlayBadge(label) {
    const badge = document.createElement("div");
    badge.textContent = label || "AI…";
    Object.assign(badge.style, {
      position: "absolute",
      left: "6px",
      top: "6px",
      padding: "4px 6px",
      borderRadius: "6px",
      background: "rgba(255,255,255,.75)",
      color: "rgba(20,20,20,.95)",
      fontFamily: "var(--tp-font,system-ui)",
      fontSize: "12px",
      lineHeight: "1.2",
      textShadow: "0 0 2px rgba(255,255,255,.90),0 1px 1px rgba(0,0,0,.25)",
    });
    return badge;
  }

  /** Pull a replacement-image URL from a result. */
  function extractNewImageSrc(result) {
    return (
      result?.imageDataUri ||
      result?.image ||
      result?.imageUrl ||
      result?.image_url ||
      result?.imageURL ||
      null
    );
  }

  /** Convert a data URI to a blob: URL (cheaper for the DOM to keep around). */
  async function dataUriToBlobUrl(dataUri) {
    try {
      const blob = await (await fetch(dataUri)).blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  // --- "Clean layer" (text-erased background) ------------------------------

  function ensureCleanLayer(rec) {
    if (rec?.cleanImg && rec.cleanImg.isConnected) return rec.cleanImg;
    if (!rec?.host) return null;
    const img = document.createElement("img");
    img.className = "tp-ol-clean-img";
    img.decoding = "sync";
    img.loading = "eager";
    Object.assign(img.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      maxWidth: "none",
      maxHeight: "none",
      objectFit: "contain",
      objectPosition: "center center",
      display: "none",
    });
    if (rec.host.firstChild) rec.host.insertBefore(img, rec.host.firstChild);
    else rec.host.appendChild(img);
    rec.cleanImg = img;
    return img;
  }

  function syncCleanLayerFit(cleanImg, imgElement) {
    try {
      const cs = getComputedStyle(imgElement);
      if (cs?.objectFit) cleanImg.style.objectFit = cs.objectFit;
      if (cs?.objectPosition) cleanImg.style.objectPosition = cs.objectPosition;
    } catch {
      /* element gone */
    }
  }

  function updateCleanLayer(rec, imgElement, newSrc) {
    if (!rec?.host || !imgElement) return;
    const layer = ensureCleanLayer(rec);
    if (!layer) return;
    if (!newSrc) {
      layer.style.display = "none";
      return;
    }
    syncCleanLayerFit(layer, imgElement);
    if (layer.src !== newSrc) layer.src = newSrc;
    layer.style.display = "block";
  }

  // --- Overlay host positioning -------------------------------------------

  /** Mount the overlay host as the previous sibling of its image. */
  function ensureOverlayHostMountedNearImage(rec, img) {
    const host = rec?.host;
    if (!host || !img?.isConnected) return null;
    const parent = img.parentElement;
    if (!parent) return null;

    if (host.parentElement !== parent || host.nextSibling !== img) {
      try {
        host.parentElement?.removeChild(host);
      } catch {
        /* not mounted */
      }
      try {
        parent.insertBefore(host, img);
      } catch {
        try {
          parent.appendChild(host);
        } catch {
          /* parent gone */
        }
      }
    }
    try {
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    } catch {
      /* ignore */
    }
    return host.parentElement === parent ? parent : null;
  }

  /** The image's box relative to a (positioned) parent. */
  function getOverlayBoxFromParent(img, parent) {
    const r = img.getBoundingClientRect();
    if (!parent) return { r, left: 0, top: 0 };
    const pr = parent.getBoundingClientRect();
    return {
      r,
      left: r.left - pr.left + (parent.scrollLeft || 0),
      top: r.top - pr.top + (parent.scrollTop || 0),
    };
  }

  /** Re-position every tracked overlay (called from rAF). */
  function updateHtmlOverlays() {
    if (!htmlOverlaysByKey.size) return;
    for (const [key, rec] of htmlOverlaysByKey.entries()) {
      const { host, scope } = rec || {};
      if (!host || !scope) {
        htmlOverlaysByKey.delete(key);
        continue;
      }

      let img = rec.img;
      if (!img || !img.isConnected) img = TP.findTargetImage(key);
      if (!img) {
        host.style.display = "none";
        rec.img = null;
        continue;
      }

      const curKey = TP.normUrl(TP.getBestImgUrl(img));
      if (curKey && curKey !== key) {
        host.style.display = "none";
        rec.img = null;
        continue;
      }

      if (img !== rec.img) {
        if (img?.dataset) img.dataset.tpOriginal = key;
      }
      rec.ro?.disconnect?.();
      rec.ro = new ResizeObserver(() => scheduleHtmlOverlayUpdate());
      rec.ro.observe(img);

      const parent = ensureOverlayHostMountedNearImage(rec, img);
      if (!parent) {
        host.style.display = "none";
        rec.img = img;
        continue;
      }

      const { r, left, top } = getOverlayBoxFromParent(img, parent);
      if (r.width < 2 || r.height < 2) {
        host.style.display = "none";
        rec.img = img;
        continue;
      }

      rec.img = img;
      host.style.display = "block";
      host.style.setProperty("left", `${left}px`, "important");
      host.style.setProperty("top", `${top}px`, "important");
      host.style.setProperty("width", `${r.width}px`, "important");
      host.style.setProperty("height", `${r.height}px`, "important");

      if (rec.kind === "badge") {
        scope.style.width = `${r.width}px`;
        scope.style.height = `${r.height}px`;
        scope.style.transform = "";
        scope.style.transformOrigin = "0 0";
        host.style.transform = "";
        host.style.transformOrigin = "";
        continue;
      }

      const { nw, nh, sx, sy, offX, offY } = TP.computeScale(img, rec.baseW, rec.baseH, true);
      scope.style.width = `${nw}px`;
      scope.style.height = `${nh}px`;
      scope.style.transform = `translate(${offX}px, ${offY}px) scale(${sx}, ${sy})`;
      scope.style.transformOrigin = "0 0";
      host.style.transform = "";
      host.style.transformOrigin = "";
    }
  }

  function scheduleHtmlOverlayUpdate() {
    if (htmlOverlayRaf) return;
    htmlOverlayRaf = requestAnimationFrame(() => {
      htmlOverlayRaf = 0;
      updateHtmlOverlays();
    });
  }

  /** Install scroll/resize/mutation listeners that keep overlays aligned. */
  function ensureHtmlOverlayListeners() {
    if (window.__tpHtmlOverlayListeners) return;
    window.__tpHtmlOverlayListeners = true;
    window.addEventListener("scroll", scheduleHtmlOverlayUpdate, { passive: true, capture: true });
    window.addEventListener("resize", scheduleHtmlOverlayUpdate, { passive: true });
    try {
      new MutationObserver(() => scheduleHtmlOverlayUpdate()).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "data-srcset", "style", "class"],
      });
    } catch {
      /* MutationObserver unsupported */
    }
  }

  /** Get or create the overlay record for a (non-MangaDex) image key. */
  function upsertHtmlOverlay(key, img, baseW, baseH, kind) {
    let rec = htmlOverlaysByKey.get(key);
    if (!rec) {
      const host = document.createElement("div");
      host.className = "tp-ol-root";
      Object.assign(host.style, {
        position: "absolute",
        left: "0px",
        top: "0px",
        zIndex: 2147483647,
        pointerEvents: "none",
        display: "none",
      });
      const scope = document.createElement("div");
      scope.className = "tp-ol-scope";
      scope.style.position = "relative";
      applyFontScaleToScope(scope);  // seed --tp-font-scale before mount
      host.appendChild(scope);
      rec = { host, scope, img: null, baseW: 1, baseH: 1, kind: "html", ro: null };
      htmlOverlaysByKey.set(key, rec);
      ensureHtmlOverlayListeners();
    }

    if (img) ensureOverlayHostMountedNearImage(rec, img);
    rec.img = img;
    rec.baseW = Number.isFinite(baseW) && baseW > 0 ? baseW : 1;
    rec.baseH = Number.isFinite(baseH) && baseH > 0 ? baseH : 1;
    rec.kind = kind || "html";
    if (img?.dataset && !img.dataset.tpOriginal) img.dataset.tpOriginal = key;
    rec.ro?.disconnect?.();
    rec.ro = new ResizeObserver(() => scheduleHtmlOverlayUpdate());
    rec.ro.observe(img);
    return rec;
  }

  function hideHtmlOverlay(key) {
    const rec = htmlOverlaysByKey.get(key);
    if (rec?.cleanImg) rec.cleanImg.style.display = "none";
    if (rec?.host) rec.host.style.display = "none";
  }

  // --- The main overlay applier -------------------------------------------

  /** Strip TP paragraph markers that should never reach the DOM. */
  const cleanOverlayHtml = (html) =>
    String(html || "")
      .replace(/<<TP_P\d+>>/g, "")
      .replace(/<<TP_P/g, "");

  /** Replace a scope's children with parsed overlay markup. */
  function fillScope(scope, html) {
    scope.textContent = "";
    const tmp = document.createElement("div");
    tmp.innerHTML = cleanOverlayHtml(html);
    while (tmp.firstChild) scope.appendChild(tmp.firstChild);
  }

  /** Kick a schedule + a couple of follow-up updates once the image loads. */
  function nudgeOverlay(imgElement, schedule) {
    schedule();
    if (!imgElement.complete) {
      imgElement.addEventListener("load", schedule, { once: true, passive: true });
    }
    setTimeout(schedule, 50);
  }

  /**
   * Apply a translation result to an image as an HTML overlay (and/or a clean
   * background layer). Routes to the MangaDex overlay set when applicable.
   */
  function applyHtmlOverlay(imgElement, result, source, isTextMode, original = "") {
    const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || "";
    const translatedHtml = result?.translated?.translatedhtml || result?.translatedhtml || "";
    const originalHtml = result?.original?.originalhtml || result?.originalhtml || "";

    const req = String(source || "").trim().toLowerCase();
    const chosen = req === "ai" || req === "original" ? req : "translated";
    const html = chosen === "ai" ? aiHtml : chosen === "original" ? originalHtml : translatedHtml;

    // CSS: the base overlay CSS, plus the AI-specific CSS when showing AI.
    const cssParts = [String(result?.htmlCss || "")];
    if (chosen === "ai") cssParts.push(String(result?.Ai?.aihtmlCss || result?.ai?.aihtmlCss || ""));
    const cssText = Array.from(
      new Set(cssParts.map((s) => s.trim()).filter(Boolean)),
    ).join("\n");

    const meta =
      chosen === "ai" ? result?.Ai?.aihtmlMeta || result?.ai?.aihtmlMeta || {} : result?.htmlMeta || {};
    const baseW = Number(meta.baseW || meta.sourceWidth) || imgElement.naturalWidth || imgElement.width || 1;
    const baseH =
      Number(meta.baseH || meta.sourceHeight) || imgElement.naturalHeight || imgElement.height || 1;
    const newImgSrc = isTextMode ? extractNewImageSrc(result) : null;

    ensureOverlayStyle(cssText);

    // Choose the generic vs. MangaDex overlay operations.
    const mdKey = TP.isMangaDexHost?.() ? TP.mdGetKeyForImg?.(imgElement) : "";
    const useMd = Boolean(mdKey);
    const ops = useMd
      ? {
          key: mdKey,
          upsert: (kind) => TP.upsertMangaDexHtmlOverlay(mdKey, imgElement, baseW, baseH, kind),
          schedule: () => TP.scheduleMangaDexOverlayUpdate(),
          hide: () => TP.hideMangaDexHtmlOverlay(mdKey),
        }
      : (() => {
          const key = TP.normUrl(original) || TP.normUrl(TP.getBestImgUrl(imgElement));
          return key
            ? {
                key,
                upsert: (kind) => upsertHtmlOverlay(key, imgElement, baseW, baseH, kind),
                schedule: scheduleHtmlOverlayUpdate,
                hide: () => hideHtmlOverlay(key),
              }
            : null;
        })();
    if (!ops) return;

    // Case 1: AI requested but produced no markup → show a status badge.
    if (isTextMode && req === "ai" && !aiHtml) {
      const rec = ops.upsert("badge");
      updateCleanLayer(rec, imgElement, newImgSrc);
      rec.scope.textContent = "";
      const aiMeta = result?.Ai?.meta || {};
      const reason = String(aiMeta.skipped_reason || aiMeta.reason || "").trim();
      const label = reason === "no_text" ? "No text" : reason === "rate_limited" ? "Rate limit" : "AI…";
      rec.scope.appendChild(createOverlayBadge(label));
      nudgeOverlay(imgElement, ops.schedule);
      return;
    }

    // Case 2: no markup at all.
    if (!html) {
      if (isTextMode && newImgSrc) {
        // We at least have a cleaned background image.
        const rec = ops.upsert("badge");
        updateCleanLayer(rec, imgElement, newImgSrc);
        rec.scope.textContent = "";
        nudgeOverlay(imgElement, ops.schedule);
        return;
      }
      ops.hide();
      return;
    }

    // Case 3: full HTML overlay.
    const rec = ops.upsert("html");
    updateCleanLayer(rec, imgElement, newImgSrc);
    fillScope(rec.scope, html);
    nudgeOverlay(imgElement, ops.schedule);

    if (!useMd) {
      TP.emitViewerEvent("textphantom:overlay-updated", {
        original,
        result,
        mode: isTextMode ? "lens_text" : "lens_images",
        source: req,
      });
    }
  }



  // --- Batched DOM insertion ----------------------------------------------

  function sleepFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function applyImageErrorMessage(msg) {
    const isNoOverlay = /no overlay data/i.test(String(msg?.message || ""));
    setTimeout(() => {
      if (TP.shouldShowReplaceError(msg?.original)) {
        TP.markImageError(msg?.original, isNoOverlay ? "No text detected" : msg?.message);
      }
    }, 1200);
    return { ok: true };
  }

  async function applyOverlayMessage(msg) {
    const ovMode = typeof msg?.mode === "string" ? msg.mode : "";
    if (!ovMode) return { ok: true, ignored: true };
    const isText = ovMode === "lens_text";
    const source = isText ? String(msg?.source || "").trim().toLowerCase() : "translated";
    if (isText && !source) return { ok: true, ignored: true };

    const img = TP.findTargetImage(msg.original);
    TP.log.info("OVERLAY_HTML", {
      key: TP.mdKeyFromUrl ? TP.mdKeyFromUrl(msg.original) : "",
      found: Boolean(img),
      source,
    });
    if (img) {
      try {
        applyHtmlOverlay(img, msg.result, source, isText, msg.original);
        return { ok: true, applied: true };
      } catch (e) {
        TP.log.warn("OVERLAY_HTML failed", e?.message || String(e));
        return { ok: false, applied: false, error: e?.message || String(e) };
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

  async function applyInsertMessage(message) {
    const msg = message || {};
    const type = String(msg.type || "");
    if (type === "REPLACE_IMAGE") {
      const applied = await replaceImageInDOM(msg.original, msg.newSrc);
      if (!applied && TP.isMangaDexHost()) TP.mdRememberPending(msg.original, { newSrc: msg.newSrc });
      return { ok: true, applied: !!applied };
    }
    if (type === "OVERLAY_HTML") return applyOverlayMessage(msg);
    if (type === "IMAGE_ERROR") return applyImageErrorMessage(msg);
    return { ok: true, ignored: true };
  }

  async function applyInsertBatch(items, options = {}) {
    const list = Array.isArray(items) ? items : [];
    const chunkSize = Math.max(1, Math.min(32, Number(options?.chunkSize) || 16));
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
      scheduleHtmlOverlayUpdate();
      try {
        TP.scheduleMangaDexOverlayUpdate?.();
      } catch {
        /* non-MangaDex */
      }
    }
    return { ok: true, bulk: true, results };
  }

  // --- In-DOM image replacement (non-text modes) ---------------------------

  /**
   * Swap an image's `src` for a translated one. MangaDex images are handled by
   * the MangaDex overlay variant instead of an in-place swap.
   * @returns {Promise<number>} 1 if applied, 0 otherwise
   */
  async function replaceImageInDOM(original, newSrc) {
    if (TP.isMangaDexHost?.() && TP.mdKeyFromUrl?.(original)) {
      return TP.replaceMangaDexImageWithOverlay(original, newSrc);
    }

    const img = TP.findTargetImage(original);
    if (!img) {
      TP.log.warn("REPLACE_IMAGE target not found", { original: TP.truncate(original) });
      return 0;
    }

    const mdKey = TP.mdKeyFromUrl?.(original);
    if (mdKey) img.dataset.tpOriginalKey = mdKey;
    const key = TP.normUrl(original);
    if (key) img.dataset.tpOriginal = key;
    TP.noteReplaceState(original, "pending");

    // Track load/error once so we know whether the swap really succeeded.
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

    // Prefer a blob: URL over a huge data: URI.
    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    // Revoke any previous blob URL we created for this image.
    const prevBlob = img.dataset.tpBlobUrl;
    if (prevBlob && prevBlob.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prevBlob);
      } catch {
        /* already revoked */
      }
      delete img.dataset.tpBlobUrl;
    }
    if (typeof nextSrc === "string" && nextSrc.startsWith("blob:")) img.dataset.tpBlobUrl = nextSrc;

    img.src = nextSrc;
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("data-src");
    img.removeAttribute("data-srcset");
    img.removeAttribute("loading");
    img.decoding = "sync";
    img.loading = "eager";

    TP.emitViewerEvent("textphantom:image-updated", { original, newSrc: nextSrc, rawNewSrc: newSrc });
    TP.log.info("REPLACE_IMAGE done", {
      before: TP.truncate(before),
      original: TP.truncate(original),
    });
    return 1;
  }

  Object.assign(TP, {
    ensureOverlayStyle,
    createOverlayBadge,
    extractNewImageSrc,
    dataUriToBlobUrl,
    ensureCleanLayer,
    updateCleanLayer,
    ensureOverlayHostMountedNearImage,
    getOverlayBoxFromParent,
    scheduleHtmlOverlayUpdate,
    applyHtmlOverlay,
    applyInsertBatch,
    applyInsertMessage,
    replaceImageInDOM,
    applyFontScaleToScope,        // MangaDex variant uses this on its scopes
    getCurrentFontScale: () => currentFontScale,
  });
})();
