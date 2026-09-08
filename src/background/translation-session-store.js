// Checkpoints for this browser session, NOT settings and NOT a live stream.
// Never falls back to disk/local storage for OCR, results or run access tokens.
export const TRANSLATION_SESSION_KEY = 'tpTranslationRunsV1';
const PRIVATE_FIELDS = /^(?:api_?key|x-tp-run-token|authorization|credential|credentials|imageDataUri|sourceImageDataUri|dataUri|image_b64|images|rawResponse|rawStream)$/i;
export function sessionSafe(value) {
  if (Array.isArray(value)) return value.map(sessionSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.test(key) && !['__proto__','constructor','prototype'].includes(key))
    .map(([key, item]) => [key, sessionSafe(item)]));
  return value;
}
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function createTranslationSessionStore({
  area = () => globalThis.chrome?.storage?.session,
  now = Date.now, maxBytes = 6 * 1024 * 1024, maxRuns = 24,
  ttlMs = 6 * 60 * 60 * 1000,
} = {}) {
  let data = {}, loaded = null, chain = Promise.resolve();
  async function load() {
    if (!loaded) loaded = (async () => {
      const storage = area();
      if (!storage) throw Object.assign(new Error('Translation session storage is unavailable'), { code: 'session_storage_unavailable' });
      await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
      const got = await storage.get(TRANSLATION_SESSION_KEY);
      for (const row of Object.values(got?.[TRANSLATION_SESSION_KEY]?.runs || {})) {
        if (row?.id && now() - Number(row.createdAt || 0) < ttlMs) data[row.id] = row;
      }
    })();
    return loaded;
  }
  function update(id, change) {
    const work = chain.then(async () => {
      await load();
      const previous = structuredClone(data[id] || null);
      const next = await change(previous);
      const candidate = { ...data };
      if (next == null) delete candidate[id];
      else candidate[id] = sessionSafe({ ...next, id, updatedAt: now() });
      for (const [key, row] of Object.entries(candidate)) {
        if (key !== id && now() - Number(row.createdAt || 0) >= ttlMs) delete candidate[key];
      }
      const oldTerminal = Object.values(candidate).filter(row => row.id !== id &&
        ['done','apply_failed','cancelled','unavailable'].includes(row.phase)).sort((a,b) => a.updatedAt - b.updatedAt);
      while ((Object.keys(candidate).length > maxRuns || size(candidate) > maxBytes) && oldTerminal.length)
        delete candidate[oldTerminal.shift().id];
      if (Object.keys(candidate).length > maxRuns || size(candidate) > maxBytes)
        throw Object.assign(new Error('Active translation checkpoints reached their session storage limit'), { code: 'session_checkpoint_limit' });
      // Publish memory only after the persistent write succeeds. Failed writes
      // cannot make a later caller believe a missing checkpoint was saved.
      await area().set({ [TRANSLATION_SESSION_KEY]: { version: 1, runs: candidate } });
      data = candidate;
      return structuredClone(data[id] || null);
    });
    chain = work.catch(() => {});
    return work;
  }
  return {
    update,
    async get(id) { await load(); await chain; return structuredClone(data[id] || null); },
    async list() { await load(); await chain; return structuredClone(Object.values(data)); },
    remove(id) { return update(id, () => null); },
    flush() { return chain; },
  };
}
export const translationSessions = createTranslationSessionStore();
