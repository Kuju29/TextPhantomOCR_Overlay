/**
 * Per-series AI memory (translation glossary + character sheet).
 *
 * Stored in `chrome.storage.local` under one key:
 *
 *   aiSeriesMemory = {
 *     "<seriesKey>": { glossary: [{src,tgt}], characters: [{name,gender,speech,note}], at: <ts> },
 *     ...
 *   }
 *
 * The series key comes from the reader page URL (see shared/series.js), so
 * moving to a new series automatically starts a fresh memory while the old
 * one is kept (LRU, max 12 series) in case the user comes back.
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.seriesMemory");

const STORE_KEY = "aiSeriesMemory";
const MAX_SERIES = 12;
const MAX_GLOSSARY = 120;
const MAX_CHARACTERS = 40;

async function readAll() {
  const store = await chrome.storage.local.get(STORE_KEY);
  const all = store[STORE_KEY];
  return all && typeof all === "object" ? { ...all } : {};
}

/** Memory for one series (empty arrays when unknown). */
export async function getSeriesMemory(seriesKey) {
  try {
    const all = await readAll();
    const m = all[String(seriesKey || "default")] || {};
    return {
      glossary: Array.isArray(m.glossary) ? m.glossary : [],
      characters: Array.isArray(m.characters) ? m.characters : [],
      // How many pages of this series were already sent WITH an image
      // (budget for the "auto" page-image mode).
      visionPages: Number.isFinite(Number(m.visionPages)) ? Number(m.visionPages) : 0,
    };
  } catch {
    return { glossary: [], characters: [], visionPages: 0 };
  }
}

function mergeGlossary(existing, incoming) {
  const bySrc = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && e.src) bySrc.set(String(e.src), { src: String(e.src), tgt: String(e.tgt || "") });
  }
  for (const e of Array.isArray(incoming) ? incoming : []) {
    if (e && e.src && e.tgt) bySrc.set(String(e.src), { src: String(e.src), tgt: String(e.tgt) });
  }
  return [...bySrc.values()].slice(-MAX_GLOSSARY);
}

function mergeCharacters(existing, incoming) {
  const byName = new Map();
  for (const c of Array.isArray(existing) ? existing : []) {
    if (c && c.name) byName.set(String(c.name), { ...c, name: String(c.name) });
  }
  for (const c of Array.isArray(incoming) ? incoming : []) {
    if (!c || !c.name) continue;
    const name = String(c.name);
    const prev = byName.get(name) || {};
    const merged = { ...prev, name };
    for (const k of ["gender", "speech", "note"]) {
      const v = String(c[k] || "").trim();
      if (v && v.toLowerCase() !== "unknown") merged[k] = v;
    }
    byName.set(name, merged);
  }
  return [...byName.values()].slice(-MAX_CHARACTERS);
}

/**
 * Merge one page's results into the series memory (best-effort).
 * Accepts a raw job result; extracts `Ai.glossary` / `Ai.characters`.
 */
export async function accumulateSeriesMemory(seriesKey, result) {
  try {
    const glossary = result?.Ai?.glossary || result?.ai?.glossary || null;
    const characters = result?.Ai?.characters || result?.ai?.characters || null;
    const usedVision = Boolean(
      result?.Ai?.meta?.vision || result?.ai?.meta?.vision,
    );
    const hasG = Array.isArray(glossary) && glossary.length;
    const hasC = Array.isArray(characters) && characters.length;
    if (!hasG && !hasC && !usedVision) return;

    const key = String(seriesKey || "default");
    const all = await readAll();
    const cur = all[key] && typeof all[key] === "object" ? all[key] : {};
    delete all[key]; // re-insert below to refresh recency
    all[key] = {
      glossary: hasG ? mergeGlossary(cur.glossary, glossary) : (cur.glossary || []),
      characters: hasC ? mergeCharacters(cur.characters, characters) : (cur.characters || []),
      visionPages: (Number(cur.visionPages) || 0) + (usedVision ? 1 : 0),
      at: Date.now(),
    };

    // LRU: evict the oldest series beyond the cap.
    const keys = Object.keys(all);
    if (keys.length > MAX_SERIES) {
      keys
        .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0))
        .slice(0, keys.length - MAX_SERIES)
        .forEach((k) => delete all[k]);
    }
    await chrome.storage.local.set({ [STORE_KEY]: all });
  } catch (e) {
    log.warn("accumulate failed", e?.message || String(e));
  }
}

/** Clear one series' memory (characters + glossary). */
export async function clearSeriesMemory(seriesKey) {
  try {
    const all = await readAll();
    delete all[String(seriesKey || "default")];
    await chrome.storage.local.set({ [STORE_KEY]: all });
  } catch {
    /* best-effort */
  }
}
