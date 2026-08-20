// Renders translated text as HTML overlays aligned over page images, and swaps images in place.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const OVERLAY_STYLE_ID = "textphantom_overlay_css";

  const htmlOverlaysByKey = new Map();
  let htmlOverlayRaf = 0;
  let htmlOverlayGlobalPending = false;
  const htmlOverlayPendingKeys = new Set();

  // The popup writes `fontScale` to storage and broadcasts `FONT_SCALE_CHANGED`.
  const FONT_SCALE_MIN = 0.5;
  const FONT_SCALE_MAX = 2.0;
  let currentFontScale = 1;

  function clampFontScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  }

  // Applies the current font scale to one overlay scope element.
  function applyFontScaleToScope(scope) {
    if (!scope) return;
    scope.style.setProperty("--tp-font-scale", String(currentFontScale));
  }

  function applyFontScaleEverywhere() {
    for (const rec of htmlOverlaysByKey.values()) {
      if (rec?.scope) applyFontScaleToScope(rec.scope);
    }
    try {
      TP.mdApplyFontScaleAll?.(currentFontScale);
    } catch {
    }
  }

  async function loadAndApplyFontScale() {
    try {
      const r = await new Promise((resolve) => {
        chrome.storage.local.get("fontScale", (items) => resolve(items || {}));
      });
      currentFontScale = clampFontScale(r?.fontScale ?? 1);
    } catch {
      currentFontScale = 1;
    }
    applyFontScaleEverywhere();
  }

  loadAndApplyFontScale();

  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes?.fontScale) return;
      currentFontScale = clampFontScale(changes.fontScale.newValue);
      applyFontScaleEverywhere();
    });
  } catch {
  }

  try {
    chrome.runtime.onMessage?.addListener((msg) => {
      if (msg?.type === "FONT_SCALE_CHANGED") {
        currentFontScale = clampFontScale(msg.fontScale);
        applyFontScaleEverywhere();
      }
    });
  } catch {
  }

  // Appends overlay CSS to the page's shared stylesheet, never replacing it.
  function ensureOverlayStyle(cssText = "") {
    let styleEl = document.getElementById(OVERLAY_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = OVERLAY_STYLE_ID;
      styleEl.type = "text/css";
      document.head.appendChild(styleEl);
    }

    const css = String(cssText || "").trim();
    if (css && !styleEl.textContent.includes(css)) {
      styleEl.appendChild(document.createTextNode(`\n/* TextPhantom overlay CSS */\n${css}\n`));
    }

    const hardenMarker = "/* TextPhantom harden */";
    if (!styleEl.textContent.includes(hardenMarker)) {
      const harden =
        "\n/* TextPhantom harden */\n" +
        ".tp-ol-root{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;transform-origin:0 0!important;}" +
        ".tp-ol-scope{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;}" +
        ".tp-ol-scope *{box-sizing:border-box!important;pointer-events:none!important;}" +
        ".tp-ol-container{position:relative!important;display:inline-block!important;line-height:0!important;overflow:visible!important;}";
      styleEl.appendChild(document.createTextNode(harden));
    }
  }

  // Builds a small status badge element for a given label.
  function createOverlayBadge(label) {
    const badge = document.createElement("div");
    badge.textContent = label || "No AI key";
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

  // Returns the replacement-image URL carried by a result, or null.
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

  const localBackgrounds = new WeakMap();

  function releaseLocalBackground(rec) {
    const url = localBackgrounds.get(rec);
    if (!url) return;
    localBackgrounds.delete(rec);
    try {
      URL.revokeObjectURL(url);
    } catch {
    }
  }

  // Builds the text-erased background image and annotates paragraph contrast.
  async function prepareLocalBackground(imgElement, result) {
    if (!TP.buildErasedBackground) throw new Error("local background builder is unavailable");
    const built = await TP.buildErasedBackground(
      imgElement,
      result?.eraseBoxes,
      result?.sourceImageDataUri,
      result?.lensDocument,
    );
    if (!built) {
      TP.log.warn("overlay: local background failed; the original text is still visible", {
        mode: result?.backgroundMode,
        src: TP.truncate?.(TP.getBestImgUrl(imgElement)) || "",
      });
      TP.markImageError?.(
        TP.getBestImgUrl(imgElement),
        "Could not erase the original text — showing the translation over it",
      );
      throw new Error("could not erase the original text");
    }
    return built;
  }

  async function applyLocalBackground(rec, imgElement, result, prepared = null) {
    const built = prepared || await prepareLocalBackground(imgElement, result);
    if (!rec?.host?.isConnected) {
      try {
        URL.revokeObjectURL(built.url);
      } catch {
      }
      return false;
    }
    releaseLocalBackground(rec);
    localBackgrounds.set(rec, built.url);
    updateCleanLayer(rec, imgElement, built.url);
    return true;
  }

  // Returns true when the API sent erase boxes for the client to paint instead of an inpainted image.
  function wantsLocalBackground(result) {
    return String(result?.backgroundMode || "") === "boxes" && Boolean(result?.eraseBoxes);
  }

  let rendererPromise = null;

  // Imports the overlay renderer module on demand from an extension URL.
  function loadRenderer() {
    if (rendererPromise) return rendererPromise;
    rendererPromise = import(chrome.runtime.getURL("processors/render-overlay.js")).catch(
      (e) => {
        rendererPromise = null;
        throw e;
      },
    );
    return rendererPromise;
  }

  // Returns true when the result carries the geometry needed to render locally.
  function wantsLocalRender(result) {
    return Boolean(result?.lensDocument?.paragraphs);
  }

  // Builds the overlay DOM from the result's LensDocument geometry.
  async function buildLocalRender(result, source) {
    const renderer = await loadRenderer();
    ensureOverlayStyle(renderer.OVERLAY_CSS);
    const { root, report } = renderer.renderOverlay(result.lensDocument, {
      source,
      relayoutTranslated: result?.layout?.relayout_translated,
    });
    if (report.error) {
      TP.log.warn(`overlay: local render refused the document — ${report.error}`, {
        error: report.error,
        source,
      });
      return { root: null, report };
    }
    const unanswered = report.aiUnanswered || [];
    const structural = report.missingLayer.filter((id) => !unanswered.includes(id));
    if (unanswered.length) {
      // Not "no text": the text is still on screen. The model answered some
      // units and not others, and this build leaves the source pixels of the
      // unanswered ones alone rather than erasing them into a blank bubble.
      //
      // Two different counts, both needed. The model is asked per UNIT (one
      // bubble = one unit, however many Lens paragraphs it spans), so the unit
      // count is what it actually got wrong. The paragraph count is what the
      // reader sees still in the source language. Reporting only paragraphs
      // reads as a much worse failure than it is: 5 unanswered units across
      // two-column bubbles print as "10".
      const partial = result?.aiPartial || null;
      const unitsMissing = Array.isArray(partial?.missing) ? partial.missing.length : null;
      TP.log.warn("overlay: AI partial — kept the original text where the model did not answer", {
        source,
        units: unitsMissing === null
          ? "unknown"
          : `${unitsMissing} of ${unitsMissing + Number(partial?.translated || 0)} unanswered`,
        paragraphs: unanswered.length,
        unitIds: Array.isArray(partial?.missing) ? partial.missing : undefined,
        // Which of the two ways the model failed to answer. They look
        // identical on the page and need different fixes: an empty entry is
        // the output contract's escape hatch being over-used (a prompt
        // problem), a missing entry is the contract breaking (a provider
        // problem).
        returnedEmpty: Array.isArray(partial?.declined) && partial.declined.length
          ? partial.declined : undefined,
        notReturned: Array.isArray(partial?.omitted) && partial.omitted.length
          ? partial.omitted : undefined,
        ids: unanswered,
      });
    }
    if (report.aiBlocksOverlapping) {
      // Two translations drawn through each other. The renderer cannot place
      // them apart — their SOURCE columns overlap, so grouping handed it one
      // region split into sets that share a bounding box (the signature of two
      // speech balloons offset diagonally inside one detected region). Named
      // here because nothing else in the report distinguishes it from a page
      // that came out clean.
      TP.log.warn("overlay: AI bubbles were drawn on top of each other; grouping spliced a region", {
        source,
        pairs: report.aiBlocksOverlapping,
        ids: report.aiBlocksOverlappingIds,
      });
    }
    if (structural.length) {
      // A different failure: the grouping names a paragraph this document does
      // not have, so the sentence has nowhere honest to go.
      TP.log.warn("overlay: grouping and document disagree; these paragraphs were not drawn", {
        source,
        ids: structural,
      });
    }
    TP.log.debug("overlay: rendered locally", report);
    return { root, report };
  }

  // Converts a data URI to a blob: URL.
  async function dataUriToBlobUrl(dataUri) {
    try {
      const blob = await (await fetch(dataUri)).blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  // Returns the overlay's text-erased background <img>, creating it if needed.
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
    }
  }

  // Points the clean layer at a new background source, or hides it.
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

  // Mounts the overlay host as the previous sibling of its image.
  function ensureOverlayHostMountedNearImage(rec, img) {
    const host = rec?.host;
    if (!host || !img?.isConnected) return null;
    const parent = img.parentElement;
    if (!parent) return null;

    if (host.parentElement !== parent || host.nextSibling !== img) {
      try {
        host.parentElement?.removeChild(host);
      } catch {
      }
      try {
        parent.insertBefore(host, img);
      } catch {
        try {
          parent.appendChild(host);
        } catch {
        }
      }
    }
    try {
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    } catch {
    }
    return host.parentElement === parent ? parent : null;
  }

  // Returns the image's box relative to a positioned parent.
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

  // Writes a style value only when it differs from the current one.
  function setOverlayStyleIfChanged(element, property, value, priority = "") {
    const style = element?.style;
    if (!style) return false;
    const nextValue = String(value ?? "");
    const nextPriority = String(priority || "");
    if (
      style.getPropertyValue(property) === nextValue &&
      style.getPropertyPriority(property) === nextPriority
    ) {
      return false;
    }
    style.setProperty(property, nextValue, nextPriority);
    return true;
  }

  // Returns true when a node is part of TextPhantom's own overlay DOM.
  function isOwnOverlayNode(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return false;
    if (element.matches?.(".tp-ol-root, .tp-ol-clean-img, .tp-md-image-overlay")) return true;
    return Boolean(element.closest?.(".tp-ol-root"));
  }

  // Returns true when mutation records include changes outside TextPhantom's overlays.
  function overlayMutationsNeedUpdate(records) {
    for (const record of records || []) {
      if (record.type === "attributes") {
        if (!isOwnOverlayNode(record.target)) return true;
        continue;
      }
      if (record.type === "childList") {
        if (isOwnOverlayNode(record.target)) continue;
        const touched = [...record.addedNodes, ...record.removedNodes];
        if (touched.length && touched.every((node) => isOwnOverlayNode(node))) continue;
        return true;
      }
      return true;
    }
    return false;
  }

  function disconnectOverlayResizeObserver(rec) {
    if (!rec) return;
    try {
      rec.ro?.disconnect?.();
    } catch {
    }
    rec.ro = null;
    rec.roImg = null;
  }

  // Binds one ResizeObserver per tracked image, reusing an existing one.
  function bindOverlayResizeObserver(rec, img, key) {
    if (!rec || !img) {
      disconnectOverlayResizeObserver(rec);
      return;
    }
    if (typeof ResizeObserver !== "function") return;
    if (rec.ro && rec.roImg === img) return;
    disconnectOverlayResizeObserver(rec);
    rec.ro = new ResizeObserver(() => scheduleHtmlOverlayUpdate(key));
    rec.roImg = img;
    rec.ro.observe(img);
  }

  // Re-positions tracked overlays, optionally restricted to a set of keys.
  function updateHtmlOverlays(onlyKeys = null) {
    if (!htmlOverlaysByKey.size) return;
    for (const [key, rec] of htmlOverlaysByKey.entries()) {
      if (onlyKeys && !onlyKeys.has(key)) continue;
      const { host, scope } = rec || {};
      if (!host || !scope) {
        htmlOverlaysByKey.delete(key);
        continue;
      }

      let img = rec.img;
      if (!img || !img.isConnected) img = TP.findTargetImage(key);
      if (!img) {
        setOverlayStyleIfChanged(host, "display", "none");
        disconnectOverlayResizeObserver(rec);
        rec.img = null;
        continue;
      }

      const curKey = TP.normUrl(TP.getBestImgUrl(img));
      if (curKey && curKey !== key) {
        setOverlayStyleIfChanged(host, "display", "none");
        disconnectOverlayResizeObserver(rec);
        rec.img = null;
        continue;
      }

      if (img !== rec.img) {
        if (img?.dataset) img.dataset.tpOriginal = key;
      }
      bindOverlayResizeObserver(rec, img, key);

      const parent = ensureOverlayHostMountedNearImage(rec, img);
      if (!parent) {
        setOverlayStyleIfChanged(host, "display", "none");
        rec.img = img;
        continue;
      }

      const { r, left, top } = getOverlayBoxFromParent(img, parent);
      if (r.width < 2 || r.height < 2) {
        setOverlayStyleIfChanged(host, "display", "none");
        rec.img = img;
        continue;
      }

      rec.img = img;
      setOverlayStyleIfChanged(host, "display", "block");
      setOverlayStyleIfChanged(host, "left", `${left}px`, "important");
      setOverlayStyleIfChanged(host, "top", `${top}px`, "important");
      setOverlayStyleIfChanged(host, "width", `${r.width}px`, "important");
      setOverlayStyleIfChanged(host, "height", `${r.height}px`, "important");

      if (rec.kind === "badge") {
        setOverlayStyleIfChanged(scope, "width", `${r.width}px`);
        setOverlayStyleIfChanged(scope, "height", `${r.height}px`);
        setOverlayStyleIfChanged(scope, "transform", "");
        setOverlayStyleIfChanged(scope, "transform-origin", "0 0");
        setOverlayStyleIfChanged(host, "transform", "");
        setOverlayStyleIfChanged(host, "transform-origin", "");
        continue;
      }

      const { nw, nh, sx, sy, offX, offY } = TP.computeScale(img, rec.baseW, rec.baseH, true);
      setOverlayStyleIfChanged(scope, "width", `${nw}px`);
      setOverlayStyleIfChanged(scope, "height", `${nh}px`);
      setOverlayStyleIfChanged(
        scope,
        "transform",
        `translate(${offX}px, ${offY}px) scale(${sx}, ${sy})`,
      );
      setOverlayStyleIfChanged(scope, "transform-origin", "0 0");
      setOverlayStyleIfChanged(host, "transform", "");
      setOverlayStyleIfChanged(host, "transform-origin", "");
    }
  }

  // Schedules a rAF refresh of one overlay by key, or of all when no key is given.
  function scheduleHtmlOverlayUpdate(key = "") {
    const targetKey = typeof key === "string" ? key : "";
    if (targetKey) htmlOverlayPendingKeys.add(targetKey);
    else htmlOverlayGlobalPending = true;

    if (htmlOverlayRaf) return;
    htmlOverlayRaf = TP.onNextFrame(() => {
      htmlOverlayRaf = 0;
      const updateAll = htmlOverlayGlobalPending;
      const keys = new Set(htmlOverlayPendingKeys);
      htmlOverlayGlobalPending = false;
      htmlOverlayPendingKeys.clear();
      if (updateAll) updateHtmlOverlays();
      else if (keys.size) updateHtmlOverlays(keys);
    });
  }

  // Installs the scroll/resize/mutation listeners that keep overlays aligned.
  function ensureHtmlOverlayListeners() {
    if (window.__tpHtmlOverlayListeners) return;
    window.__tpHtmlOverlayListeners = true;
    window.addEventListener("scroll", scheduleHtmlOverlayUpdate, { passive: true, capture: true });
    window.addEventListener("resize", scheduleHtmlOverlayUpdate, { passive: true });
    // Overlays inserted while the tab was hidden are realigned once it is shown again.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleHtmlOverlayUpdate();
    }, { passive: true });
    try {
      new MutationObserver((records) => {
        if (overlayMutationsNeedUpdate(records)) scheduleHtmlOverlayUpdate();
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "data-srcset", "style", "class"],
      });
    } catch {
    }
  }

  // Returns the overlay record for a non-MangaDex image key, creating it if needed.
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
      applyFontScaleToScope(scope);
      host.appendChild(scope);
      rec = {
        host,
        scope,
        img: null,
        baseW: 1,
        baseH: 1,
        kind: "html",
        ro: null,
        roImg: null,
      };
      htmlOverlaysByKey.set(key, rec);
      ensureHtmlOverlayListeners();
    }

    if (img) ensureOverlayHostMountedNearImage(rec, img);
    rec.img = img;
    rec.baseW = Number.isFinite(baseW) && baseW > 0 ? baseW : 1;
    rec.baseH = Number.isFinite(baseH) && baseH > 0 ? baseH : 1;
    rec.kind = kind || "html";
    if (img?.dataset && !img.dataset.tpOriginal) img.dataset.tpOriginal = key;
    bindOverlayResizeObserver(rec, img);
    return rec;
  }

  // Removes every overlay this document owns and forgets their records.
  function destroyAllHtmlOverlays() {
    let removed = 0;
    for (const [key, rec] of Array.from(htmlOverlaysByKey.entries())) {
      disconnectOverlayResizeObserver(rec);
      releaseLocalBackground(rec);
      try {
        rec.cleanImg?.remove();
        rec.host?.remove();
      } catch (e) {
        TP.log.debug("overlay host was already detached", { key, error: e?.message || String(e) });
      }
      htmlOverlaysByKey.delete(key);
      removed++;
    }
    return removed;
  }

  // Clears the identity stamps that make a recycled <img> report the previous route's URL.
  function clearImageStamps() {
    for (const img of Array.from(document.images || [])) {
      TP.clearImageError?.(img);
      delete img.dataset.tpOriginal;
      delete img.dataset.tpOriginalKey;
      delete img.dataset.tpBlobUrl;
      delete img.dataset.lensError;
    }
  }

  // Tears down this document's overlays after a client-side route change.
  function resetForNavigation(reason = "spa_navigation") {
    if (TP.isMangaDexHost?.()) return 0;
    const removed = destroyAllHtmlOverlays();
    clearImageStamps();
    TP.forgetImageState?.();
    TP.resetPageInstance?.(reason);
    TP.log.info("overlays cleared for navigation", { reason, removed });
    return removed;
  }

  function hideHtmlOverlay(key) {
    const rec = htmlOverlaysByKey.get(key);
    if (rec?.cleanImg) rec.cleanImg.style.display = "none";
    if (rec?.host) rec.host.style.display = "none";
  }

  // Strips TP paragraph markers that should never reach the DOM.
  const cleanOverlayHtml = (html) =>
    String(html || "")
      .replace(/<<TP_P\d+>>/g, "")
      .replace(/<<TP_P/g, "");

  const BLOCKED_OVERLAY_TAGS = new Set([
    "BASE",
    "BUTTON",
    "EMBED",
    "FORM",
    "IFRAME",
    "INPUT",
    "LINK",
    "META",
    "OBJECT",
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
  ]);
  const BLOCKED_OVERLAY_ATTRS = new Set([
    "action",
    "formaction",
    "href",
    "poster",
    "src",
    "srcdoc",
    "xlink:href",
  ]);

  // Parses overlay markup in an inert document and strips executable or navigating content.
  function parseSafeOverlayFragment(html) {
    const parsed = new DOMParser().parseFromString(cleanOverlayHtml(html), "text/html");
    for (const element of [...parsed.body.querySelectorAll("*")]) {
      if (BLOCKED_OVERLAY_TAGS.has(element.tagName)) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (
          name.startsWith("on") ||
          BLOCKED_OVERLAY_ATTRS.has(name) ||
          (name === "style" &&
            /(?:expression\s*\(|url\s*\(|@import|javascript\s*:)/i.test(value))
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    const fragment = document.createDocumentFragment();
    while (parsed.body.firstChild) {
      fragment.appendChild(document.importNode(parsed.body.firstChild, true));
      parsed.body.firstChild.remove();
    }
    return fragment;
  }

  // Replaces a scope's children with sanitized overlay markup.
  function fillScope(scope, html) {
    scope.replaceChildren(parseSafeOverlayFragment(html));
  }

  // Schedules an overlay update now and again once the image finishes loading.
  function nudgeOverlay(imgElement, schedule) {
    schedule();
    if (!imgElement.complete) {
      imgElement.addEventListener("load", schedule, { once: true, passive: true });
    }
    setTimeout(schedule, 50);
  }

  // Reads a skip/status reason regardless of which engine produced it.
  function resultStatusReason(result) {
    return String(
      result?.meta?.skipped_reason ||
      result?.metadata?.skipped_reason ||
      result?.Ai?.meta?.skipped_reason ||
      result?.ai?.meta?.skipped_reason ||
      result?.translated?.meta?.skipped_reason ||
      result?.original?.meta?.skipped_reason ||
      result?.Ai?.meta?.reason ||
      result?.ai?.meta?.reason ||
      ""
    ).trim().toLowerCase();
  }

  function statusBadgeLabel(reason) {
    if (/no[_ -]?translatable/.test(reason)) return "No translatable text";
    if (/no[_ -]?text/.test(reason)) return "No text";
    if (/rate.?limit/.test(reason)) return "AI rate limit";
    if (/missing.*key|no[_ -]?ai[_ -]?key/.test(reason)) return "No AI key";
    if (/model/.test(reason) && /unavailable|missing|not[_ -]?found/.test(reason)) {
      return "AI model unavailable";
    }
    return reason ? reason.replace(/[_-]+/g, " ").slice(0, 72) : "AI output unavailable";
  }

  // Applies a translation result to an image as an HTML overlay and clean background layer.
  async function applyHtmlOverlay(imgElement, result, source, isTextMode, original = "") {
    // A successful result or an intentional skip replaces any terminal marker
    // from an earlier retry/pass.
    TP.clearImageError?.(imgElement);
    const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || "";
    const translatedHtml = result?.translated?.translatedhtml || result?.translatedhtml || "";
    const originalHtml = result?.original?.originalhtml || result?.originalhtml || "";

    const req = String(source || "").trim().toLowerCase();
    const chosen = req === "ai" || req === "original" ? req : "translated";
    const html = chosen === "ai" ? aiHtml : chosen === "original" ? originalHtml : translatedHtml;

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
    const localBg = isTextMode && wantsLocalBackground(result);
    const newImgSrc = isTextMode && !localBg ? extractNewImageSrc(result) : null;

    ensureOverlayStyle(cssText);

    const mdKey = TP.isMangaDexHost?.() ? TP.mdGetKeyForImg?.(imgElement) : "";
    const useMd = Boolean(mdKey);
    const ops = useMd
      ? {
          key: mdKey,
          upsert: (kind) => TP.upsertMangaDexHtmlOverlay(mdKey, imgElement, baseW, baseH, kind),
          schedule: () => TP.scheduleMangaDexOverlayUpdate(mdKey),
          hide: () => TP.hideMangaDexHtmlOverlay(mdKey),
        }
      : (() => {
          const key = TP.normUrl(original) || TP.normUrl(TP.getBestImgUrl(imgElement));
          return key
            ? {
                key,
                upsert: (kind) => upsertHtmlOverlay(key, imgElement, baseW, baseH, kind),
                schedule: () => scheduleHtmlOverlayUpdate(key),
                hide: () => hideHtmlOverlay(key),
              }
            : null;
        })();
    if (!ops) return;

    const statusReason = resultStatusReason(result);
    if (isTextMode && req === "ai" && statusReason) {
      const rec = ops.upsert("badge");
      updateCleanLayer(rec, imgElement, newImgSrc);
      if (localBg) await applyLocalBackground(rec, imgElement, result);
      rec.scope.textContent = "";
      rec.scope.appendChild(createOverlayBadge(statusBadgeLabel(statusReason)));
      nudgeOverlay(imgElement, ops.schedule);
      return;
    }

    if (isTextMode && req === "ai" && !aiHtml && !wantsLocalRender(result)) {
      const rec = ops.upsert("badge");
      updateCleanLayer(rec, imgElement, newImgSrc);
      if (localBg) await applyLocalBackground(rec, imgElement, result);
      rec.scope.textContent = "";
      // No explicit skip reason means this is genuinely an absent AI layer,
      // not proof that an API key is missing.
      rec.scope.appendChild(createOverlayBadge("AI output unavailable"));
      nudgeOverlay(imgElement, ops.schedule);
      return;
    }

    if (!html && !(isTextMode && wantsLocalRender(result))) {
      if (isTextMode && (newImgSrc || localBg)) {
        const rec = ops.upsert("badge");
        updateCleanLayer(rec, imgElement, newImgSrc);
        if (localBg) await applyLocalBackground(rec, imgElement, result);
        rec.scope.textContent = "";
        nudgeOverlay(imgElement, ops.schedule);
        return;
      }
      ops.hide();
      return;
    }

    // The font sizes actually drawn, from whichever route drew them. Both
    // renderers emit `font-size:calc(var(--tp-font-scale,1) * Npx)`, so one
    // reader answers "how big was the text?" for the local DOM and for the
    // server's markup alike — the only way to compare the two engines on the
    // same page without a screenshot.
    const FONT_PX_RE = /font-size:\s*calc\(var\(--tp-font-scale,\s*1\)\s*\*\s*([\d.]+)px\)/g;
    const fontStats = (text) => {
      const sizes = [];
      let match;
      FONT_PX_RE.lastIndex = 0;
      while ((match = FONT_PX_RE.exec(String(text || "")))) sizes.push(Number(match[1]));
      if (!sizes.length) return null;
      sizes.sort((a, b) => a - b);
      return {
        lines: sizes.length,
        min: sizes[0],
        median: sizes[(sizes.length - 1) >> 1],
        max: sizes[sizes.length - 1],
      };
    };

    // Logs which render route ran for this image.
    const reportRoute = (outcome, reason, fonts = null) => {
      TP.log.info("tp.route", {
        stage: "render",
        outcome,
        reason,
        source: chosen,
        mode: isTextMode ? "lens_text" : "lens_images",
        serverMarkupAvailable: Boolean(html),
      });
      TP.traceNote?.("content/overlay.js", "applyHtmlOverlay", {
        ev: "route decided",
        outcome,
        reason,
        source: chosen,
        docParagraphs: (result?.lensDocument?.paragraphs || []).length,
        serverMarkupAvailable: Boolean(html),
        fonts,
      });
    };

    let builtRoot = null;
    let preparedLocalBackground = null;
    let localFailure = "";
    if (isTextMode && wantsLocalRender(result)) {
      try {
        if (localBg) preparedLocalBackground = await prepareLocalBackground(imgElement, result);
        const built = await buildLocalRender(result, chosen);
        builtRoot = built.root;
        if (!builtRoot) localFailure = "local renderer refused the document";
      } catch (e) {
        localFailure = `local render threw: ${e?.message || String(e)}`;
      }
    }

    const rec = ops.upsert("html");
    updateCleanLayer(rec, imgElement, newImgSrc);
    if (isTextMode && localBg) {
      await applyLocalBackground(rec, imgElement, result, preparedLocalBackground);
    }
    if (builtRoot) {
      rec.scope.replaceChildren(builtRoot);
      reportRoute("new", "", fontStats(builtRoot.innerHTML));
    } else {
      if (localFailure) reportRoute("fell-back", localFailure);
      // Not "old": the scope is replaced with the server's markup on the next
      // line. Calling this "old" made a working API-engine page read as a
      // page that had kept its previous overlay.
      else reportRoute("server", isTextMode ? "drew the server's markup" : "image mode", fontStats(html));
      fillScope(rec.scope, html);
    }
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



  function sleepFrame() {
    return TP.nextFrame();
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

    let img = TP.findTargetImage(msg.original);

    if (!img && TP.waitForTarget && msg?.generation?.targetKey) {
      img = await TP.waitForTarget(msg.generation.targetKey, () =>
        TP.findTargetImage(msg.original),
      );
      if (!img) {
        return { ok: true, applied: false, expired: true, reason: "target never remounted" };
      }
    }

    if (img && TP.isStillCurrent) {
      const current = TP.isStillCurrent(img, msg.generation);
      if (!current.ok) {
        TP.log.info("OVERLAY_HTML dropped: stale target", { reason: current.reason });
        return { ok: true, applied: false, stale: true, reason: current.reason };
      }
    }

    TP.log.info("OVERLAY_HTML", {
      key: TP.mdKeyFromUrl ? TP.mdKeyFromUrl(msg.original) : "",
      found: Boolean(img),
      source,
    });
    if (img) {
      try {
        await applyHtmlOverlay(img, msg.result, source, isText, msg.original);
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

  // Applies one insert message from the background to the page.
  async function applyInsertMessage(message) {
    const msg = message || {};
    const type = String(msg.type || "");

    if (msg.tpTrace) TP.setTrace?.(msg.tpTrace);
    TP.traceNote?.("content/overlay.js", "applyInsertMessage", {
      ev: "insert message received",
      type,
      original: msg.original,
    });

    if (type === "REPLACE_IMAGE") {
      const applied = await replaceImageInDOM(msg.original, msg.newSrc);
      if (!applied && TP.isMangaDexHost()) TP.mdRememberPending(msg.original, { newSrc: msg.newSrc });
      return { ok: true, applied: !!applied };
    }
    if (type === "OVERLAY_HTML") return applyOverlayMessage(msg);
    if (type === "IMAGE_ERROR") return applyImageErrorMessage(msg);
    return { ok: true, ignored: true };
  }

  // Applies insert messages in chunks, yielding a frame between chunks.
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
    }
    return { ok: true, bulk: true, results };
  }

  // Swaps an image's src for a translated one, returning 1 when applied.
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
      const blobUrl = await dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    const prevBlob = img.dataset.tpBlobUrl;
    if (prevBlob && prevBlob.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prevBlob);
      } catch {
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
    setOverlayStyleIfChanged,
    overlayMutationsNeedUpdate,
    scheduleHtmlOverlayUpdate,
    applyHtmlOverlay,
    applyInsertBatch,
    applyInsertMessage,
    replaceImageInDOM,
    applyFontScaleToScope,
    destroyAllHtmlOverlays,
    resetForNavigation,
    getCurrentFontScale: () => currentFontScale,
  });
})();
