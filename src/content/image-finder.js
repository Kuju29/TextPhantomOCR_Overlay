// Resolves which image element a result belongs to and tracks per-image replace state.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const replaceStateByOriginal = new Map();

  function noteReplaceState(original, state) {
    const key = TP.normUrl(original);
    if (key) replaceStateByOriginal.set(key, { state, ts: Date.now() });
  }

  // Returns true when an error badge is still warranted for an image.
  function shouldShowReplaceError(original) {
    const key = TP.normUrl(original);
    if (!key) return true;
    const s = replaceStateByOriginal.get(key);
    if (!s) return true;
    if (s.state === "ok") return false;
    if (s.state === "pending" && Date.now() - s.ts < 12000) return false;
    return true;
  }

  // Records the replace outcome for one original URL.
  function setReplaceState(key, state) {
    if (key) replaceStateByOriginal.set(key, { state, ts: Date.now() });
  }

  const RIGHT_CLICK_MAX_AGE_MS = 8000;
  let lastRightClick = { img: null, ts: 0, urls: [] };
  const recentImgByUrl = new Map();

  // Indexes an image under each of its URLs, trimming the index when it grows.
  function rememberImgUrls(img, urls) {
    const ts = Date.now();
    for (const u of urls || []) {
      const k = TP.normUrl(u);
      if (k) recentImgByUrl.set(k, { img, ts });
    }
    if (recentImgByUrl.size > 200) {
      const cutoff = ts - 5 * 60 * 1000;
      for (const [k, v] of recentImgByUrl.entries()) {
        if (!v?.img || !v.img.isConnected || (v.ts || 0) < cutoff) recentImgByUrl.delete(k);
      }
      while (recentImgByUrl.size > 220) recentImgByUrl.delete(recentImgByUrl.keys().next().value);
    }
  }

  // Registers an image as the current translate target.
  function setLastRightClick(img) {
    if (!img) return;
    const urls = [img.currentSrc, img.src, TP.getBestImgUrl(img)]
      .filter(Boolean)
      .map(TP.normUrl)
      .filter(Boolean);
    if (urls[0] && img?.dataset) img.dataset.tpOriginal = urls[0];
    lastRightClick = { img, ts: Date.now(), urls };
    rememberImgUrls(img, urls);
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      const img = e?.target?.closest ? e.target.closest("img") : null;
      if (img) setLastRightClick(img);
    },
    true,
  );

  const getLastRightClick = () => lastRightClick;

  // Returns the recently right-clicked image only when the request names that same element.
  function getFreshRightClickImageForTarget(request, now = Date.now()) {
    const lrc = lastRightClick;
    const img = lrc?.img;
    if (!img || !img.isConnected) return null;
    if (!Number.isFinite(lrc.ts) || now - lrc.ts < 0 || now - lrc.ts > RIGHT_CLICK_MAX_AGE_MS) {
      return null;
    }

    const requested = TP.normUrl(request?.srcUrl);
    const clicked = TP.normUrl(request?.clickedSrcUrl || request?.srcUrl);
    if (!requested && !clicked) return null;

    const clickAliases = new Set((lrc.urls || []).map(TP.normUrl).filter(Boolean));
    const currentAliases = new Set(
      [
        img.currentSrc,
        img.src,
        img?.dataset?.tpOriginal,
        typeof img.getAttribute === "function" ? img.getAttribute("data-src") : "",
        typeof img.getAttribute === "function" ? img.getAttribute("data-original") : "",
        typeof img.getAttribute === "function" ? img.getAttribute("data-lazy-src") : "",
        TP.getBestImgUrl(img),
      ]
        .map(TP.normUrl)
        .filter(Boolean),
    );
    const allAliases = new Set([...clickAliases, ...currentAliases]);

    if (requested && !allAliases.has(requested)) return null;
    if (clicked && !allAliases.has(clicked)) return null;

    if (requested && clicked && requested !== clicked && !currentAliases.has(requested)) {
      return null;
    }
    return img;
  }

  // Resolves the image element a result belongs to from every known index.
  function findTargetImage(original) {
    const o = TP.normUrl(original);
    const images = () => Array.from(document.images || []);

    const mdKey = TP.mdKeyFromUrl ? TP.mdKeyFromUrl(original) : "";
    if (mdKey) {
      const byKey = images().find((img) => String(img.dataset.tpOriginalKey || "") === mdKey);
      if (byKey) return byKey;
    }

    if (o) {
      const byData = images().find((img) => TP.normUrl(img.dataset.tpOriginal) === o);
      if (byData) return byData;

      const rec = recentImgByUrl.get(o);
      if (rec?.img && rec.img.isConnected) return rec.img;
    }

    if (lastRightClick.img && Date.now() - lastRightClick.ts < RIGHT_CLICK_MAX_AGE_MS) {
      if (!o || (lastRightClick.urls || []).includes(o)) return lastRightClick.img;
    }

    for (const img of images()) {
      if (o && (TP.normUrl(img.currentSrc) === o || TP.normUrl(img.src) === o)) return img;
    }
    return null;
  }

  // Draws a red outline and a warning badge on an image that failed to translate.
  function markImageError(original, msg) {
    if (!shouldShowReplaceError(original)) return;

    const img = findTargetImage(original);
    if (!img || img.dataset.lensError) return;

    const cur = img.currentSrc || img.src || "";
    if (img.dataset.tpBlobUrl || cur.startsWith("blob:") || cur.startsWith("data:")) return;

    img.style.outline = "3px solid red";

    const badge = document.createElement("div");
    badge.textContent = "⚠️";
    badge.title = msg || "OCR error";
    const r = img.getBoundingClientRect();
    Object.assign(badge.style, {
      position: "absolute",
      left: `${r.left + window.scrollX + 4}px`,
      top: `${r.top + window.scrollY + 4}px`,
      background: "rgba(255,255,255,0.9)",
      padding: "2px 4px",
      borderRadius: "4px",
      zIndex: 9999,
    });
    document.body.appendChild(badge);
    img.dataset.lensError = "1";
    TP.log.info("markImageError", { original: TP.truncate(original), message: msg });
  }

  // Drops the per-URL image indexes so a client-side route change cannot resolve a stale element.
  function forgetImageState() {
    replaceStateByOriginal.clear();
    recentImgByUrl.clear();
    lastRightClick = { img: null, ts: 0, urls: [] };
  }

  Object.assign(TP, {
    forgetImageState,
    noteReplaceState,
    shouldShowReplaceError,
    setReplaceState,
    rememberImgUrls,
    getLastRightClick,
    getFreshRightClickImageForTarget,
    setLastRightClick,
    findTargetImage,
    markImageError,
  });
})();
