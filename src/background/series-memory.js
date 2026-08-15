// Stores and merges the per-series AI memory: glossary, character sheet, series state and recent page context.

import { createLogger } from "../shared/logger.js";
import { getStorage, setStorage } from "../shared/storage.js";

const log = createLogger("SW.seriesMemory");

const STORE_KEY = "aiSeriesMemory";
const MAX_SERIES = 12;
const MAX_GLOSSARY = 120;
const MAX_CHARACTERS = 40;
const MAX_PREV_CONTEXT = 4;
let writeChain = Promise.resolve();

// Reads every series' memory from storage.
async function readAll() {
  const store = await getStorage([STORE_KEY]);
  const all = store[STORE_KEY];
  return all && typeof all === "object" ? { ...all } : {};
}

// Returns the stored memory for one series, with empty fields when it is unknown.
export async function getSeriesMemory(seriesKey) {
  try {
    const key = String(seriesKey || "default");
    await writeChain.catch(() => {});
    const all = await readAll();
    const m = all[key] || {};
    return {
      glossary: Array.isArray(m.glossary) ? m.glossary : [],
      characters: Array.isArray(m.characters) ? m.characters : [],
      state: typeof m.state === "string" ? m.state : "",
      prevContext: Array.isArray(m.prevContext) ? m.prevContext.slice(-MAX_PREV_CONTEXT) : [],
      pageContexts: m.pageContexts && typeof m.pageContexts === "object" ? m.pageContexts : {},
      visionPages: Number.isFinite(Number(m.visionPages)) ? Number(m.visionPages) : 0,
    };
  } catch {
    return { glossary: [], characters: [], state: "", prevContext: [], pageContexts: {}, visionPages: 0 };
  }
}

// Returns the bounded slice of series memory that travels with an AI request.
export function selectPromptMemory(memory, { glossaryLimit = 12, characterLimit = 6 } = {}) {
  return {
    glossary: (Array.isArray(memory?.glossary) ? memory.glossary : []).slice(-glossaryLimit),
    characters: (Array.isArray(memory?.characters) ? memory.characters : []).slice(-characterLimit),
    state: String(memory?.state || "").slice(0, 1200),
    prevContext: (Array.isArray(memory?.prevContext) ? memory.prevContext : [])
      .slice(-MAX_PREV_CONTEXT)
      .map((entry) => ({
        src: String(entry?.src || entry?.source || "").slice(0, 240),
        tgt: String(entry?.tgt || entry?.target || "").slice(0, 240),
      })),
    pageContexts: memory?.pageContexts && typeof memory.pageContexts === "object"
      ? memory.pageContexts
      : {},
    visionPages: Number(memory?.visionPages) || 0,
  };
}

// Merges incoming glossary entries over the existing ones, keyed by source term.
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

// Merges incoming character entries over the existing ones by name, recording conflicting evidence as unknown.
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
      if (!v || v.toLowerCase() === "unknown") continue;
      if (
        k === "gender" &&
        prev.gender &&
        String(prev.gender).toLowerCase() !== "unknown" &&
        String(prev.gender).toLowerCase() !== v.toLowerCase()
      ) {
        merged.gender = "unknown";
        merged.note = [prev.note, c.note, `gender evidence conflicts: ${prev.gender}/${v}`]
          .filter(Boolean)
          .join("; ")
          .slice(0, 300);
        continue;
      }
      merged[k] = v;
    }
    byName.set(name, merged);
  }
  return [...byName.values()].slice(-MAX_CHARACTERS);
}

// Merges one page's AI result into the stored series memory.
async function accumulateSeriesMemoryNow(seriesKey, result) {
  try {
    const glossary = result?.Ai?.glossary || result?.ai?.glossary || null;
    const characters = result?.Ai?.characters || result?.ai?.characters || null;
    const usedVision = Boolean(
      result?.Ai?.meta?.vision || result?.ai?.meta?.vision,
    );
    const pageContext = (result?.lensDocument?.paragraphs || [])
      .filter((p) => String(p?.aiText || "").trim())
      .slice(-MAX_PREV_CONTEXT)
      .map((p) => ({
        src: String(p?.text || p?.originalText || "").trim().slice(0, 240),
        tgt: String(p.aiText || "").trim().slice(0, 240),
      }));
    const pageIndex = Number(result?.Ai?.meta?.pageIndex);
    const batchId = String(result?.Ai?.meta?.batchId || "");
    const hasG = Array.isArray(glossary) && glossary.length;
    const hasC = Array.isArray(characters) && characters.length;
    if (!hasG && !hasC && !usedVision && !pageContext.length) return;

    const key = String(seriesKey || "default");
    const all = await readAll();
    const cur = all[key] && typeof all[key] === "object" ? all[key] : {};
    delete all[key];
    all[key] = {
      glossary: hasG ? mergeGlossary(cur.glossary, glossary) : (cur.glossary || []),
      characters: hasC ? mergeCharacters(cur.characters, characters) : (cur.characters || []),
      state: typeof cur.state === "string" ? cur.state : "",
      prevContext: pageContext.length ? pageContext : (cur.prevContext || []),
      pageContexts: (() => {
        const contexts = cur.pageContexts && typeof cur.pageContexts === "object"
          ? { ...cur.pageContexts }
          : {};
        if (batchId && Number.isInteger(pageIndex) && pageIndex >= 0 && pageContext.length) {
          const batch = contexts[batchId] && typeof contexts[batchId] === "object"
            ? { ...contexts[batchId] }
            : {};
          batch[String(pageIndex)] = pageContext;
          contexts[batchId] = batch;
        }
        for (const stale of Object.keys(contexts).slice(0, Math.max(0, Object.keys(contexts).length - 4))) {
          delete contexts[stale];
        }
        return contexts;
      })(),
      visionPages: (Number(cur.visionPages) || 0) + (usedVision ? 1 : 0),
      at: Date.now(),
    };

    const keys = Object.keys(all);
    if (keys.length > MAX_SERIES) {
      keys
        .sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0))
        .slice(0, keys.length - MAX_SERIES)
        .forEach((k) => delete all[k]);
    }
    await setStorage({ [STORE_KEY]: all });
  } catch (e) {
    log.warn("accumulate failed", e?.message || String(e));
  }
}

// Merges one page's AI result into the series memory, serialised against every other write.
export async function accumulateSeriesMemory(seriesKey, result) {
  const key = String(seriesKey || "default");
  const next = writeChain.catch(() => {}).then(() => accumulateSeriesMemoryNow(key, result));
  writeChain = next;
  await next;
}
