import { instructionPack } from "./prompt-language.js";
// Source-only evidence from immutable initial request checkpoints, not translation memory.
import { SOURCE_CONTEXT_HEADER, MAX_CONTEXT_GROUPS, MAX_CONTEXT_UNITS, MAX_CONTEXT_CHARS } from '../../generated/source-context-policy.js';

const contextError = code => Object.assign(new Error(code), { code, attempted: false });

export function normalizeSourceContext(groups, targetUnits = null, wireIds = null) {
  if (groups == null) return [];
  if (!Array.isArray(groups) || groups.length > MAX_CONTEXT_GROUPS) throw contextError('invalid_source_context');
  // Use the selected output contract, never infer a sparse Conversation ID
  // from its position in a repair slice. Legacy callers retain P0.. aliases.
  if (wireIds != null && (!Array.isArray(targetUnits) || !Array.isArray(wireIds) ||
      wireIds.length !== targetUnits.length || wireIds.some(id => typeof id !== 'string' || !id) ||
      new Set(wireIds).size !== wireIds.length)) throw contextError('invalid_source_context_mapping');
  const mapping = Array.isArray(targetUnits) ? new Map(targetUnits.map((row, i) =>
    [String(row.id ?? ''), wireIds == null ? `P${i}` : wireIds[i]])) : null;
  const result = []; let count = 0, chars = 0;
  for (const group of groups) {
    if (!group || !Array.isArray(group.targetIds) || !Array.isArray(group.units)) throw contextError('invalid_source_context');
    const targets = [];
    for (const value of group.targetIds) {
      if (typeof value !== 'string' || !value) throw contextError('invalid_source_context_target');
      const mapped = mapping ? mapping.get(value) : value;
      if (mapped && !targets.includes(mapped)) targets.push(mapped);
    }
    const units = [], seen = new Set();
    for (const row of group.units) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.text !== 'string' ||
          !row.text.trim() || Array.from(row.text).length > 4000 || seen.has(row.id)) throw contextError('invalid_source_context_unit');
      seen.add(row.id); chars += Array.from(row.text).length; count++;
      if (count > MAX_CONTEXT_UNITS || chars > MAX_CONTEXT_CHARS) throw contextError('source_context_budget_exceeded');
      units.push({ id: row.id, text: row.text });
    }
    if (targets.length && units.length) result.push({ targetIds: targets, units, origin: group.origin === "initial_request" ? "initial_request" : "page_checkpoint" });
  }
  return result;
}

export function sourceContextText(groups, targetUnits = null, lang = "en", wireIds = null) {
  const normalized = normalizeSourceContext(groups, targetUnits, wireIds);
  if (!normalized.length) return '';
  return instructionPack(lang).captured + '\n' + JSON.stringify(normalized.map((group, i) => ({
    context: `E${i + 1}`, appliesTo: group.targetIds, evidence: group.origin,
    units: group.units.map((row, j) => ({ context: `C${j + 1}`, text: row.text })),
  })));
}
