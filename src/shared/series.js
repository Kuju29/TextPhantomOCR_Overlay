import { getStorage, setStorage } from "./storage.js";

/**
 * Derive a stable per-series key from a reader page URL, so the AI character
 * sheet and translation memory follow the series. Keeps the host plus leading
 * series-slug segments and stops at the first chapter/episode/page marker,
 * pure number or UUID-ish hash:
 *
 *   host/manga/solo-leveling/chapter-12  -> host/manga/solo-leveling
 *   host/title/1234/some-name/ch-3       -> host/title/1234
 *   mangadex.org/chapter/<uuid>          -> mangadex.org  (site-level fallback)
 */
/**
 * Derive a series slug from a page/tab TITLE — the generic fallback for
 * sites whose URLs carry no series name (SPA readers, id-only URLs).
 * Almost every reader puts the series name in the document title, e.g.
 * "Solo Leveling - Chapter 12 | SomeSite".
 */
export function seriesSlugFromTitle(rawTitle, host = "") {
  let t = String(rawTitle || "").trim();
  if (!t) return "";
  // Strip chapter / episode markers with their numbers (multi-language).
  t = t.replace(
    /\b(?:chapter|chap\.?|ch\.?|episode|ep\.?|vol(?:ume)?\.?)\s*(?:\d[\d.-]*|(?=$|[|•·—–:]))|(?:ตอนที่|ตอน)\s*[0-9๐-๙]+|第\s*[\d一二三四五六七八九十百千.]+\s*[話话回]|#\s*\d+/gi,
    " ",
  );
  // A long site brand is not series authority. Prefer the first non-generic
  // title part and exclude the known hostname/reader labels.
  const site = String(host).split(".")[0].toLowerCase();
  const hostname = String(host).toLowerCase();
  const parts = t
    .split(/[|•·—–:]+|\s-\s/)
    .map((s) => s.trim())
    .filter((part) => part && part.toLowerCase() !== site && part.toLowerCase() !== hostname &&
      !GENERIC_READER_ROUTES.has(part.toLowerCase()) &&
      !SERIES_ROUTES.has(part.toLowerCase()));
  t = parts[0] || "";
  const slug = t
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-") // \p{M}: Thai vowels/tone marks are combining marks
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.replace(/^-+|-+$/g, "").length >= 3 ? slug : "";
}

/**
 * If the URL-based key is only a bare host (no series part), refine it with
 * a slug from the page title: `host` -> `host/t/<slug>`.
 */
export function refineSeriesKeyWithTitle(baseKey, title) {
  const key = String(baseKey || "").trim() || "default";
  if (key === "default" || seriesIdentityKnown(key)) return key;
  const slug = seriesSlugFromTitle(title, key.split("/")[0]);
  return slug ? `${key}/t/${slug}` : key;
}

const SERIES_ROUTES = new Set([
  "title", "manga", "manhwa", "manhua", "series", "book", "comic", "novel",
]);
const GENERIC_READER_ROUTES = new Set([
  "read", "reader", "chapter", "chapters", "episode", "episodes", "page", "pages", "view", "home", "loading",
]);

export function seriesIdentityKnown(seriesKey) {
  const parts = String(seriesKey || "").split("/");
  if (parts.length < 2 || parts[0] === "default") return false;
  return !(parts.length === 2 && (SERIES_ROUTES.has(parts[1]) || GENERIC_READER_ROUTES.has(parts[1])));
}

// Legacy records have no target identity. Keep them stored, but never guess
// their language when attaching memory to a newly scoped translation.
export function seriesMemoryKey(seriesKey, targetLang = "") {
  const key = String(seriesKey || "default");
  const language = String(targetLang || "").trim().toLowerCase();
  if (!language) return key;
  return `tp-memory-v2:${language}:${key}`;
}

const MD_MAP_KEY = "mdChapterSeriesMap";
const MD_MAP_MAX = 300;
const MD_API_TIMEOUT_MS = 4000;

/**
 * Async, site-aware series key.
 *
 * Falls back to `seriesKeyFromUrl`.  Special case: MangaDex chapter URLs
 * carry only a CHAPTER uuid (no series slug), so the sync heuristic can only
 * return "mangadex.org" — here we resolve chapter → manga (series) uuid via
 * the public API once, cache the mapping in storage, and key the memory as
 * `mangadex.org/title/<mangaUuid>` so every series gets its own memory.
 */
export async function resolveSeriesKey(url) {
  const base = seriesKeyFromUrl(url);
  const m = /(^|\.)mangadex\.org\/chapter\/([a-f0-9-]{8,})/i.exec(
    String(url || "").replace(/^https?:\/\//i, ""),
  );
  if (!m) return base;
  const chapterId = m[2].toLowerCase();
  try {
    const store = await getStorage([MD_MAP_KEY]);
    const map =
      store[MD_MAP_KEY] && typeof store[MD_MAP_KEY] === "object"
        ? store[MD_MAP_KEY]
        : {};
    if (map[chapterId]) return `mangadex.org/title/${map[chapterId]}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MD_API_TIMEOUT_MS);
    const r = await fetch(`https://api.mangadex.org/chapter/${chapterId}`, {
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return base;
    const data = await r.json();
    const rel = (data?.data?.relationships || []).find(
      (x) => x?.type === "manga",
    );
    const mangaId = String(rel?.id || "").toLowerCase();
    if (!mangaId) return base;

    // Persist the mapping (bounded — keep the most recent entries).
    const entries = Object.entries(map).slice(-(MD_MAP_MAX - 1));
    const next = Object.fromEntries(entries);
    next[chapterId] = mangaId;
    await setStorage({ [MD_MAP_KEY]: next });
    return `mangadex.org/title/${mangaId}`;
  } catch {
    return base; // offline / API error → site-level fallback still works
  }
}

export function seriesKeyFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const kept = [];
    for (const seg of u.pathname.split("/").filter(Boolean)) {
      const t = decodeURIComponent(seg).toLowerCase();
      // A numeric/UUID segment immediately after an explicit series route is
      // the series identity, not a chapter ID. Stop here so optional title
      // slugs cannot change the identity across chapters.
      const seriesId = SERIES_ROUTES.has(kept.at(-1));
      if (seriesId && (/^\d+([._-]\d+)*$/.test(t) || /^[0-9a-f-]{16,}$/i.test(t))) {
        kept.push(t);
        break;
      }
      // UUID / long hex-ish hash → not a stable series slug.
      if (/^[0-9a-f-]{16,}$/i.test(t) && /\d/.test(t)) break;
      // Pure number (chapter/page id).
      if (/^\d+([._-]\d+)*$/.test(t)) break;
      // chapter-12 / ch_3 / episode-5 / ep12 / page-2 / vol-4 …
      if (
        /(^|[-_])(ch(apter)?|ep(isode)?|page|pg|vol(ume)?)([-_.]?\d+|$)/.test(t)
      )
        break;
      kept.push(t);
      if (kept.length >= 3) break;
    }
    return kept.length ? `${host}/${kept.join("/")}` : host;
  } catch {
    return "default";
  }
}
