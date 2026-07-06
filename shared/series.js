/**
 * Derive a stable per-series key from a reader page URL.
 *
 * Goal: pages of the SAME series/chapter run share one key, so the AI
 * character sheet + translation memory follow the series automatically and
 * a new series starts with a fresh memory.
 *
 * Heuristic: keep the host plus leading path segments that look like a
 * series slug, and stop at the first segment that looks like a chapter /
 * episode / page marker, a pure number, or a UUID-ish hash.
 *
 *   host/manga/solo-leveling/chapter-12  -> host/manga/solo-leveling
 *   host/title/1234/some-name/ch-3       -> host/title
 *   mangadex.org/chapter/<uuid>          -> mangadex.org  (site-level fallback)
 */
/**
 * Derive a series slug from a page/tab TITLE — the generic fallback for
 * sites whose URLs carry no series name (SPA readers, id-only URLs).
 * Almost every reader puts the series name in the document title, e.g.
 * "Solo Leveling - Chapter 12 | SomeSite".
 */
export function seriesSlugFromTitle(rawTitle) {
  let t = String(rawTitle || "").trim();
  if (!t) return "";
  // Strip chapter / episode markers with their numbers (multi-language).
  t = t.replace(
    /(chapter|chap\.?|ch\.?|ep(isode)?\.?|ตอนที่|ตอน|第\s*[\d.]+\s*[話话回]|vol(ume)?\.?|#)\s*[\d.\-]*/gi,
    " ",
  );
  // Split on common separators; the series name is usually the longest chunk.
  const parts = t.split(/[|•·—–:]+|\s-\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length) t = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
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
  if (key === "default" || key.includes("/")) return key;
  const slug = seriesSlugFromTitle(title);
  return slug ? `${key}/t/${slug}` : key;
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
    const store = await chrome.storage.local.get(MD_MAP_KEY);
    const map =
      store[MD_MAP_KEY] && typeof store[MD_MAP_KEY] === "object" ? store[MD_MAP_KEY] : {};
    if (map[chapterId]) return `mangadex.org/title/${map[chapterId]}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MD_API_TIMEOUT_MS);
    const r = await fetch(`https://api.mangadex.org/chapter/${chapterId}`, {
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return base;
    const data = await r.json();
    const rel = (data?.data?.relationships || []).find((x) => x?.type === "manga");
    const mangaId = String(rel?.id || "").toLowerCase();
    if (!mangaId) return base;

    // Persist the mapping (bounded — keep the most recent entries).
    const entries = Object.entries(map).slice(-(MD_MAP_MAX - 1));
    const next = Object.fromEntries(entries);
    next[chapterId] = mangaId;
    await chrome.storage.local.set({ [MD_MAP_KEY]: next });
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
      // UUID / long hex-ish hash → not a stable series slug.
      if (/^[0-9a-f-]{16,}$/i.test(t) && /\d/.test(t)) break;
      // Pure number (chapter/page id).
      if (/^\d+([._-]\d+)*$/.test(t)) break;
      // chapter-12 / ch_3 / episode-5 / ep12 / page-2 / vol-4 …
      if (/(^|[-_])(ch(apter)?|ep(isode)?|page|pg|vol(ume)?)([-_.]?\d+|$)/.test(t)) break;
      kept.push(t);
      if (kept.length >= 3) break;
    }
    return kept.length ? `${host}/${kept.join("/")}` : host;
  } catch {
    return "default";
  }
}
