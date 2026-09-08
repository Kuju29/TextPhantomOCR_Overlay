(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const htmlOverlaysByKey = new Map();
  let htmlOverlayRaf = 0;
  let htmlOverlayGlobalPending = false;
  const htmlOverlayPendingKeys = new Set();

  function ensureOverlayHostMountedNearImage(rec, img) {
    const host = rec?.host;
    if (!host || !img?.isConnected) return null;
    const parent = img.parentElement;
    if (!parent) return null;

    if (
      TP.isXHost?.() &&
      TP.imageIdentity?.(TP.getBestImgUrl(img)) !==
        TP.normUrl(TP.getBestImgUrl(img))
    ) {
      const portalParent = document.body || document.documentElement;
      if (host.parentElement !== portalParent) portalParent.appendChild(host);
      rec.fixedPortal = true;
      host.style.setProperty("position", "fixed", "important");
      return portalParent;
    }
    rec.fixedPortal = false;

    if (host.parentElement !== parent || host.nextSibling !== img) {
      try {
        host.parentElement?.removeChild(host);
      } catch {}
      try {
        parent.insertBefore(host, img);
      } catch {
        try {
          parent.appendChild(host);
        } catch {}
      }
    }
    try {
      if (getComputedStyle(parent).position === "static")
        parent.style.position = "relative";
    } catch {}
    return host.parentElement === parent ? parent : null;
  }

  // Returns the image's box relative to a positioned parent.
  function getOverlayBoxFromParent(img, parent) {
    const r = img.getBoundingClientRect();
    if (parent === document.body || parent === document.documentElement)
      return { r, left: r.left, top: r.top };
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
    if (
      element.matches?.(".tp-ol-root, .tp-ol-clean-img, .tp-md-image-overlay")
    )
      return true;
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
        if (touched.length && touched.every((node) => isOwnOverlayNode(node)))
          continue;
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
    } catch {}
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
      const sameIdentity =
        TP.imageIdentity?.(curKey) === TP.imageIdentity?.(key);
      if (curKey && curKey !== key && !sameIdentity) {
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

      const { nw, nh, sx, sy, offX, offY } = TP.computeScale(
        img,
        rec.baseW,
        rec.baseH,
        true,
      );
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
    window.addEventListener("scroll", scheduleHtmlOverlayUpdate, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", scheduleHtmlOverlayUpdate, {
      passive: true,
    });
    // Overlays inserted while the tab was hidden are realigned once it is shown again.
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") scheduleHtmlOverlayUpdate();
      },
      { passive: true },
    );
    try {
      new MutationObserver((records) => {
        if (overlayMutationsNeedUpdate(records)) scheduleHtmlOverlayUpdate();
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "src",
          "srcset",
          "data-src",
          "data-srcset",
          "style",
          "class",
        ],
      });
    } catch {}
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
      TP.overlayFontScale?.register(scope);
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
      TP.overlayBackground.release(rec);
      try {
        rec.cleanImg?.remove();
        rec.host?.remove();
      } catch (e) {
        TP.log.debug("overlay host was already detached", {
          key,
          error: e?.message || String(e),
        });
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

  // Schedules an overlay update now and again once the image finishes loading.

  const api = {
    destroyAllHtmlOverlays,
    ensureOverlayHostMountedNearImage,
    getOverlayBoxFromParent,
    hideHtmlOverlay,
    overlayMutationsNeedUpdate,
    resetForNavigation,
    scheduleHtmlOverlayUpdate,
    setOverlayStyleIfChanged,
    upsertHtmlOverlay,
  };
  TP.overlayMount = api;
  Object.assign(TP, api);
})();
