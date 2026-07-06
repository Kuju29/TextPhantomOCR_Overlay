/**
 * MangaDex-specific content-script logic.
 *
 * MangaDex is a single-page reader that serves pages as blob: URLs whose
 * identity changes. To translate reliably we:
 * - map each `<img>` to a stable `md:` key (data/hash/file path from the
 *   chapter's at-home URL list),
 * - keep a parallel set of overlays keyed by `md:` key (so they survive blob
 *   churn),
 * - hydrate cached results from the service worker when a chapter loads,
 * - remember "pending" applies for images that aren't in the DOM yet.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // --- Host / URL helpers --------------------------------------------------

  const isMangaDexHost = () => /(^|\.)mangadex\.org$/i.test(String(location.hostname || ""));

  /** Build a stable `md:data/hash/file` key from any at-home image URL. */
  function mdKeyFromUrl(u) {
    const s = TP.normUrl(u);
    if (!s) return "";
    try {
      const parts = String(new URL(s, location.href).pathname || "")
        .split("/")
        .filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i] === "data" || parts[i] === "data-saver") {
          if (parts.length >= i + 3) return `md:${parts[i]}/${parts[i + 1]}/${parts[i + 2]}`;
          break;
        }
      }
      return "";
    } catch {
      return "";
    }
  }

  function getMangaDexChapterId() {
    const m = String(location.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i);
    return m ? m[1] : "";
  }

  /** Best-effort current page index from the URL (path / query / hash). */
  function getMangaDexPageIndexFromUrl() {
    const parts = String(location.pathname || "").split("/").filter(Boolean);
    const ci = parts.indexOf("chapter");
    if (ci >= 0 && parts.length >= ci + 3 && /^\d+$/.test(parts[ci + 2])) {
      return Math.max(0, Number(parts[ci + 2]) - 1);
    }
    try {
      const qs = new URLSearchParams(String(location.search || ""));
      const q = qs.get("page") || qs.get("p");
      if (q && /^\d+$/.test(q)) return Math.max(0, Number(q) - 1);
    } catch {
      /* ignore */
    }
    const hm = String(location.hash || "").match(/(?:^|[?#&])page=(\d+)/i);
    return hm ? Math.max(0, Number(hm[1]) - 1) : null;
  }

  // --- "Pending apply" memory ---------------------------------------------
  // Results that arrive before their <img> exists in the DOM are parked here,
  // keyed by md key, and applied by `mdApplyOriginalToImg` once the image maps.
  const mdPendingByOriginal = new Map();

  function mdPendingTrim(maxSize = 80) {
    if (mdPendingByOriginal.size <= maxSize) return;
    const items = [...mdPendingByOriginal.entries()].sort(
      (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
    );
    for (let i = 0; i < items.length - maxSize; i++) mdPendingByOriginal.delete(items[i][0]);
  }

  function mdRememberPending(original, patch) {
    const key = mdKeyFromUrl(original) || TP.normUrl(original);
    if (!key) return;
    mdPendingByOriginal.set(key, {
      ...(mdPendingByOriginal.get(key) || {}),
      ...(patch || {}),
      ts: Date.now(),
    });
    mdPendingTrim();
  }

  function mdTakePending(key) {
    const v = mdPendingByOriginal.get(key);
    if (v) mdPendingByOriginal.delete(key);
    return v || null;
  }

  // --- Chapter URL list (MangaDex at-home API) ----------------------------
  const MD_CACHE_TTL_MS = 180000;
  let mdCache = null;

  /** Fetch (and cache) the ordered image URL list for the current chapter. */
  async function fetchMangaDexChapterUrls() {
    if (!isMangaDexHost()) return null;
    const chapterId = getMangaDexChapterId();
    if (!chapterId) return null;

    const now = Date.now();
    if (
      mdCache &&
      mdCache.chapterId === chapterId &&
      now - (mdCache.ts || 0) < MD_CACHE_TTL_MS &&
      Array.isArray(mdCache.urls) &&
      mdCache.urls.length
    ) {
      return mdCache;
    }

    try {
      const res = await fetch(`https://api.mangadex.org/at-home/server/${chapterId}`, {
        credentials: "omit",
      });
      if (!res.ok) throw new Error(`MangaDex API ${res.status}`);
      const info = await res.json();

      const baseUrl = info?.baseUrl;
      const hash = info?.chapter?.hash;
      const data = Array.isArray(info?.chapter?.data) ? info.chapter.data : [];
      const dataSaver = Array.isArray(info?.chapter?.dataSaver) ? info.chapter.dataSaver : [];

      let path = "data";
      let files = data;
      if (!files.length && dataSaver.length) {
        path = "data-saver";
        files = dataSaver;
      }
      if (!baseUrl || !hash || !files.length) throw new Error("Unexpected MangaDex API shape");

      mdCache = {
        chapterId,
        ts: now,
        path,
        urls: files.map((file) => `${baseUrl}/${path}/${hash}/${file}`),
      };
      return mdCache;
    } catch (e) {
      TP.log.warn("MangaDex API error", e?.message || e);
      mdCache = { chapterId, ts: now, urls: [], path: "data" };
      return null;
    }
  }

  // --- Service-worker result cache ----------------------------------------

  /** Ask the SW for cached results for a set of md keys. */
  const mdCacheGet = (keys, includeNewImg = false, lang = "", mode = "") =>
    TP.sendBg({ type: "TP_MD_CACHE_GET", keys, includeNewImg: !!includeNewImg, lang, mode });

  /** Resolve just the cached "new image" URL for one md key. */
  async function mdCacheGetNewImg(key, lang, mode) {
    const resp = await mdCacheGet([key], true, lang, mode);
    const rec = resp?.items?.[key] || null;
    return (
      rec?.newImg ||
      TP.extractNewImageSrc(rec?.result || null) ||
      TP.extractNewImageSrc(rec || null) ||
      null
    );
  }

  /** Apply a cached "new image" to an md-keyed image (overlay or in-place). */
  function mdApplyCachedNewImg(originalUrl, key, isTextMode, imgElement, lang, mode) {
    mdCacheGetNewImg(key, lang, mode).then((newSrc) => {
      if (!newSrc) return;
      if (isTextMode) {
        const mdKey = mdKeyFromUrl(originalUrl);
        if (!mdKey) return;
        const rec =
          mdHtmlOverlaysByKey.get(mdKey) ||
          (() => {
            const rect = imgElement.getBoundingClientRect();
            const r = upsertMangaDexHtmlOverlay(
              mdKey,
              imgElement,
              Math.max(1, rect.width),
              Math.max(1, rect.height),
              "badge",
            );
            r.scope.textContent = "";
            return r;
          })();
        rec.isTextMode = true;
        TP.updateCleanLayer(rec, imgElement, newSrc);
        scheduleMangaDexOverlayUpdate();
        return;
      }
      TP.replaceImageInDOM(originalUrl, newSrc).then((applied) => {
        if (!applied) {
          mdRememberPending(originalUrl, {
            needNewImg: true,
            needMode: "replace",
            needLang: lang,
            needCacheMode: mode,
          });
        }
      });
    });
  }

  /** On chapter load, render anything the SW already has cached. */
  async function hydrateMangaDexFromCache() {
    if (!isMangaDexHost() || !TP.isTop) return null;

    const info = await fetchMangaDexChapterUrls();
    const urls = info?.urls;
    if (!Array.isArray(urls) || !urls.length) return null;

    const pairs = urls.map((u) => ({ url: u, key: mdKeyFromUrl(u) })).filter((p) => p.key);
    const keys = [...new Set(pairs.map((p) => p.key))].slice(0, 600);
    if (!keys.length) return null;

    const st = await TP.getSettings();
    const resp = await mdCacheGet(keys, false, st.lang, st.mode);
    const items = resp?.items || null;
    if (!items) return null;

    const isText = String(st.mode || "lens_text") === "lens_text";
    const source = isText ? String(st.sources || "translated") : "translated";

    for (const p of pairs) {
      const rec = items[p.key];
      if (!rec) continue;

      if (rec.result) {
        const img = TP.findTargetImage(p.url);
        if (img) TP.applyHtmlOverlay(img, rec.result, source, isText, p.url);
        else mdRememberPending(p.url, { overlay: { result: rec.result, source, isTextMode: isText } });
      }

      const hasNewImg =
        Boolean(rec?.hasNewImg) ||
        Boolean(rec?.newImg) ||
        Boolean(TP.extractNewImageSrc(rec?.result || null));
      if (hasNewImg) {
        const img = TP.findTargetImage(p.url);
        if (img) mdApplyCachedNewImg(p.url, p.key, isText, img, st.lang, st.mode);
        else
          mdRememberPending(p.url, {
            needNewImg: true,
            needMode: isText ? "clean" : "replace",
            needLang: st.lang,
            needCacheMode: st.mode,
          });
      }
    }
    return { pairs, items };
  }

  // --- DOM image ↔ chapter-index mapping ----------------------------------

  function isProbableMangaDexPageImage(img) {
    if (!img || !img.getBoundingClientRect) return false;
    const u = String(TP.getBestImgUrl(img) || "");
    if (!u) return false;
    const rect = img.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < 65000 && (rect.width < 260 || rect.height < 260)) return false;
    if (u.startsWith("blob:") || u.startsWith("data:")) return true;
    return /mangadex\.network|uploads\.mangadex\.org/i.test(u);
  }

  function getMangaDexPageImagesInDOM() {
    const nodes = Array.from(document.querySelectorAll(".md--page img"));
    const imgs = nodes.length ? nodes : Array.from(document.images || []);
    return imgs.filter(isProbableMangaDexPageImage);
  }

  /** Guess a page index for an image from alt text / data attributes / URL. */
  function inferMangaDexPageIndexForImg(img) {
    const alt = String(img?.getAttribute?.("alt") || img?.getAttribute?.("aria-label") || "");
    const patterns = [/^\s*(\d+)\s*[-_]/, /(?:^|\D)(\d+)\s*\/\s*(\d+)/, /page\s*(\d+)/i];
    for (const re of patterns) {
      const m = alt.match(re);
      if (m) return Math.max(0, Number(m[1]) - 1);
    }

    const tpPage =
      img?.dataset?.tpMdPage ||
      (typeof img?.getAttribute === "function" ? img.getAttribute("data-tp-md-page") : "");
    if (tpPage && /^\d+$/.test(String(tpPage))) return Math.max(0, Number(tpPage) - 1);

    for (const src of [String(img?.dataset?.tpOriginalKey || ""), String(img?.dataset?.tpOriginal || "")]) {
      const m = src.match(/\/(\d+)\s*[-_]/);
      if (m) return Math.max(0, Number(m[1]) - 1);
    }

    const direct =
      img?.getAttribute?.("data-page") || img?.dataset?.page || img?.dataset?.pageIndex || "";
    if (direct && /^\d+$/.test(String(direct))) return Math.max(0, Number(direct) - 1);

    const near = img?.closest?.("[data-page]")?.getAttribute?.("data-page") || "";
    if (near && /^\d+$/.test(String(near))) return Math.max(0, Number(near) - 1);

    return null;
  }

  /**
   * Flush any result that arrived BEFORE this image existed / was mapped.
   * Called from both mapping paths (site adapter + legacy index inference) —
   * whichever stamps an image must also deliver its parked results, or a
   * batch run in page-by-page reading mode never renders anything.
   */
  function mdFlushPendingFor(img, key, url) {
    if (!img || !key) return;
    const pending = mdTakePending(key);
    if (!pending) return;
    TP.log.info("md pending flushed", { key });
    if (pending.newSrc) TP.replaceImageInDOM(url, pending.newSrc).catch(() => {});
    if (pending.cleanSrc) {
      const rec =
        mdHtmlOverlaysByKey.get(key) ||
        (() => {
          const rect = img.getBoundingClientRect();
          const r = upsertMangaDexHtmlOverlay(
            key,
            img,
            Math.max(1, rect.width),
            Math.max(1, rect.height),
            "badge",
          );
          r.scope.textContent = "";
          return r;
        })();
      rec.isTextMode = true;
      TP.updateCleanLayer(rec, img, pending.cleanSrc);
      scheduleMangaDexOverlayUpdate();
    }
    if (pending.overlay) {
      try {
        TP.applyHtmlOverlay(img, pending.overlay.result, pending.overlay.source, pending.overlay.isTextMode, url);
      } catch {
        /* ignore */
      }
    }
    if (pending.needNewImg) {
      mdApplyCachedNewImg(url, key, pending.needMode === "clean", img, pending.needLang, pending.needCacheMode);
    }
  }

  /** Stamp an image with its resolved at-home URL/key and flush pending applies. */
  function mdApplyOriginalToImg(img, idx, urls) {
    if (!img || !Array.isArray(urls) || idx == null || idx < 0 || idx >= urls.length) return;
    const url = TP.normUrl(urls[idx]);
    if (!url) return;
    const key = mdKeyFromUrl(url) || url;

    if (img.dataset.tpOriginalKey !== key) img.dataset.tpOriginalKey = key;
    if (TP.normUrl(img.dataset.tpOriginal) !== url) img.dataset.tpOriginal = url;
    img.dataset.tpMdPage = String(idx + 1);

    mdFlushPendingFor(img, key, url);
  }

  /** Map every MangaDex page image in the DOM to its chapter index. */
  async function ensureMangaDexDomMapping() {
    if (!isMangaDexHost()) return;

    // SPA chapter switch? Clear the previous chapter's overlays/stamps first
    // so nothing below re-attaches stale results to reused elements.
    mdCheckChapterChange();

    // Site adapter first: exact alt-to-filename mapping (the reader sets
    // img.alt to the at-home filename). The legacy index inference below
    // stays as a fallback for any image the adapter could not match.
    if (typeof TP.mdSiteMapDom === "function") {
      try {
        await TP.mdSiteMapDom();
      } catch {
        /* fall through to legacy inference */
      }
    }

    const urls = (await fetchMangaDexChapterUrls())?.urls || [];
    for (const img of getMangaDexPageImagesInDOM()) {
      const key = String(img.dataset.tpOriginalKey || "");
      if (key) {
        // Mapped (by the adapter or earlier) — still flush parked results so
        // a page that appears AFTER its translation arrived gets rendered.
        mdFlushPendingFor(img, key, TP.normUrl(img.dataset.tpOriginal || ""));
        continue;
      }
      if (!urls.length) continue;
      const idx = inferMangaDexPageIndexForImg(img);
      if (idx != null) mdApplyOriginalToImg(img, idx, urls);
    }
  }

  let mdMappingScheduled = false;
  function scheduleMangaDexMapping() {
    if (!isMangaDexHost() || mdMappingScheduled) return;
    mdMappingScheduled = true;
    setTimeout(() => {
      mdMappingScheduled = false;
      ensureMangaDexDomMapping()
        .then(() => {
          if (mdOverlaysByKey.size) scheduleMangaDexOverlayUpdate();
        })
        .catch(() => {});
    }, 60);
  }

  /** Resolve a blob: URL to its real at-home URL (for the context menu). */
  async function resolveMangaDexOriginalForBlob(blobUrl) {
    if (!isMangaDexHost() || !blobUrl?.startsWith("blob:")) return null;
    scheduleMangaDexMapping();
    const urls = (await fetchMangaDexChapterUrls())?.urls || [];
    if (!urls.length) return null;

    const img = Array.from(document.images || []).find((i) => (i.currentSrc || i.src) === blobUrl);
    if (!img) return null;
    if (img.dataset.tpOriginal) return TP.normUrl(img.dataset.tpOriginal);

    const byAlt = inferMangaDexPageIndexForImg(img);
    if (byAlt != null) {
      mdApplyOriginalToImg(img, byAlt, urls);
      return TP.normUrl(img.dataset.tpOriginal);
    }
    const byUrl = getMangaDexPageIndexFromUrl();
    if (byUrl != null) {
      mdApplyOriginalToImg(img, byUrl, urls);
      return TP.normUrl(img.dataset.tpOriginal);
    }
    const pos = getMangaDexPageImagesInDOM().indexOf(img);
    if (pos >= 0) {
      mdApplyOriginalToImg(img, pos, urls);
      return TP.normUrl(img.dataset.tpOriginal);
    }
    return null;
  }

  // --- MangaDex overlay set ------------------------------------------------
  // mdOverlaysByKey:   md key -> { el, img, blobUrl, original }  (replaced <img>)
  // mdHtmlOverlaysByKey: md key -> { host, scope, img, baseW, baseH, kind }
  const mdOverlaysByKey = new Map();
  const mdHtmlOverlaysByKey = new Map();
  let mdOverlayRaf = 0;

  // Overlay font scale (the popup's Display slider). overlay.js owns the
  // setting and forwards every change here, because MangaDex overlays live in
  // their own map — without this hook the slider has no effect on MangaDex.
  let mdFontScale = 1;
  function mdApplyFontScaleAll(scale) {
    const s = Number(scale);
    if (Number.isFinite(s) && s > 0) mdFontScale = s;
    for (const rec of mdHtmlOverlaysByKey.values()) {
      rec?.scope?.style?.setProperty("--tp-font-scale", String(mdFontScale));
    }
  }

  // --- Chapter-change cleanup ----------------------------------------------
  // MangaDex is an SPA: switching chapters swaps blob srcs but often REUSES
  // the same <img> elements and .md--page containers. Without cleanup the
  // previous chapter's overlays keep tracking those reused elements (their
  // stale data-tp-* keys still match) and render the old translation on top
  // of the new chapter until the user presses F5.
  let mdCurrentChapterId = getMangaDexChapterId();

  function mdDestroyAllOverlays() {
    for (const rec of mdOverlaysByKey.values()) {
      try {
        if (rec?.blobUrl?.startsWith("blob:")) URL.revokeObjectURL(rec.blobUrl);
      } catch {
        /* already revoked */
      }
      try {
        rec?.el?.remove();
      } catch {
        /* detached */
      }
    }
    mdOverlaysByKey.clear();
    for (const rec of mdHtmlOverlaysByKey.values()) {
      try {
        rec?.host?.remove();
      } catch {
        /* detached */
      }
    }
    mdHtmlOverlaysByKey.clear();
  }

  /** Drop stale data-tp-* stamps so reused <img>s get remapped cleanly. */
  function mdClearImgStamps() {
    for (const img of Array.from(document.images || [])) {
      const ds = img?.dataset;
      if (!ds) continue;
      if (ds.tpOriginalKey || ds.tpOriginal || ds.tpMdPage) {
        delete ds.tpOriginalKey;
        delete ds.tpOriginal;
        delete ds.tpMdPage;
      }
    }
  }

  /**
   * Detect chapter navigation and wipe every per-chapter artifact: overlays,
   * parked results, the URL-list cache and stale <img> stamps. Cached
   * translations for the NEW chapter re-render via the delayed hydrate, so
   * revisiting a translated chapter needs no F5.
   * @returns {boolean} true when a chapter change was handled
   */
  function mdCheckChapterChange() {
    const id = getMangaDexChapterId();
    if (!id || id === mdCurrentChapterId) return false;
    TP.log.info("md chapter changed", { from: mdCurrentChapterId, to: id });
    mdCurrentChapterId = id;
    mdCache = null;
    mdPendingByOriginal.clear();
    mdDestroyAllOverlays();
    mdClearImgStamps();
    setTimeout(() => {
      hydrateMangaDexFromCache().catch(() => {});
    }, 350);
    return true;
  }

  const findMangaDexImgByKey = (key) =>
    key
      ? Array.from(document.images || []).find(
          (img) => String(img.dataset.tpOriginalKey || "") === key,
        ) || null
      : null;

  const mdGetKeyForImg = (img) =>
    String(img?.dataset?.tpOriginalKey || "") || mdKeyFromUrl(String(img?.dataset?.tpOriginal || ""));

  /** Re-position every MangaDex overlay (called from rAF). */
  function updateMangaDexOverlays() {
    if (!mdOverlaysByKey.size && !mdHtmlOverlaysByKey.size) return;

    // Replaced-image overlays (non-text mode).
    for (const [key, rec] of mdOverlaysByKey.entries()) {
      const el = rec?.el;
      if (!el) {
        mdOverlaysByKey.delete(key);
        continue;
      }
      let img = rec.img;
      if (img && img.isConnected) {
        // The reader reuses <img> elements across chapters — if this one was
        // re-stamped with a different key, it no longer belongs to us.
        const dsKey = String(img.dataset.tpOriginalKey || "");
        if (dsKey && dsKey !== key) img = null;
      }
      if (!img || !img.isConnected) img = findMangaDexImgByKey(key);
      if (!img) {
        el.style.display = "none";
        rec.img = null;
        continue;
      }
      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        el.style.display = "none";
        rec.img = img;
        continue;
      }
      rec.img = img;
      Object.assign(el.style, {
        display: "block",
        left: `${r.left + window.scrollX}px`,
        top: `${r.top + window.scrollY}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    }

    // HTML overlays (text mode).
    for (const [key, rec] of mdHtmlOverlaysByKey.entries()) {
      const { host, scope } = rec || {};
      if (!host || !scope) {
        mdHtmlOverlaysByKey.delete(key);
        continue;
      }
      let img = rec.img;
      if (img && img.isConnected) {
        // Same reuse guard as above: a re-stamped element belongs to another
        // page/chapter now, never draw this overlay on top of it.
        const dsKey = String(img.dataset.tpOriginalKey || "");
        if (dsKey && dsKey !== key) img = null;
      }
      if (!img || !img.isConnected) img = findMangaDexImgByKey(key);
      if (!img) {
        host.style.display = "none";
        rec.img = null;
        continue;
      }
      const curKey = mdKeyFromUrl(TP.getBestImgUrl(img));
      if (curKey && curKey !== key) {
        host.style.display = "none";
        rec.img = null;
        continue;
      }
      const parent = TP.ensureOverlayHostMountedNearImage(rec, img);
      if (!parent) {
        host.style.display = "none";
        rec.img = img;
        continue;
      }
      const { r, left, top } = TP.getOverlayBoxFromParent(img, parent);
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

      const { nw, nh, sx, sy, offX, offY, transform, transformOrigin } = TP.computeScale(
        img,
        rec.baseW,
        rec.baseH,
        true,
      );
      scope.style.width = `${nw}px`;
      scope.style.height = `${nh}px`;
      scope.style.transform = `translate(${offX}px, ${offY}px) scale(${sx}, ${sy})`;
      scope.style.transformOrigin = "0 0";
      if (transform && transform !== "none") {
        host.style.transform = transform;
        host.style.transformOrigin = transformOrigin || "0 0";
      } else {
        host.style.transform = "";
        host.style.transformOrigin = "";
      }
    }
  }

  function scheduleMangaDexOverlayUpdate() {
    if (mdOverlayRaf) return;
    mdOverlayRaf = requestAnimationFrame(() => {
      mdOverlayRaf = 0;
      updateMangaDexOverlays();
    });
  }
  const mdScheduleUpdate = scheduleMangaDexOverlayUpdate;

  function ensureMangaDexOverlayListeners() {
    if (window.__tpMdOverlayListeners) return;
    window.__tpMdOverlayListeners = true;
    window.addEventListener("scroll", scheduleMangaDexOverlayUpdate, { passive: true });
    window.addEventListener("resize", scheduleMangaDexOverlayUpdate, { passive: true });
    try {
      new MutationObserver(() => scheduleMangaDexOverlayUpdate()).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "data-srcset", "style", "class"],
      });
    } catch {
      /* unsupported */
    }
  }

  /** Get or create a MangaDex HTML overlay record. */
  function upsertMangaDexHtmlOverlay(mdKey, img, baseW, baseH, kind) {
    let rec = mdHtmlOverlaysByKey.get(mdKey);
    if (!rec) {
      const host = document.createElement("div");
      host.className = "tp-ol-root";
      host.style.zIndex = 2147483647;
      host.style.pointerEvents = "none";
      host.style.display = "none";
      const scope = document.createElement("div");
      scope.className = "tp-ol-scope";
      // Seed the font-scale variable so a new overlay respects the slider
      // immediately (every .tp-line reads calc(var(--tp-font-scale,1) * Npx)).
      scope.style.setProperty("--tp-font-scale", String(mdFontScale));
      host.appendChild(scope);
      rec = { host, scope, img: null, baseW: 1, baseH: 1, kind: "html" };
      mdHtmlOverlaysByKey.set(mdKey, rec);
      ensureMangaDexOverlayListeners();
    }
    if (img) TP.ensureOverlayHostMountedNearImage(rec, img);
    rec.img = img;
    rec.baseW = Number.isFinite(baseW) && baseW > 0 ? baseW : 1;
    rec.baseH = Number.isFinite(baseH) && baseH > 0 ? baseH : 1;
    rec.kind = kind || "html";
    return rec;
  }

  function hideMangaDexHtmlOverlay(mdKey) {
    const rec = mdHtmlOverlaysByKey.get(mdKey);
    if (rec?.cleanImg) rec.cleanImg.style.display = "none";
    if (rec?.host) rec.host.style.display = "none";
  }

  /** Replace a MangaDex image by overlaying a translated `<img>` on top of it. */
  async function replaceMangaDexImageWithOverlay(original, newSrc) {
    const mdKey = mdKeyFromUrl(original);
    if (!mdKey) return 0;

    const img = findMangaDexImgByKey(mdKey) || TP.findTargetImage(original);
    if (!img) {
      TP.log.warn("REPLACE_IMAGE target not found", { original: TP.truncate(original) });
      return 0;
    }

    img.dataset.tpOriginalKey = mdKey;
    const key = TP.normUrl(original);
    if (key) img.dataset.tpOriginal = key;
    TP.noteReplaceState(original, "pending");

    let rec = mdOverlaysByKey.get(mdKey);
    if (!rec) {
      const el = document.createElement("img");
      el.decoding = "sync";
      el.loading = "eager";
      Object.assign(el.style, {
        position: "absolute",
        zIndex: 2147483647,
        pointerEvents: "none",
        objectFit: "contain",
        maxWidth: "none",
        maxHeight: "none",
        display: "none",
      });
      document.documentElement.appendChild(el);
      rec = { el, img: null, blobUrl: "", original: "" };
      mdOverlaysByKey.set(mdKey, rec);
      ensureMangaDexOverlayListeners();
      el.addEventListener(
        "load",
        () => rec.original && TP.setReplaceState(rec.original, "ok"),
        { passive: true },
      );
      el.addEventListener(
        "error",
        () => {
          if (rec.original) {
            TP.setReplaceState(rec.original, "fail");
            TP.markImageError(rec.original, "Failed to load replaced image");
          }
        },
        { passive: true },
      );
    }

    rec.img = img;
    rec.original = TP.normUrl(original);

    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await TP.dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }
    if (rec.blobUrl && rec.blobUrl.startsWith("blob:") && rec.blobUrl !== nextSrc) {
      try {
        URL.revokeObjectURL(rec.blobUrl);
      } catch {
        /* already revoked */
      }
    }
    rec.blobUrl = typeof nextSrc === "string" && nextSrc.startsWith("blob:") ? nextSrc : "";
    rec.el.src = nextSrc;

    scheduleMangaDexOverlayUpdate();
    return 1;
  }

  // --- MangaDex SPA observers ---------------------------------------------
  if (isMangaDexHost() && TP.isTop) {
    scheduleMangaDexMapping();
    try {
      new MutationObserver(() => scheduleMangaDexMapping()).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "alt", "aria-label"],
      });
      const onNav = () => {
        mdCache = null;
        // Immediate cleanup on chapter switch — do not wait for the 60ms
        // mapping debounce, or old overlays flash over the new chapter.
        mdCheckChapterChange();
        scheduleMangaDexMapping();
      };
      window.addEventListener("popstate", onNav);
      window.addEventListener("hashchange", onNav);
      if (!history.__tpMdPatched) {
        history.__tpMdPatched = true;
        for (const name of ["pushState", "replaceState"]) {
          const orig = history[name];
          history[name] = function (...args) {
            const r = orig.apply(this, args);
            onNav();
            return r;
          };
        }
      }
    } catch {
      /* observer/history patch unsupported */
    }
  }

  Object.assign(TP, {
    isMangaDexHost,
    mdKeyFromUrl,
    mdRememberPending,
    fetchMangaDexChapterUrls,
    hydrateMangaDexFromCache,
    getMangaDexPageImagesInDOM,
    ensureMangaDexDomMapping,
    scheduleMangaDexMapping,
    resolveMangaDexOriginalForBlob,
    mdGetKeyForImg,
    upsertMangaDexHtmlOverlay,
    hideMangaDexHtmlOverlay,
    scheduleMangaDexOverlayUpdate,
    replaceMangaDexImageWithOverlay,
    mdApplyFontScaleAll,
  });
})();
