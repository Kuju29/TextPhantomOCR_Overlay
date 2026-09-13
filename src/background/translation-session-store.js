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
  let data = {}, loaded = null, running = false;
  const pending = [], tails = new Map(), outstanding = new Set();
  // Stored rows are immutable internally; callers and reducers receive clones.
  // Cache only their exact UTF-8 JSON sizes, never a guessed byte estimate.
  const rowSizes = new WeakMap();
  function entrySize(key, row) {
    if (!rowSizes.has(row)) rowSizes.set(row, size(row));
    return size(key) + 1 + rowSizes.get(row);
  }
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
  function candidateFor(current, id, next) {
      const candidate = { ...current };
      if (next == null) delete candidate[id];
      else candidate[id] = sessionSafe({ ...next, id, updatedAt: now() });
      for (const [key, row] of Object.entries(candidate)) {
        if (key !== id && now() - Number(row.createdAt || 0) >= ttlMs) delete candidate[key];
      }
      const oldTerminal = Object.values(candidate).filter(row => row.id !== id &&
        ['done','apply_failed','cancelled','unavailable'].includes(row.phase)).sort((a,b) => a.updatedAt - b.updatedAt);
      let count = Object.keys(candidate).length;
      let bytes = 2 + Math.max(0, count - 1);
      for (const [key, row] of Object.entries(candidate)) bytes += entrySize(key, row);
      while ((count > maxRuns || bytes > maxBytes) && oldTerminal.length) {
        const key = String(oldTerminal.shift().id);
        bytes -= entrySize(key, candidate[key]) + (count > 1 ? 1 : 0);
        count--;
        delete candidate[key];
      }
      if (count > maxRuns || bytes > maxBytes)
        throw Object.assign(new Error('Active translation checkpoints reached their session storage limit'), { code: 'session_checkpoint_limit' });
      return candidate;
  }
  async function drain() {
    try {
      await load();
      while (pending.length) {
        // Preserve every transition in invocation order, but commit an ordered
        // burst once. No timer, dropped progress, or fire-and-forget checkpoint.
        const batch = pending.splice(0, 32), results = [];
        let candidate = data;
        for (const task of batch) {
          try {
            const next = await task.change(structuredClone(candidate[task.id] || null));
            const updated = candidateFor(candidate, task.id, next);
            const result = structuredClone(updated[task.id] || null);
            candidate = updated;
            results.push({ task, result });
          } catch (error) { task.reject(error); }
        }
        if (!results.length) continue;
        try {
          await area().set({ [TRANSLATION_SESSION_KEY]: { version: 1, runs: candidate } });
          // No reader can see a snapshot which failed to reach session storage.
          data = candidate;
          for (const { task, result } of results) task.resolve(result);
        } catch (error) {
          for (const { task } of results) task.reject(error);
        }
      }
    } catch (error) {
      for (const task of pending.splice(0)) task.reject(error);
    } finally { running = false; }
  }
  function update(id, change) {
    const work = new Promise((resolve, reject) => {
      pending.push({ id, change, resolve, reject });
    });
    const settled = work.then(() => {}, () => {});
    tails.set(id, settled);
    outstanding.add(settled);
    void settled.then(() => {
      outstanding.delete(settled);
      if (tails.get(id) === settled) tails.delete(id);
    });
    if (!running) { running = true; queueMicrotask(() => { void drain(); }); }
    return work;
  }
  return {
    update,
    async get(id) { const tail = tails.get(id); await load(); await tail; return structuredClone(data[id] || null); },
    async list() { const writes = [...outstanding]; await load(); await Promise.all(writes); return structuredClone(Object.values(data)); },
    remove(id) { return update(id, () => null); },
    flush() { return Promise.all([...outstanding]); },
  };
}
export const translationSessions = createTranslationSessionStore();
