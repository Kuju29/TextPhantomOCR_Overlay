/**
 * Locating image elements + tracking their replacement state.
 *
 * "Which `<img>` does this result belong to?" is surprisingly hard: the URL in
 * the result may differ from what the DOM now shows (lazy-load, blob swaps,
 * MangaDex). This module keeps several indices — the last right-clicked image,
 * a recent-URL map, `data-tp-original` markers — and resolves a target image
 * from any of them. It also tracks per-image replace state so we don't show an
 * error badge on an image that actually succeeded.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // --- Replace-state tracking ---------------------------------------------
  // originalUrl -> { state: "pending"|"ok"|"fail", ts }
  const replaceStateByOriginal = new Map();

  function noteReplaceState(original, state) {
    const key = TP.normUrl(original);
    if (key) replaceStateByOriginal.set(key, { state, ts: Date.now() });
  }

  /** Whether an error badge should be shown (suppressed if a replace is ok/pending). */
  function shouldShowReplaceError(original) {
    const key = TP.normUrl(original);
    if (!key) return true;
    const s = replaceStateByOriginal.get(key);
    if (!s) return true;
    if (s.state === "ok") return false;
    if (s.state === "pending" && Date.now() - s.ts < 12000) return false;
    return true;
  }

  /** Mark the `replaceStateByOriginal` entry (used by overlay.js on img load/error). */
  function setReplaceState(key, state) {
    if (key) replaceStateByOriginal.set(key, { state, ts: Date.now() });
  }

  // --- Right-click + recent-URL tracking ----------------------------------
  let lastRightClick = { img: null, ts: 0, urls: [] };
  const recentImgByUrl = new Map();

  function rememberImgUrls(img, urls) {
    const ts = Date.now();
    for (const u of urls || []) {
      const k = TP.normUrl(u);
      if (k) recentImgByUrl.set(k, { img, ts });
    }
    // Bound the map size.
    if (recentImgByUrl.size > 200) {
      const cutoff = ts - 5 * 60 * 1000;
      for (const [k, v] of recentImgByUrl.entries()) {
        if (!v?.img || !v.img.isConnected || (v.ts || 0) < cutoff) recentImgByUrl.delete(k);
      }
      while (recentImgByUrl.size > 220) recentImgByUrl.delete(recentImgByUrl.keys().next().value);
    }
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      const img = e?.target?.closest ? e.target.closest("img") : null;
      if (!img) return;
      const urls = [img.currentSrc, img.src, TP.getBestImgUrl(img)]
        .filter(Boolean)
        .map(TP.normUrl)
        .filter(Boolean);
      if (urls[0] && img?.dataset) img.dataset.tpOriginal = urls[0];
      lastRightClick = { img, ts: Date.now(), urls };
      rememberImgUrls(img, urls);
    },
    true,
  );

  const getLastRightClick = () => lastRightClick;

  /**
   * Resolve the `<img>` a result belongs to, trying (in order): MangaDex key,
   * `data-tp-original`, recent-URL map, the last right-clicked image, then a
   * direct `src`/`currentSrc` scan.
   */
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

    if (lastRightClick.img && Date.now() - lastRightClick.ts < 8000) {
      if (!o || (lastRightClick.urls || []).includes(o)) return lastRightClick.img;
    }

    for (const img of images()) {
      if (o && (TP.normUrl(img.currentSrc) === o || TP.normUrl(img.src) === o)) return img;
    }
    return null;
  }

  /** Draw a red outline + ⚠️ badge on an image that failed to translate. */
  function markImageError(original, msg) {
    if (!shouldShowReplaceError(original)) return;

    const img = findTargetImage(original);
    if (!img || img.dataset.lensError) return;

    // Skip if the image was already replaced (success despite a late error).
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

  Object.assign(TP, {
    noteReplaceState,
    shouldShowReplaceError,
    setReplaceState,
    rememberImgUrls,
    getLastRightClick,
    findTargetImage,
    markImageError,
  });
})();
