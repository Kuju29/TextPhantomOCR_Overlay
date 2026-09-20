import { instructionPack } from "./prompt-language.js";
// Bounded source evidence from the current page; never additional translation targets.
export const PAGE_CONTEXT_MAX_UNITS = 6;
export const PAGE_CONTEXT_MAX_CHARS = 2000;
export const PAGE_CONTEXT_HEADER = "SAME PAGE — READ ONLY: These are nearby source units outside this request. They may clarify a continuation, reference or reply. Array proximity is not verified reading order or speaker identity; do not invent either. Translate only SOURCE TEXT target IDs, never these context records. Preserve each target unit's own contribution without copying context into its translation.";

export function normalizePageContext(entries, targetUnits = []) {
  const targets = new Set(targetUnits.map(unit => String(unit?.id ?? unit)));
  const seen = new Set();
  const result = [];
  let chars = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "").trim();
    const text = String(entry.text ?? "").trim();
    const size = Array.from(text).length;
    if (!id || !text || targets.has(id) || seen.has(id) || chars + size > PAGE_CONTEXT_MAX_CHARS) continue;
    seen.add(id); chars += size; result.push({ id, text });
    if (result.length >= PAGE_CONTEXT_MAX_UNITS) break;
  }
  return result;
}

export function selectPageContext(allUnits, targetUnits) {
  const units = Array.isArray(allUnits) ? allUnits : [];
  const targets = new Set(targetUnits.map(unit => String(unit.id)));
  const positions = units.flatMap((unit, index) => targets.has(String(unit.id)) ? [index] : []);
  if (!positions.length) return [];
  const candidates = units.map((unit, index) => ({ unit, index,
    distance: Math.min(...positions.map(position => Math.abs(position - index))) }))
    .filter(({ unit }) => !targets.has(String(unit.id)))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  const chosen = normalizePageContext(candidates.map(({ unit }) => unit), targetUnits);
  const selected = new Set(chosen.map(unit => unit.id));
  return units.filter(unit => selected.has(String(unit.id)))
    .map(unit => chosen.find(item => item.id === String(unit.id)))
    .filter((unit, index, list) => list.indexOf(unit) === index);
}

export function pageContextText(entries, lang = "en") {
  const normalized = normalizePageContext(entries);
  return normalized.length ? instructionPack(lang).page + "\n" + JSON.stringify(normalized.map((entry, index) => ({ context: `C${index + 1}`, text: entry.text }))) : "";
}
