/**
 * MangaDex-specific helpers and caches.
 *
 * MangaDex is a single-page app that serves chapter pages as blob: URLs, so it
 * gets special treatment:
 * - `md:` keys identify a page by its `data|data-saver/hash/file` path so a
 *   result can be re-applied even after the blob URL changes.
 * - a result cache (`mdCacheByKey`) lets re-visited chapters render instantly.
 * - a data-URI cache (`mdDataUriCache`) avoids re-downloading the same image.
 */

const MD_RESULT_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_MAX = 80;

/** cacheKey (`md:.. :: lang :: scope`) -> { newImg, result, ts } */
const mdResultCache = new Map();
/** normImgSrc -> { du, ts } */
const mdDataUriCache = new Map();

// --- URL / key parsing -----------------------------------------------------

/** True if a page URL is on mangadex.org. */
export function isMangaDexPageUrl(u) {
  try {
    const host = new URL(String(u || "")).hostname.toLowerCase();
    return host === "mangadex.org" || host.endsWith(".mangadex.org");
  } catch {
    return false;
  }
}

/** Extract the chapter id from a MangaDex reader URL ("" if none). */
export function mdChapterIdFromUrl(u) {
  try {
    const m = String(new URL(String(u || "")).pathname || "").match(
      /\/chapter\/([a-f0-9-]{8,})/i,
    );
    return m ? String(m[1] || "") : "";
  } catch {
    return "";
  }
}

/** True if two URLs point at the same MangaDex chapter. */
export function isSameMangaDexChapter(a, b) {
  const ca = mdChapterIdFromUrl(a);
  const cb = mdChapterIdFromUrl(b);
  return !!ca && !!cb && ca === cb;
}

/**
 * Build a stable `md:` key from an at-home image URL, i.e.
 * `md:data/<hash>/<file>`. Returns "" for non-MangaDex URLs.
 */
export function mdKeyFromUrl(url) {
  try {
    const parts = new URL(String(url || "")).pathname.split("/").filter(Boolean);
    for (let i = parts.length - 3; i >= 0; i--) {
      if (parts[i] === "data" || parts[i] === "data-saver") {
        const hash = parts[i + 1] || "";
        const file = parts[i + 2] || "";
        if (hash && file) return `md:${parts[i]}/${hash}/${file}`;
      }
    }
  } catch {
    /* not a URL */
  }
  return "";
}

// --- Result cache ----------------------------------------------------------

function mdScopeFromMode(mode) {
  if (mode === "lens_text") return "text";
  if (mode === "lens_images") return "images";
  return String(mode || "");
}

/** Build the result-cache key for (md key, language, mode). */
export function mdCacheKey(mdKey, lang, mode) {
  const k = String(mdKey || "");
  const l = String(lang || "");
  const s = mdScopeFromMode(mode);
  return k && l && s ? `${k}::${l}::${s}` : "";
}

/** Strip all image-bearing fields from a result (cache stores them separately). */
export function stripImageFields(res) {
  if (!res || typeof res !== "object") return res;
  const out = { ...res };
  for (const k of ["imageDataUri", "imageDataURI", "image", "imageUrl", "image_url", "imageURL"]) {
    delete out[k];
  }
  return out;
}

/** Drop expired result-cache entries. */
function pruneResultCache(now = Date.now()) {
  for (const [k, rec] of mdResultCache.entries()) {
    if (!rec || now - rec.ts > MD_RESULT_TTL_MS) mdResultCache.delete(k);
  }
}

/** Read a result-cache entry (auto-prunes). */
export function getCachedResult(cacheKey) {
  pruneResultCache();
  return cacheKey ? mdResultCache.get(cacheKey) || null : null;
}

/** Store a result-cache entry, merging with any existing one. */
export function setCachedResult(cacheKey, { newImg, result }) {
  if (!cacheKey) return;
  pruneResultCache();
  const prev = mdResultCache.get(cacheKey) || {};
  mdResultCache.set(cacheKey, {
    newImg: newImg || prev.newImg || null,
    result: result || prev.result || null,
    ts: Date.now(),
  });
}

// --- Data-URI cache --------------------------------------------------------

/** Drop expired / overflowing data-URI cache entries. */
function pruneDataUriCache(now = Date.now()) {
  for (const [k, rec] of mdDataUriCache.entries()) {
    if (!rec || now - rec.ts > MD_DATAURI_TTL_MS) mdDataUriCache.delete(k);
  }
  while (mdDataUriCache.size > MD_DATAURI_MAX) {
    const first = mdDataUriCache.keys().next().value;
    if (first === undefined) break;
    mdDataUriCache.delete(first);
  }
}

/** Get a cached data URI for a normalised image key (auto-prunes). */
export function getCachedDataUri(normKey) {
  pruneDataUriCache();
  if (!normKey) return "";
  const rec = mdDataUriCache.get(normKey);
  return rec?.du && Date.now() - rec.ts <= MD_DATAURI_TTL_MS ? rec.du : "";
}

/** Store a data URI for a normalised image key. */
export function setCachedDataUri(normKey, du) {
  if (normKey && du) mdDataUriCache.set(normKey, { du, ts: Date.now() });
}
