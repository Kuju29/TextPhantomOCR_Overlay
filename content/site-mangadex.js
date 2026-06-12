/**
 * MangaDex site adapter — ALL MangaDex-specific page knowledge lives here.
 *
 * Why a dedicated file: sites like MangaDex need special handling (the page
 * URL changes as the user scrolls, page <img>s are blob: URLs, real image
 * URLs must come from the site's own API) — keeping that knowledge in one
 * adapter makes it easy to add similar sites later without touching the
 * generic pipeline.
 *
 * What the reader's DOM looks like (confirmed from a live page):
 *
 *   /chapter/<chapterId>/<page>        <- <page> changes while scrolling;
 *                                         only <chapterId> identifies content
 *   <div class="md--page">
 *     <img class="img" alt="s1-86e16036....jpg"     <- EXACT at-home filename!
 *          src="blob:https://mangadex.org/...">     <- useless for the server
 *
 * The `alt` attribute IS the filename from the at-home API file list, so
 * blob <-> file mapping is exact — no index guessing.
 *
 * Exposed on TP (all consumers use optional calls, so this file is purely
 * additive — if it fails to load, the old behaviour remains):
 *   - mdSiteManifest(force)  -> chapter manifest from the at-home API
 *   - mdSiteMapDom()         -> stamp every page <img> with its real URL/key
 *   - mdSiteCollect(mode, lang) -> payloads for "translate all images",
 *        each carrying the image BYTES (fetched in the page context / canvas)
 *        so the backend never has to download from mangadex.network itself.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  if (!/(^|\.)mangadex\.org$/i.test(String(location.hostname || ""))) return;

  const API_BASE = "https://api.mangadex.org";
  const MANIFEST_TTL_MS = 180000;
  // Soft cap on total bytes inlined into one GET_IMAGES response.
  const MAX_INLINE_BYTES = 48 * 1024 * 1024;

  /** @type {null | {chapterId: string, ts: number, files: Array<object>, byAlt: Map<string, object>, primary: Array<object>}} */
  let man = null;

  const getChapterId = () =>
    (String(location.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i) || [])[1] || "";

  /**
   * Fetch (and cache per chapter) the at-home manifest.
   * Each file record: { path, file, index, url, key } where
   * key = `md:<path>/<hash>/<file>` (the stable identity used everywhere).
   * @param {boolean} [force]
   */
  async function mdSiteManifest(force = false) {
    const id = getChapterId();
    if (!id) return null;
    const now = Date.now();
    if (!force && man && man.chapterId === id && now - man.ts < MANIFEST_TTL_MS) {
      return man;
    }
    try {
      const res = await fetch(`${API_BASE}/at-home/server/${id}`, { credentials: "omit" });
      if (!res.ok) throw new Error(`at-home ${res.status}`);
      const j = await res.json();
      const baseUrl = j?.baseUrl;
      const hash = j?.chapter?.hash;
      const data = Array.isArray(j?.chapter?.data) ? j.chapter.data : [];
      const saver = Array.isArray(j?.chapter?.dataSaver) ? j.chapter.dataSaver : [];
      if (!baseUrl || !hash || (!data.length && !saver.length)) {
        throw new Error("unexpected at-home shape");
      }
      const files = [];
      const byAlt = new Map();
      const add = (path, list) => {
        list.forEach((file, index) => {
          const rec = {
            path,
            file,
            index,
            url: `${baseUrl}/${path}/${hash}/${file}`,
            key: `md:${path}/${hash}/${file}`,
          };
          files.push(rec);
          byAlt.set(String(file), rec);
        });
      };
      add("data", data);
      add("data-saver", saver);
      man = {
        chapterId: id,
        ts: now,
        files,
        byAlt,
        primary: files.filter((f) => f.path === (data.length ? "data" : "data-saver")),
      };
      TP.log.info("md-adapter manifest", { chapter: id, data: data.length, saver: saver.length });
      return man;
    } catch (e) {
      TP.log.warn("md-adapter manifest failed", e?.message || e);
      return null;
    }
  }

  /** All reader page <img> elements currently in the DOM. */
  const pageImgs = () => Array.from(document.querySelectorAll(".md--page img"));

  /**
   * Stamp every page <img> with its real at-home URL + md key by EXACT
   * alt-to-filename matching. Returns the number of images mapped.
   */
  async function mdSiteMapDom() {
    const m = await mdSiteManifest();
    if (!m) return 0;
    let mapped = 0;
    for (const img of pageImgs()) {
      const rec = m.byAlt.get(String(img.getAttribute("alt") || "").trim());
      if (!rec) continue;
      if (img.dataset.tpOriginal !== rec.url) img.dataset.tpOriginal = rec.url;
      if (img.dataset.tpOriginalKey !== rec.key) img.dataset.tpOriginalKey = rec.key;
      img.dataset.tpMdPage = String(rec.index + 1);
      mapped++;
    }
    return mapped;
  }

  /**
   * Resolve one page's bytes IN THE TAB (the site's own API/cache):
   * 1. page-context fetch of the at-home URL — Origin is mangadex.org and the
   *    reader has usually cached these bytes already;
   * 2. canvas grab from the rendered <img> (blob is same-origin, not tainted).
   * @returns {Promise<string>} data URI, or "" when unavailable
   */
  async function bytesForRecord(rec, img) {
    try {
      const res = await fetch(rec.url, { credentials: "omit", cache: "force-cache" });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size >= 64) {
          const du = await TP.blobToDataUri(blob);
          if (du) return du;
        }
      }
    } catch {
      /* fall through to canvas */
    }
    if (img) {
      const du = await TP.getImageDataUriFromElement(img).catch(() => "");
      if (du) return du;
    }
    return "";
  }

  /**
   * Build "translate all images" payloads for the whole chapter.
   *
   * - One payload per page, in chapter order, src = real at-home URL.
   * - Bytes are attached (`imageDataUri`) so the server never downloads from
   *   mangadex.network (its datacenter IP gets rejected -> the 404s).
   * - The variant (data / data-saver) follows what the reader is showing, so
   *   cache keys match the right-click flow.
   */
  async function mdSiteCollect(mode, lang) {
    const m = await mdSiteManifest();
    if (!m) return [];
    await mdSiteMapDom();

    const domByKey = new Map();
    for (const img of pageImgs()) {
      const key = String(img.dataset.tpOriginalKey || "");
      if (key && !domByKey.has(key)) domByKey.set(key, img);
    }

    // Use the file-list variant the reader is actually displaying.
    const usedPaths = new Set(
      [...domByKey.keys()].map((k) => k.replace(/^md:/, "").split("/")[0]),
    );
    const list =
      usedPaths.size === 1
        ? m.files.filter((f) => f.path === [...usedPaths][0])
        : m.primary;

    const out = [];
    let inlined = 0;
    for (const rec of list) {
      const img = domByKey.get(rec.key) || null;
      let dataUri = "";
      if (inlined < MAX_INLINE_BYTES) {
        dataUri = await bytesForRecord(rec, img);
        inlined += dataUri.length;
      }
      const payload = TP.buildPayload(
        {
          original_image_url: rec.url,
          position: img ? TP.buildPositionFromElement(img) : null,
          imageDataUri: dataUri || null,
        },
        mode,
        lang,
        "page_scan",
        "collected_mangadex_adapter",
      );
      if (payload) out.push(payload);
    }
    TP.log.info("md-adapter collect", {
      pages: out.length,
      withBytes: out.filter((p) => p.imageDataUri).length,
    });
    return out;
  }

  Object.assign(TP, { mdSiteManifest, mdSiteMapDom, mdSiteCollect });
})();
