/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * On-image translate buttons (for sites that block right-click).
 *
 * When the popup toggle `imgButtonsEnabled` is on, every translate-worthy
 * image on the page gets a small 🔍 button pinned to its top-RIGHT corner.
 * Clicking it runs the exact same flow as "Translate this image" in the
 * context menu: the image is registered as the last-clicked target
 * (setLastRightClick) and the service worker is asked to run the img_one
 * pipeline (TP_RUN_TRANSLATE_ONE).
 *
 * Design notes:
 * - One fixed container (pointer-events: none) holds all buttons; only the
 *   buttons themselves are clickable, so the page is never blocked.
 * - Eligibility reuses imageSkipReason() — the same filter as page scans —
 *   so buttons never appear on icons/avatars/tracking pixels.
 * - Positions follow scroll/resize (rAF-throttled) and a MutationObserver
 *   picks up lazy-loaded images; detached images lose their button.
 * - Runs in every frame (content scripts are all_frames), each frame owns
 *   its own images.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const STORAGE_KEY = "imgButtonsEnabled";
  const RESCAN_DEBOUNCE_MS = 400;
  const BTN_SIZE = 30;

  let enabled = false;
  let container = null;
  let styleEl = null;
  let observer = null;
  let rescanTimer = 0;
  let rafPending = false;
  let currentMode = "lens_text";
  /** HTMLImageElement -> HTMLButtonElement */
  const buttons = new Map();

  // --- DOM scaffolding -------------------------------------------------------
  function ensureDom() {
    if (!document.documentElement) return false;
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.id = "tp-img-btn-css";
      styleEl.textContent = `
        #tp-img-btn-layer{position:fixed;top:0;left:0;right:0;bottom:0;overflow:hidden;z-index:2147483645;pointer-events:none;}
        .tp-img-btn{position:absolute;width:${BTN_SIZE}px;height:${BTN_SIZE}px;box-sizing:border-box;
          display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;
          border:1px solid rgba(255,255,255,.55);border-radius:8px;background:rgba(17,17,17,.72);
          color:#fff;font:600 14px/1 system-ui,sans-serif;padding:0;margin:0;
          box-shadow:0 1px 4px rgba(0,0,0,.35);opacity:.82;transition:opacity .15s,transform .15s;}
        .tp-img-btn:hover{opacity:1;transform:scale(1.08);}
        .tp-img-btn[data-busy="1"]{cursor:default;opacity:.95;}
      `;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    if (!container || !container.isConnected) {
      container = document.createElement("div");
      container.id = "tp-img-btn-layer";
      // Parent on <html>, not <body>: a site styling body with
      // position/margin/transform would shift every button's coordinates.
      document.documentElement.appendChild(container);
    }
    return true;
  }

  // --- Eligibility -----------------------------------------------------------
  function isEligible(img) {
    // Never decorate our own error badges / overlay images.
    if (!img || !img.isConnected) return false;
    if (img.closest?.(".tp-ol-root")) return false;
    return !TP.imageSkipReason(img, currentMode);
  }

  // --- Positioning -----------------------------------------------------------
  // The layer is FIXED and viewport-sized with overflow:hidden, and buttons
  // use viewport coordinates. This way off-screen images can never widen the
  // page's scrollable area (an absolute document-space layer did exactly
  // that: a button placed past the document edge grew the scroll width).
  // Rendered-size gate: the button only shows on images that currently LOOK
  // like content (manga pages), judged by their VISIBLE on-screen size — not
  // natural size and not the raw element box. Hover-preview thumbnails (e.g.
  // e-hentai listings) are big <img> elements cropped to ~20px by an
  // overflow:hidden parent; the raw rect passes a size check, the visible
  // rect does not.
  const MIN_RENDERED_SIDE = 120;
  const MIN_RENDERED_AREA = 60_000;
  const CLIP_WALK_MAX = 10;

  /**
   * The image's VISIBLE rect, or null when it is effectively invisible:
   * - clipped away by an overflow:hidden/clip/auto/scroll ancestor, or
   * - hidden via visibility (inherited — computed on the img itself), or
   * - faded out via opacity:0 on the img or any walked ancestor
   *   (hover-preview thumbnails on listing sites use exactly these tricks
   *   while still occupying full-size layout space).
   */
  function visibleRectOf(img) {
    const ics = getComputedStyle(img);
    if (ics.visibility !== "visible" || Number(ics.opacity) === 0) return null;

    const r0 = img.getBoundingClientRect();
    let left = r0.left, top = r0.top, right = r0.right, bottom = r0.bottom;
    let node = img.parentElement;
    for (let i = 0; node && i < CLIP_WALK_MAX; i++, node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (Number(cs.opacity) === 0) return null;
      const ov = `${cs.overflow} ${cs.overflowX} ${cs.overflowY}`;
      if (/(hidden|clip|auto|scroll)/.test(ov)) {
        const pr = node.getBoundingClientRect();
        left = Math.max(left, pr.left);
        top = Math.max(top, pr.top);
        right = Math.min(right, pr.right);
        bottom = Math.min(bottom, pr.bottom);
        if (right <= left || bottom <= top) return null;
      }
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /** Compute a button's placement — READS ONLY. null = hidden. */
  function computePlacement(img) {
    const r = visibleRectOf(img);
    if (!r) return null;
    const tooSmall =
      Math.min(r.width, r.height) < MIN_RENDERED_SIDE ||
      r.width * r.height < MIN_RENDERED_AREA;
    const offScreen =
      r.bottom < 0 ||
      r.right < 0 ||
      r.top > window.innerHeight ||
      r.left > window.innerWidth;
    if (tooSmall || offScreen) return null;
    // Top-right corner of the VISIBLE part (viewport coords — layer is fixed).
    return { left: Math.round(r.right - BTN_SIZE - 6), top: Math.round(r.top + 6) };
  }

  /** Apply a placement — WRITES ONLY. */
  function applyPlacement(btn, p) {
    if (!p) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    btn.style.left = `${p.left}px`;
    btn.style.top = `${p.top}px`;
  }

  function positionButton(img, btn) {
    applyPlacement(btn, computePlacement(img));
  }

  // Batched read-then-write: interleaving rect reads with style writes can
  // force one reflow PER BUTTON per frame; two phases keep it to (at most)
  // one layout pass regardless of how many buttons exist.
  function repositionAll() {
    rafPending = false;
    const plans = [];
    for (const [img, btn] of buttons.entries()) {
      if (!img.isConnected) {
        btn.remove();
        buttons.delete(img);
        continue;
      }
      plans.push([btn, computePlacement(img)]); // read phase
    }
    for (const [btn, p] of plans) applyPlacement(btn, p); // write phase
  }

  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(repositionAll);
  }

  // --- Button behaviour ------------------------------------------------------
  function onButtonClick(img, btn, event) {
    event.preventDefault();
    event.stopPropagation();
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.textContent = "⏳";

    // Same registration a real right-click performs — makes blob:/data:
    // sources resolvable via GET_CONTEXT_IMAGE_PAYLOAD.
    TP.setLastRightClick?.(img);
    const srcUrl = TP.normUrl(TP.getBestImgUrl(img)) || img.currentSrc || img.src || "";

    chrome.runtime.sendMessage({ type: "TP_RUN_TRANSLATE_ONE", srcUrl }, (resp) => {
      void chrome.runtime.lastError;
      // Progress + result arrive through the normal toast/overlay pipeline;
      // the button just resets after a moment.
      setTimeout(() => {
        btn.dataset.busy = "";
        btn.textContent = "🔍";
      }, 4000);
      if (resp && resp.ok === false) {
        TP.showToast?.("TextPhantom: " + (resp.error || "translate failed"), 4000);
      }
    });
  }

  function makeButton(img) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tp-img-btn";
    btn.textContent = "🔍";
    btn.title = "Translate this image (TextPhantom)";
    btn.addEventListener("click", (e) => onButtonClick(img, btn, e));
    // Some sites cancel mousedown to fight toolbars — keep ours alive.
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    return btn;
  }

  // --- Scanning --------------------------------------------------------------
  function rescan() {
    if (!enabled || !ensureDom()) return;
    // Re-evaluate EXISTING buttons too: an image may have loaded/changed src
    // since the last scan and turned out to be an icon/avatar after all.
    for (const [img, btn] of buttons.entries()) {
      if (!isEligible(img)) {
        btn.remove();
        buttons.delete(img);
      }
    }
    for (const img of Array.from(document.images || [])) {
      if (buttons.has(img)) continue;
      if (!isEligible(img)) continue;
      const btn = makeButton(img);
      buttons.set(img, btn);
      container.appendChild(btn);
      positionButton(img, btn);
    }
    scheduleReposition();
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
  }

  // --- Enable / disable ------------------------------------------------------
  function enable() {
    if (enabled) return;
    enabled = true;

    const start = async () => {
      try {
        currentMode = String((await TP.getSettings())?.mode || "lens_text");
      } catch {
        currentMode = "lens_text";
      }
      if (!enabled) return; // toggled off while reading settings
      rescan();
      window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
      window.addEventListener("resize", scheduleReposition, { passive: true });
      // Image "load" doesn't bubble, but a capture listener sees it: re-run
      // the size gate the moment a lazy image gets its real dimensions.
      window.addEventListener("load", scheduleRescan, true);
      // New / lazy-loaded images.
      observer = new MutationObserver(scheduleRescan);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-src"],
      });
      TP.log.info("image buttons enabled");
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      void start();
    }
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    clearTimeout(rescanTimer);
    observer?.disconnect();
    observer = null;
    window.removeEventListener("scroll", scheduleReposition, { capture: true });
    window.removeEventListener("resize", scheduleReposition);
    window.removeEventListener("load", scheduleRescan, true);
    for (const btn of buttons.values()) btn.remove();
    buttons.clear();
    container?.remove();
    container = null;
    TP.log.info("image buttons disabled");
  }

  // --- Wiring ----------------------------------------------------------------
  try {
    chrome.storage.local.get(STORAGE_KEY, (items) => {
      void chrome.runtime.lastError;
      if (items && items[STORAGE_KEY]) enable();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      if (changes[STORAGE_KEY].newValue) enable();
      else disable();
    });
  } catch {
    /* storage unavailable (rare) — feature simply stays off */
  }
})();
