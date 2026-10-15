// Finished-result cache for every site (MangaDex keeps its own md cache).
//
// Pressing Translate again on the same image with the same effective settings
// reuses the finished result instead of sending Lens/AI again (no tokens).
// Service-worker memory only: never chrome.storage, so it can never take the
// space that checkpoints, usage receipts or other users' work need. A worker
// restart simply starts empty.
//
// Key = image identity + target language + mode + text source + a hash of
// every GENERATION input (what the AI is asked and how it answers: provider,
// model, base URL, prompt text, Series memory mode AND its content, human
// examples, Send page image, token ceiling, AI think, translation mode, ...)
// + a hash of the presentation inputs (render/layout options, API server).
// Credentials and per-page/run ids are never part of it. Any difference is a
// miss; entries made under other settings stay until LRU/TTL, so switching a
// setting back reuses them (10493: no settings epoch in this key).
// Image identity: normalised http(s) URL; data:/blob: sources use a SHA-256 of
// the image bytes when they are available, otherwise the image is not cached.

export const RESULT_CACHE_TTL_MS = 30 * 60 * 1000; // since last use
const RESULT_CACHE_MAX_ENTRIES = 120;
const RESULT_CACHE_MAX_BYTES = 32 * 1024 * 1024; // string chars (base64 ASCII ~ bytes)
const RESULT_CACHE_MAX_IMAGE_BYTES = 8 * 1024 * 1024; // per entry

const IMAGE_FIELDS = ["imageDataUri", "imageDataURI", "sourceImageDataUri", "image", "imageUrl", "image_url", "imageURL"];
// AI payload fields that never change what the AI is asked or how it answers:
// credentials, per-page/run routing, capability estimates refreshed by the
// planner, Paid price quotes. Everything else in payload.ai is a generation
// input. Series memory content (glossary, characters, series_state,
// prev_context) IS a generation input: it is sent in the prompt (10493).
const NON_GENERATION_AI_FIELDS = new Set(["api_key", "apiKey", "conversation", "workload", "model_capabilities",
  "independent_scope", "independent_examples", "_repairImageDataUri", "paid_quote_token", "price_quote_token"]);

