// Identifies MangaDex chapter pages by a blob-URL-independent key and caches their results and image bytes.

const MD_RESULT_TTL_MS = 15 * 60 * 1000;
// The result cache can hold rendered data URIs (newImg); bound it by
// count and size (oldest-written first) in addition to the 15 min TTL.
export const MD_RESULT_MAX = 200;
export const MD_RESULT_MAX_CHARS = 32 * 1024 * 1024;
const MD_DATAURI_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_MAX = 80;
const MD_DATAURI_MAX_CHARS = 32 * 1024 * 1024;

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
    const parts = new URL(String(url || "")).pathname
      .split("/")
      .filter(Boolean);
    for (let i = parts.length - 3; i >= 0; i--) {
      if (parts[i] === "data" || parts[i] === "data-saver") {
        const hash = parts[i + 1] || "";
        const file = parts[i + 2] || "";
        if (hash && file) return `md:${parts[i]}/${hash}/${file}`;
      }
    }
  } catch {}
  return "";
}

// Maps a job mode to the scope segment used in cache keys.
function mdScopeFromMode(mode) {
  if (mode === "lens_text") return "text";
  if (mode === "lens_images") return "images";
  return String(mode || "");
}

// Builds the result-cache key from md key, language, mode and, for text overlays, the text source.
export function mdCacheKey(mdKey, lang, mode, source = "", settingsEpoch = 0) {
  const k = String(mdKey || "");
  const l = String(lang || "");
  const s = mdScopeFromMode(mode);
  if (!(k && l && s)) return "";
  const src =
    s === "text"
      ? String(source || "translated")
          .trim()
          .toLowerCase() || "translated"
      : "";
  // settingsEpoch is an opaque, session-persisted semantic revision. It is
  // bumped only when translation settings change, so identical profiles hit
  // while model/prompt/layout changes cannot reuse an old rendered result.
  // No credential, prompt text, or model name is exposed in the key.
  const revision = Math.max(0, Number(settingsEpoch) >>> 0);
  const base = src ? `${k}::${l}::${s}::${src}` : `${k}::${l}::${s}`;
  return `${base}::r${revision}`;
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
const resultChars = rec => String(rec?.newImg || "").length + (rec?.resultChars || 0);
function pruneResultCache(now = Date.now()) {
  for (const [k, rec] of mdResultCache.entries()) {
    if (!rec || now - rec.ts > MD_RESULT_TTL_MS) mdResultCache.delete(k);
  }
  let chars = 0;
  for (const rec of mdResultCache.values()) chars += resultChars(rec);
  while (mdResultCache.size > MD_RESULT_MAX || chars > MD_RESULT_MAX_CHARS) {
    const first = mdResultCache.keys().next().value;
    if (first === undefined) break;
    chars -= resultChars(mdResultCache.get(first));
    mdResultCache.delete(first);
  }
}

// 10493: the md key carries the settings epoch only, which cannot see every
// generation input (Series memory content, token ceiling...). When Translate
// is pressed, the dispatcher records the generation fingerprint of that press
// per tab + language + mode + source; a cached page made under another
// generation is then not reused (a new AI request is sent). Hydration with no
// press in this tab/chapter (navigation, language switch) keeps the epoch rule.
const mdTabGenerations = new Map();
const MD_TAB_GENERATIONS_MAX = 64;
const tabGenerationKey = (tabId, lang, mode, source) =>
  [Number(tabId) || 0, String(lang || ""), mdScopeFromMode(mode),
    mdScopeFromMode(mode) === "text" ? String(source || "translated").trim().toLowerCase() || "translated" : ""].join("|");
export function rememberTabGeneration(tabId, { lang, mode, source }, generation) {
  if (!Number.isFinite(Number(tabId)) || !generation) return;
  const key = tabGenerationKey(tabId, lang, mode, source);
  mdTabGenerations.delete(key);
  mdTabGenerations.set(key, String(generation));
  while (mdTabGenerations.size > MD_TAB_GENERATIONS_MAX)
    mdTabGenerations.delete(mdTabGenerations.keys().next().value);
}
export function tabGeneration(tabId, { lang, mode, source }) {
  return mdTabGenerations.get(tabGenerationKey(tabId, lang, mode, source)) || "";
}
/** A chapter change or tab close forgets the tab's pressed generations. */
export function forgetTabGenerations(tabId) {
  const prefix = `${Number(tabId) || 0}|`;
  for (const key of [...mdTabGenerations.keys()]) if (key.startsWith(prefix)) mdTabGenerations.delete(key);
}

// Reads a result-cache entry, or null when absent.
export function getCachedResult(cacheKey) {
  pruneResultCache();
  return cacheKey ? mdResultCache.get(cacheKey) || null : null;
}

// Stores a result-cache entry, merging it with any existing one.
export function setCachedResult(cacheKey, { newImg, result, generation }) {
  if (!cacheKey) return;
  pruneResultCache();
  const prev = mdResultCache.get(cacheKey) || {};
  const nextResult = result || prev.result || null;
  // Re-insert so the newest write is last in the eviction order.
  mdResultCache.delete(cacheKey);
  mdResultCache.set(cacheKey, {
    newImg: newImg || prev.newImg || null,
    result: nextResult,
    // Generation settings that produced the page (a repair keeps the page's).
    generation: typeof generation === "string" ? generation : prev.generation || "",
    resultChars: nextResult === prev.result ? prev.resultChars || 0
      : nextResult ? JSON.stringify(nextResult).length : 0,
    ts: Date.now(),
  });
  pruneResultCache();
}

// Drops expired data-URI entries and trims the cache back to its size limit.
function pruneDataUriCache(now = Date.now()) {
  for (const [k, rec] of mdDataUriCache.entries()) {
    if (!rec || now - rec.ts > MD_DATAURI_TTL_MS) mdDataUriCache.delete(k);
  }
  let chars = [...mdDataUriCache.values()].reduce((sum, rec) => sum + rec.du.length, 0);
  while (mdDataUriCache.size > MD_DATAURI_MAX || chars > MD_DATAURI_MAX_CHARS) {
    const first = mdDataUriCache.keys().next().value;
    if (first === undefined) break;
    chars -= mdDataUriCache.get(first).du.length;
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
