export const AI_PROMPT_MAX_CHARS = 1800;

export function normalizeAiModel(model) {
  const m = String(model || '').trim();
  return m ? m : 'auto';
}

export function makePromptKey(lang, model) {
  const l = String(lang || '').trim() || 'en';
  const m = normalizeAiModel(model);
  return `${l}::${m}`;
}

export function normalizePrompt(text, maxChars = AI_PROMPT_MAX_CHARS) {
  let s = String(text ?? '');
  s = s.replace(/\r\n?/g, '\n').trim();
  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd();
  return s;
}

export function migratePromptMap(input) {
  if (!input || typeof input !== 'object') return { map: {}, changed: false };
  const out = {};
  let changed = false;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== 'string') continue;
    const raw = v;
    const val = normalizePrompt(raw);
    if (!val && !raw) continue;
    if (k.includes('::')) {
      out[k] = val;
      if (val !== raw) changed = true;
      continue;
    }
    const nk = makePromptKey(k, 'auto');
    out[nk] = val;
    changed = true;
  }
  return { map: out, changed };
}
