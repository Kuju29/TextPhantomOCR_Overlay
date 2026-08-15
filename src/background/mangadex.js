// Identifies MangaDex chapter pages by a blob-URL-independent key and caches their results and image bytes.

const MD_RESULT_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_MAX = 80;

const mdResultCache = new Map();
const mdDataUriCache = new Map();

// Returns true when a page URL is on mangadex.org.
export function isMangaDexPageUrl(u) {
  try {
    const host = new URL(String(u || "")).hostname.toLowerCase();
    return host === "mangadex.org" || host.endsWith(".mangadex.org");
  } catch {
    return false;
  }
}


// Builds the stable `md:data/<hash>/<file>` key for an at-home image URL, or "" when the URL is not one.
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
  }
  return "";
}

// Maps a job mode to the scope segment used in cache keys.
function mdScopeFromMode(mode) {
  if (mode === "lens_text") return "text";
  if (mode === "lens_images") return "images";
  return String(mode || "");
}

// Builds the result-cache key from md key, language, mode and, for text overlays, the text source.
export function mdCacheKey(mdKey, lang, mode, source = "") {
  const k = String(mdKey || "");
  const l = String(lang || "");
  const s = mdScopeFromMode(mode);
  if (!(k && l && s)) return "";
  const src =
    s === "text" ? String(source || "translated").trim().toLowerCase() || "translated" : "";
  return src ? `${k}::${l}::${s}::${src}` : `${k}::${l}::${s}`;
}

// Removes every image-bearing field from a result so the cache can store the pixels separately.
export function stripImageFields(res) {
  if (!res || typeof res !== "object") return res;
  const out = { ...res };
  for (const k of [
    "imageDataUri",
    "imageDataURI",
    "sourceImageDataUri",
    "image",
    "imageUrl",
    "image_url",
    "imageURL",
  ]) {
    delete out[k];
  }
  return out;
}

// Drops expired result-cache entries.
function pruneResultCache(now = Date.now()) {
  for (const [k, rec] of mdResultCache.entries()) {
    if (!rec || now - rec.ts > MD_RESULT_TTL_MS) mdResultCache.delete(k);
  }
}

// Reads a result-cache entry, or null when absent.
export function getCachedResult(cacheKey) {
  pruneResultCache();
  return cacheKey ? mdResultCache.get(cacheKey) || null : null;
}

// Stores a result-cache entry, merging it with any existing one.
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

// Drops expired data-URI entries and trims the cache back to its size limit.
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

// Returns the cached data URI for a normalised image key, or "".
export function getCachedDataUri(normKey) {
  pruneDataUriCache();
  if (!normKey) return "";
  const rec = mdDataUriCache.get(normKey);
  return rec?.du && Date.now() - rec.ts <= MD_DATAURI_TTL_MS ? rec.du : "";
}

// Stores a data URI for a normalised image key.
export function setCachedDataUri(normKey, du) {
  if (normKey && du) {
    mdDataUriCache.delete(normKey);
    mdDataUriCache.set(normKey, { du, ts: Date.now() });
    pruneDataUriCache();
  }
}