async function sha256(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Stable image identity, or "" when this source cannot be identified safely. */
export async function imageIdentity(payload, normalizeUrl = s => s) {
  const src = String(payload?.src || "").trim();
  if (/^https?:/i.test(src)) return `url:${normalizeUrl(src)}`;
  const bytes = src.startsWith("data:") ? src : String(payload?.imageDataUri || "");
  if (bytes.startsWith("data:")) return `sha256:${await sha256(bytes)}`;
  return ""; // blob:/canvas without bytes: no stable identity
}

/**
 * Hash of the inputs that decide what the AI is asked and how it answers.
 * Also used by the MangaDex cache to tell which settings produced a page.
 */
export async function generationFingerprint(payload) {
  const ai = Object.fromEntries(Object.entries(payload?.ai && typeof payload.ai === "object" ? payload.ai : {})
    .filter(([key]) => !NON_GENERATION_AI_FIELDS.has(key)));
  return sha256(JSON.stringify(canonical({
    engine: payload?.engine || "", mode: payload?.mode || "", lang: payload?.lang || "",
    source: payload?.source || "", ai, prompt: payload?.prompt || null,
  })));
}

/** Hash of the inputs that change the rendered page but not the AI text. */
async function presentationFingerprint(payload, apiBase) {
  return sha256(JSON.stringify(canonical({
    render: payload?.render || null, layout: payload?.layout || null,
    apiBase: String(apiBase || ""),
  })));
}

export async function resultCacheKey(payload, { apiBase = "", normalizeUrl } = {}) {
  const identity = await imageIdentity(payload, normalizeUrl);
  const lang = String(payload?.lang || ""), mode = String(payload?.mode || "");
  if (!identity || !lang || !mode) return "";
  const source = String(payload?.source || "").toLowerCase();
  return `${identity}::${lang}::${mode}::${source}::g${await generationFingerprint(payload)}` +
    `::v${await presentationFingerprint(payload, apiBase)}`;
}

const stripImages = result => {
  const out = { ...result };
  for (const key of IMAGE_FIELDS) delete out[key];
  return out;
};

export function createResultCache({ now = Date.now, maxEntries = RESULT_CACHE_MAX_ENTRIES,
  maxBytes = RESULT_CACHE_MAX_BYTES, maxImageBytes = RESULT_CACHE_MAX_IMAGE_BYTES, ttlMs = RESULT_CACHE_TTL_MS } = {}) {
  const entries = new Map(); // insertion order = LRU order (touch re-inserts)
  let bytes = 0;
  const pending = new Set(); // keys of pages with failed lines (see markPending)
  const drop = key => { const e = entries.get(key); if (e) { bytes -= e.bytes; entries.delete(key); } };
  function prune() {
    const t = now();
    for (const [key, e] of entries) if (t - e.usedAt >= ttlMs) drop(key);
    while (entries.size > maxEntries || bytes > maxBytes) drop(entries.keys().next().value);
  }
  /**
   * Stores a finished result. Returns {stored, imageOmitted, reason}.
   * Rendered images are kept only within the per-entry cap; a text-mode result
   * with HTML/lens text is then kept without them (traced as imageOmitted).
   * An image-mode result or one needing its source image is not cached.
   */
  function store(key, result, { mode = "", hasHtml = false } = {}) {
    if (!key || !result || typeof result !== "object") return { stored: false, reason: "no_key" };
    // A page whose lines failed the checks (wrong language, missing) is never
    // served from the cache until a repair fixes every line: pressing Translate
    // again must try again, not repeat the bad result for 30 minutes.
    if (pending.has(key)) return { stored: false, reason: "lines_pending_repair" };
    const text = stripImages(result);
    delete text.perf;
    let newImg = String(result.imageDataUri || result.image || result.imageUrl || result.image_url || "");
    const sourceImageDataUri = String(result.sourceImageDataUri || "");
    let imageOmitted = false;
    if (newImg.length + sourceImageDataUri.length > maxImageBytes) {
      if (sourceImageDataUri || mode !== "lens_text" || !hasHtml) return { stored: false, reason: "image_over_cap" };
      newImg = ""; imageOmitted = true;
    }
    if (!newImg && !hasHtml) return { stored: false, reason: "nothing_to_render" };
    const size = JSON.stringify(text).length + newImg.length + sourceImageDataUri.length;
    if (size > maxBytes) return { stored: false, reason: "entry_over_cap" };
    drop(key);
    entries.set(key, { text, newImg, sourceImageDataUri, imageOmitted, bytes: size, usedAt: now() });
    bytes += size;
    prune();
    return { stored: entries.has(key), imageOmitted, reason: entries.has(key) ? "" : "evicted" };
  }
  /** Returns a fresh result object for a hit (perf.cache = 'hit') and refreshes its LRU/TTL, or null. */
  function get(key) {
    if (!key || pending.has(key)) return null;
    prune();
    const e = entries.get(key);
    if (!e) return null;
    entries.delete(key); e.usedAt = now(); entries.set(key, e);
    const result = structuredClone(e.text);
    if (e.newImg) result.imageDataUri = e.newImg;
    if (e.sourceImageDataUri) result.sourceImageDataUri = e.sourceImageDataUri;
    result.perf = { cache: "hit", ...(e.imageOmitted ? { cacheImageOmitted: true } : {}) };
    return { result, imageOmitted: e.imageOmitted, bytes: e.bytes };
  }
  /** A page of this key has lines that failed: drop it and refuse it until repaired. */
  function markPending(key) {
    if (!key) return;
    drop(key);
    pending.delete(key); pending.add(key);
    while (pending.size > maxEntries * 4) pending.delete(pending.values().next().value);
  }
  /**
   * Replaces the text of an existing entry (e.g. after repair), keeping its images.
   * `complete` (no line left missing) lets a pending page be cached again; its
   * images were not kept, so the next store() caches it in full.
   */
  function replaceText(key, result, { complete = false } = {}) {
    if (key && complete) pending.delete(key);
    const e = key && entries.get(key);
    if (!e || !result || typeof result !== "object") return false;
    const text = stripImages(result); delete text.perf;
    const size = JSON.stringify(text).length + e.newImg.length + e.sourceImageDataUri.length;
    bytes += size - e.bytes;
    Object.assign(e, { text, bytes: size });
    prune();
    return entries.has(key);
  }
  return { store, get, replaceText, markPending, delete: drop,
    clear() { entries.clear(); pending.clear(); bytes = 0; },
    stats() { prune(); return { entries: entries.size, bytes, maxEntries, maxBytes }; } };
}

export const resultCache = createResultCache();
