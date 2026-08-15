// MangaDex site adapter: resolves real page URLs and bytes from the site's own API.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  if (!/(^|\.)mangadex\.org$/i.test(String(location.hostname || ""))) return;

  const API_BASE = "https://api.mangadex.org";
  const MANIFEST_TTL_MS = 180000;
  const MAX_INLINE_BYTES = 48 * 1024 * 1024;

  let man = null;

  const getChapterId = () =>
    (String(location.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i) || [])[1] || "";

  // Fetches and caches the chapter's at-home file manifest.
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

  const pageImgs = () => Array.from(document.querySelectorAll(".md--page img"));

  // Stamps each page image with its at-home URL and key; the img alt attribute is the at-home filename.
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

  // Returns one page's bytes as a data URI, fetched in the tab or read off the rendered image.
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
    }
    if (img) {
      const du = await TP.getImageDataUriFromElement(img).catch(() => "");
      if (du) return du;
    }
    return "";
  }

  // Builds one payload per chapter page, carrying the image bytes with each.
  async function mdSiteCollect(mode, lang) {
    const m = await mdSiteManifest();
    if (!m) return [];
    await mdSiteMapDom();

    const domByKey = new Map();
    for (const img of pageImgs()) {
      const key = String(img.dataset.tpOriginalKey || "");
      if (key && !domByKey.has(key)) domByKey.set(key, img);
    }

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
          naturalSize: img
            ? { width: Number(img.naturalWidth) || 0, height: Number(img.naturalHeight) || 0 }
            : null,
          generation: img && TP.generationFor ? TP.generationFor(img) : null,
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
