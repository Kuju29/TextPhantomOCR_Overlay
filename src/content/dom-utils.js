// DOM and URL helpers shared by the content-script modules.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Runs a callback on the next animation frame, or on the next task while the tab is hidden,
  // because requestAnimationFrame does not fire in a background tab.
  function onNextFrame(fn) {
    if (document.visibilityState === "hidden") return setTimeout(fn, 0);
    let frame = 0, timer = 0, completed = false;
    const run = (timestamp) => {
      if (completed) return;
      completed = true;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
      document.removeEventListener?.("visibilitychange", onVisibility);
      fn(timestamp);
    };
    // The page can become hidden AFTER the frame was queued. Release that
    // wait as a task instead of waiting indefinitely for a foreground frame.
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && !timer) timer = setTimeout(run, 0);
    };
    document.addEventListener?.("visibilitychange", onVisibility);
    frame = requestAnimationFrame(run);
    return frame;
  }

  // Awaits the next frame, or the next task while the tab is hidden.
  function nextFrame() {
    return new Promise((resolve) => onNextFrame(() => resolve()));
  }

  // Normalises a URL against the page origin, dropping the hash.
  function normUrl(u) {
    if (!u) return "";
    try {
      u = String(u).trim();
    } catch {
      return "";
    }
    if (!u) return "";
    try {
      const x = new URL(u, location.href);
      x.hash = "";
      return x.toString();
    } catch {
      return u.split("#")[0].split("?")[0];
    }
  }

  const isHttpish = (u) => typeof u === "string" && /^https?:/i.test(u);
  const isInlineableImageUrl = (u) =>
    typeof u === "string" &&
    /^(?:data:|blob:|file:|chrome-extension:|moz-extension:)/i.test(u);

  // Returns the best source URL for an image element, preferring a remembered original.
  function getBestImgUrl(img) {
    const tp =
      img?.dataset?.tpOriginal ||
      (typeof img?.getAttribute === "function"
        ? img.getAttribute("data-tp-original")
        : "");
    if (tp && /^https?:/i.test(tp)) return tp;
    return (
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      ""
    );
  }

  // Reads a Blob as a data URI, resolving to "" on failure.
  function blobToDataUri(blob) {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      } catch {
        resolve("");
      }
    });
  }

  // Removes lazy-loading scripts and forces data-src onto src.
  function removeLazyScriptsAndForceSrc() {
    const lazyScripts = document.querySelectorAll('script[src*="lazy"]');
    lazyScripts.forEach((s) => s.remove());
    document.querySelectorAll("img[data-src]").forEach((img) => {
      img.removeAttribute("loading");
      img.classList.remove("lazyload", "lazy", "lazyloaded");
      if (img.dataset.src) img.src = img.dataset.src;
    });
    TP.log.info("lazy removed + src forced", {
      lazyScripts: lazyScripts.length,
    });
  }

  // Promotes lazy data attributes to real src/srcset and switches images to eager loading.
  function normalizeLazyImages() {
    document.querySelectorAll("img").forEach((img) => {
      const candSet =
        img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
      if (candSet && !img.srcset) img.srcset = candSet;
      const candSrc =
        img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
      if (candSrc && !img.src) img.src = candSrc;
      img.loading = "eager";
      img.decoding = "sync";
    });
  }

  // Builds a pipeline-event object for payload metadata.
  const buildPipelineEvent = (stage) => ({
    stage,
    at: new Date().toISOString(),
  });

  // Captures an image's on-screen position and viewport context.
  function buildPositionFromElement(img) {
    const rect = img.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      scroll_x: window.scrollX,
      scroll_y: window.scrollY,
    };
  }

  // Computes the scale and offset that place an overlay scope exactly over an image.
  function computeScale(imgElement, baseW, baseH, preferRect = false) {
    const rect = imgElement.getBoundingClientRect();
    const cw = preferRect
      ? rect.width || 1
      : imgElement.offsetWidth ||
        imgElement.clientWidth ||
        imgElement.width ||
        rect.width ||
        1;
    const ch = preferRect
      ? rect.height || 1
      : imgElement.offsetHeight ||
        imgElement.clientHeight ||
        imgElement.height ||
        rect.height ||
        1;
    const nw =
      (Number.isFinite(baseW) && baseW > 0 ? baseW : imgElement.naturalWidth) ||
      cw ||
      1;
    const nh =
      (Number.isFinite(baseH) && baseH > 0
        ? baseH
        : imgElement.naturalHeight) ||
      ch ||
      1;

    const cs = getComputedStyle(imgElement);
    const fit = cs.objectFit || "fill";
    const transform = cs.transform || "none";
    const transformOrigin = cs.transformOrigin || "0 0";

    const parsePos = (v, pad) => {
      if (!pad) return 0;
      if (!v) return pad * 0.5;
      const s = String(v).trim();
      if (s.endsWith("%")) return (pad * parseFloat(s)) / 100;
      if (s.endsWith("px")) return Math.min(pad, Math.max(0, parseFloat(s)));
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.min(pad, Math.max(0, n)) : pad * 0.5;
    };

    const [posX, posYRaw] = (cs.objectPosition || "50% 50%")
      .trim()
      .split(/\s+/);
    const posY = posYRaw || posX;

    let sx = cw / nw;
    let sy = ch / nh;
    let offX = 0;
    let offY = 0;

    if (fit !== "fill") {
      let scale = 1;
      if (fit === "contain") scale = Math.min(sx, sy);
      else if (fit === "cover") scale = Math.max(sx, sy);
      else if (fit === "scale-down") scale = Math.min(1, Math.min(sx, sy));
      else if (fit === "none") scale = 1;
      sx = scale;
      sy = scale;
      const padX = Math.max(0, cw - nw * scale);
      const padY = Math.max(0, ch - nh * scale);
      offX = parsePos(posX, padX);
      offY = parsePos(posY, padY);
    }

    return {
      rect,
      cw,
      ch,
      nw,
      nh,
      sx: isFinite(sx) && sx > 0 ? sx : 1,
      sy: isFinite(sy) && sy > 0 ? sy : 1,
      offX,
      offY,
      transform,
      transformOrigin,
    };
  }

  let toastEl = null;
  let toastTimer = 0;
  const liveToasts = new Map();
  const toastVersions = new Map();
  let toastPageStarted = 0;

  function paintToast(text, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed", right: "10px", bottom: "10px", zIndex: 2147483647,
        padding: "8px 10px", borderRadius: "10px", background: "rgba(0,0,0,.75)",
        color: "#fff", fontSize: "12px", lineHeight: "1.2", maxWidth: "68vw",
        pointerEvents: "none",
      });
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = String(text);
    toastEl.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = 0;
    if (ms > 0) toastTimer = setTimeout(() => {
      toastTimer = 0;
      if (!liveToasts.size && toastEl) toastEl.style.display = "none";
    }, Math.max(800, ms));
  }

  function showToast(text, ms = 2000, progress = null) {
    if (!text) return;
    const id = String(progress?.batchId || "");
    if (id) {
      if (progress.pageInstanceId && TP.pageInstanceId &&
          progress.pageInstanceId !== TP.pageInstanceId) return;
      if (Number(progress.startedAt) < toastPageStarted) return;
      const seq = Number(progress.sequence) || 0;
      if (seq && seq <= (toastVersions.get(id) || 0)) return;
      if (seq) toastVersions.set(id, seq);
      while (toastVersions.size > 128) toastVersions.delete(toastVersions.keys().next().value);
      if (progress.active) {
        liveToasts.delete(id);
        liveToasts.set(id, String(text));
      } else liveToasts.delete(id);
    }
    const active = [...liveToasts.values()].at(-1);
    if (active) return paintToast(active, 0);
    paintToast(text, Math.max(800, Number(ms) || 2000));
  }

  TP.clearToasts = () => {
    toastPageStarted = Date.now();
    liveToasts.clear(); toastVersions.clear();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = 0;
    if (toastEl) toastEl.style.display = "none";
  };

  // Stable identity for X media variants; keep normUrl strict elsewhere.
  function imageIdentity(u) {
    const normalized = normUrl(u);
    if (!normalized) return "";
    try {
      const x = new URL(normalized);
      if (
        x.hostname.toLowerCase() === "pbs.twimg.com" &&
        x.pathname.startsWith("/media/")
      ) {
        const format = String(x.searchParams.get("format") || "").toLowerCase();
        return `${x.origin}${x.pathname}${format ? `?format=${format}` : ""}`;
      }
    } catch {}
    return normalized;
  }

  const isXHost = () => /^(?:x|twitter)\.com$/i.test(location.hostname || "");

  // Dispatches a textphantom:* CustomEvent that the local viewer listens for.
  function emitViewerEvent(type, detail) {
    try {
      window.dispatchEvent(
        new CustomEvent(type, {
          detail: detail && typeof detail === "object" ? detail : {},
        }),
      );
    } catch {}
  }

  // Sends a message to the service worker, resolving null on error.
  function sendBg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (r) => {
          void chrome.runtime.lastError;
          resolve(r || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // Reads the core user settings from storage.
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["mode", "lang", "sources", "aiKey"], (it) => {
        resolve({
          // Defaults must match DEFAULT_MODE in src/shared/constants.js.
          mode: typeof it.mode === "string" ? it.mode : "lens_text",
          lang: typeof it.lang === "string" ? it.lang : "th",
          sources: typeof it.sources === "string" ? it.sources : "translated",
          aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
        });
      });
    });
  }

  Object.assign(TP, {
    onNextFrame,
    nextFrame,
    sendBg,
    getSettings,
    normUrl,
    imageIdentity,
    isXHost,
    isHttpish,
    isInlineableImageUrl,
    getBestImgUrl,
    blobToDataUri,
    removeLazyScriptsAndForceSrc,
    normalizeLazyImages,
    buildPipelineEvent,
    buildPositionFromElement,
    computeScale,
    showToast,
    emitViewerEvent,
  });
})();
