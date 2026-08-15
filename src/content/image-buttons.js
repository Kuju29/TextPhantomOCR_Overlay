// Pins a translate button to every translate-worthy image on the page.

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
  const buttons = new Map();

  // Creates the fixed button layer and its stylesheet when missing.
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
      document.documentElement.appendChild(container);
    }
    return true;
  }

  // Returns true when an image should carry a translate button.
  function isEligible(img) {
    if (!img || !img.isConnected) return false;
    if (img.closest?.(".tp-ol-root")) return false;
    return !TP.imageSkipReason(img, currentMode);
  }

  const MIN_RENDERED_SIDE = 120;
  const MIN_RENDERED_AREA = 60_000;
  const CLIP_WALK_MAX = 10;

  // Returns the image's visible rect after ancestor clipping, or null when it is invisible.
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

  // Returns a button's viewport placement, or null when it should stay hidden.
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
    return { left: Math.round(r.right - BTN_SIZE - 6), top: Math.round(r.top + 6) };
  }

  // Writes a placement onto a button, or hides it.
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

  // Repositions every button in one read phase followed by one write phase.
  function repositionAll() {
    rafPending = false;
    const plans = [];
    for (const [img, btn] of buttons.entries()) {
      if (!img.isConnected) {
        btn.remove();
        buttons.delete(img);
        continue;
      }
      plans.push([btn, computePlacement(img)]);
    }
    for (const [btn, p] of plans) applyPlacement(btn, p);
  }

  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(repositionAll);
  }

  // Runs the single-image translate flow for a clicked button.
  function onButtonClick(img, btn, event) {
    event.preventDefault();
    event.stopPropagation();
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.textContent = "⏳";

    TP.setLastRightClick?.(img);
    const srcUrl = TP.normUrl(TP.getBestImgUrl(img)) || img.currentSrc || img.src || "";

    chrome.runtime.sendMessage({ type: "TP_RUN_TRANSLATE_ONE", srcUrl }, (resp) => {
      void chrome.runtime.lastError;
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
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    return btn;
  }

  // Adds buttons to newly eligible images and removes those that no longer qualify.
  function rescan() {
    if (!enabled || !ensureDom()) return;
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

  function enable() {
    if (enabled) return;
    enabled = true;

    const start = async () => {
      try {
        currentMode = String((await TP.getSettings())?.mode || "lens_text");
      } catch {
        currentMode = "lens_text";
      }
      if (!enabled) return;
      rescan();
      window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
      window.addEventListener("resize", scheduleReposition, { passive: true });
      window.addEventListener("load", scheduleRescan, true);
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
  }
})();
