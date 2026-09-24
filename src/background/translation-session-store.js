// Checkpoints for this browser session, NOT settings and NOT a live stream.
// Never falls back to disk/local storage for OCR, results or run access tokens.
import { noteSessionStorageFailure } from './session-storage-diagnostics.js';
export const TRANSLATION_SESSION_KEY = 'tpTranslationRunsV1'; // legacy aggregate key
export const TRANSLATION_SESSION_RUN_PREFIX = 'tpTranslationRunV1:';
export const translationSessionRunKey = id => `${TRANSLATION_SESSION_RUN_PREFIX}${encodeURIComponent(String(id || ''))}`;
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
  let data = {}, loaded = null;
  const queues = new Map(), runningIds = new Set(), tails = new Map(), outstanding = new Set();
  const rowVersions = new Map();
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
      // Per-run keys keep a page checkpoint write proportional to that run,
      // instead of serializing every active translation on each progress step.
      // Read all session keys once for recovery and migrate the legacy aggregate
      // snapshot when present.
      const got = await storage.get(null);
      const recovered = {};
      for (const row of Object.values(got?.[TRANSLATION_SESSION_KEY]?.runs || {})) {
        if (row?.id && now() - Number(row.createdAt || 0) < ttlMs) recovered[row.id] = row;
      }
      const staleKeys = [];
      for (const [key, value] of Object.entries(got || {})) {
        if (!key.startsWith(TRANSLATION_SESSION_RUN_PREFIX)) continue;
        const row = value?.row;
        if (value?.deleted === true || !row?.id || now() - Number(row.createdAt || 0) >= ttlMs) {
          staleKeys.push(key);
          continue;
        }
        const prior = recovered[row.id];
        if (!prior || Number(row.updatedAt || 0) >= Number(prior.updatedAt || 0)) recovered[row.id] = row;
      }
      data = recovered;
      if (got?.[TRANSLATION_SESSION_KEY]) {
        const migration = Object.fromEntries(Object.values(data).map(row => [
          translationSessionRunKey(row.id), { version: 1, row },
        ]));
        if (Object.keys(migration).length) {
          try { await storage.set(migration); }
          catch (error) {noteSessionStorageFailure('translation_run_migration',error);throw error;}
        }
        try { await storage.remove?.(TRANSLATION_SESSION_KEY); } catch {}
      }
      if (staleKeys.length) { try { await storage.remove?.(staleKeys); } catch {} }
    })();
    return loaded;
  }
  function candidateFor(current, id, next) {
      const candidate = { ...current };
      if (next == null) delete candidate[id];
      else candidate[id] = sessionSafe({ ...next, id, updatedAt: now() });
      for (const [key, row] of Object.entries(candidate)) {
        if (key !== id && !runningIds.has(key) && now() - Number(row.createdAt || 0) >= ttlMs) delete candidate[key];
      }
      const oldTerminal = Object.values(candidate).filter(row => row.id !== id && !runningIds.has(String(row.id)) &&
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
  function reserve(candidate) {
    const before = data, affected = [];
    const ids = new Set([...Object.keys(before), ...Object.keys(candidate)]);
    for (const id of ids) {
      if (before[id] === candidate[id]) continue;
      const version = (rowVersions.get(id) || 0) + 1;
      rowVersions.set(id, version);
      affected.push({ id, previous: before[id], applied: candidate[id], version });
    }
    data = candidate;
    return affected;
  }
  function rollback(affected) {
    for (const item of affected) {
      if (rowVersions.get(item.id) !== item.version) continue;
      if (item.previous === undefined) delete data[item.id];
      else data[item.id] = item.previous;
      rowVersions.set(item.id, item.version + 1);
    }
  }
  function storagePatch(before, candidate) {
    const patch = {};
    for (const [id, row] of Object.entries(candidate)) {
      if (before[id] !== row) patch[translationSessionRunKey(id)] = { version: 1, row };
    }
    for (const id of Object.keys(before)) {
      if (candidate[id]) continue;
      patch[translationSessionRunKey(id)] = { version: 1, deleted: true, id, updatedAt: now() };
    }
    return patch;
  }
  async function drainId(id) {
    const queue = queues.get(id);
    try {
      await load();
      while (queue?.length) {
        // Preserve reducer order for one run and coalesce its burst into one
        // durable write. Different run IDs no longer wait behind this write.
        const batch = queue.splice(0, 32), results = [];
        let working = data;
        for (const task of batch) {
          try {
            const next = await task.change(structuredClone(working[id] || null));
            const updated = candidateFor(working, id, next);
            const result = structuredClone(updated[id] || null);
            working = updated;
            results.push({ task, result });
          } catch (error) { task.reject(error); }
        }
        if (!results.length) continue;
        let before, candidate, patch, affected;
        try {
          // Reducers may yield. Re-apply this run's final row to the newest
          // global snapshot before reserving quota and writing its own key.
          before = data;
          candidate = candidateFor(before, id, working[id] || null);
          patch = storagePatch(before, candidate);
          affected = reserve(candidate);
          if (Object.keys(patch).length) {
            try { await area().set(patch); }
            catch (error) {noteSessionStorageFailure('translation_run',error);throw error;}
          }
          for (const { task, result } of results) task.resolve(result);
          // The current run cannot be recreated by another drain until this one
          // releases ownership, so its own tombstone can be cleaned safely.
          if (!candidate[id] && patch[translationSessionRunKey(id)]) {
            try { await area().remove?.(translationSessionRunKey(id)); } catch {}
          }
        } catch (error) {
          if (affected) rollback(affected);
          for (const { task } of results) task.reject(error);
        }
      }
    } catch (error) {
      for (const task of queue?.splice(0) || []) task.reject(error);
    } finally {
      runningIds.delete(id);
      if (!queue?.length) queues.delete(id);
      else { runningIds.add(id); queueMicrotask(() => { void drainId(id); }); }
    }
  }
  function update(id, change) {
    id = String(id || '');
    const queue = queues.get(id) || [];
    if (!queues.has(id)) queues.set(id, queue);
    const work = new Promise((resolve, reject) => queue.push({ id, change, resolve, reject }));
    const settled = work.then(() => {}, () => {});
    tails.set(id, settled);
    outstanding.add(settled);
    void settled.then(() => {
      outstanding.delete(settled);
      if (tails.get(id) === settled) tails.delete(id);
    });
    if (!runningIds.has(id)) {
      runningIds.add(id);
      queueMicrotask(() => { void drainId(id); });
    }
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
