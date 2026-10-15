// Checkpoints for this browser session, NOT settings and NOT a live stream.
// Never falls back to disk/local storage for OCR, results or run access tokens.
import { noteSessionStorageFailure } from './session-storage-diagnostics.js';
const TRANSLATION_SESSION_KEY = 'tpTranslationRunsV1'; // legacy aggregate key
const TRANSLATION_SESSION_RUN_PREFIX = 'tpTranslationRunV1:';
export const translationSessionRunKey = id => `${TRANSLATION_SESSION_RUN_PREFIX}${encodeURIComponent(String(id || ''))}`;
const PRIVATE_FIELDS = /^(?:api_?key|price_?quote_?token|aiPaidQuoteToken|paidPriceQuoteToken|x-tp-run-token|authorization|credential|credentials|imageDataUri|sourceImageDataUri|dataUri|image_b64|images|rawResponse|rawStream)$/i;
export function sessionSafe(value) {
  if (Array.isArray(value)) return value.map(sessionSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.test(key) && !['__proto__','constructor','prototype'].includes(key))
    .map(([key, item]) => [key, sessionSafe(item)]));
  return value;
}
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;

// Runs that stopped without finishing (repair unavailable/paused/failed)
// may be evicted when the budget is needed, but only after this idle period so a
// run that has just paused is not discarded while its batch is still settling.
// Terminal runs (done/apply_failed/cancelled) are evicted first, oldest first.
const TERMINAL_RUN_PHASES = ['done','apply_failed','cancelled'];
const STOPPED_RUN_PHASES = ['unavailable','failed','blocked'];
export function createTranslationSessionStore({
  area = () => globalThis.chrome?.storage?.session,
  now = Date.now, maxBytes = 6 * 1024 * 1024, maxRuns = 24,
  ttlMs = 6 * 60 * 60 * 1000, stoppedIdleMs = 5 * 60 * 1000,
} = {}) {
  let data = {}, loaded = null;
  // Bytes of per-page journal keys (prepared pages / dispatch receipts)
  // by owning run ID. They live in the same storage.session area, so they share
  // the run checkpoint budget (`maxBytes` covers run rows + their journals).
  const journalBytes = new Map();
  const journalTotal = id => { let n = 0; for (const b of journalBytes.get(String(id))?.values() || []) n += b; return n; };
  const allJournalBytes = () => { let n = 0; for (const id of journalBytes.keys()) n += journalTotal(id); return n; };
  const noteJournal = (id, key, bytes) => {
    id = String(id); const rows = journalBytes.get(id) || new Map();
    if (bytes == null) rows.delete(key); else rows.set(key, bytes);
    if (rows.size) journalBytes.set(id, rows); else journalBytes.delete(id);
  };
  const queues = new Map(), runningIds = new Set(), tails = new Map(), outstanding = new Set();
  const rowVersions = new Map();
  // Stored rows are immutable internally; callers and reducers receive clones.
  // Cache only their exact UTF-8 JSON sizes, never a guessed byte estimate.
  const rowSizes = new WeakMap();
  const journalPrefixes = ['tpTranslationPreparedPageV1:', 'tpTranslationDispatchV1:'];
  const journalOwner = key => {
    const prefix = journalPrefixes.find(value => key.startsWith(value));
    if (!prefix) return '';
    try { return decodeURIComponent(key.slice(prefix.length).split(':')[0]); } catch { return ''; }
  };
  async function retireJournals(ids, {expiredOnly=false} = {}) {
    if (!ids.size) return;
    const storage = area(), versions = new Map([...ids].map(id => [id, rowVersions.get(id)]));
    const all = await storage.get(null);
    // A newly restored owner wins over an old retirement snapshot. Unknown
    // in-flight receipts are retained until the existing six-hour expiry.
    const owners = await storage.get([...ids].map(translationSessionRunKey));
    const keys = Object.keys(all || {}).filter(key => {
      const id = journalOwner(key);
      if (!ids.has(id) || data[id] || rowVersions.get(id) !== versions.get(id)) return false;
      if (expiredOnly && !(Number(all[key]?.createdAt) > 0 && now() - Number(all[key].createdAt) >= ttlMs)) return false;
      const saved = owners?.[translationSessionRunKey(id)];
      return !saved?.row || saved.deleted === true;
    });
    if (keys.length) await storage.remove?.(keys);
    for (const key of keys) noteJournal(journalOwner(key), key, null);
  }
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
      const recovered = {}, expiredOwners = new Set(), expiredOrphans = new Set();
      for (const row of Object.values(got?.[TRANSLATION_SESSION_KEY]?.runs || {})) {
        if (row?.id && now() - Number(row.createdAt || 0) < ttlMs) recovered[row.id] = row;
        else if (row?.id) expiredOwners.add(String(row.id));
      }
      const staleKeys = [];
      for (const [key, value] of Object.entries(got || {})) {
        if (!key.startsWith(TRANSLATION_SESSION_RUN_PREFIX)) continue;
        const row = value?.row;
        if (value?.deleted === true || !row?.id || now() - Number(row.createdAt || 0) >= ttlMs) {
          staleKeys.push(key);
          if (row?.id && now() - Number(row.createdAt || 0) >= ttlMs) expiredOwners.add(String(row.id));
          continue;
        }
        const prior = recovered[row.id];
        if (!prior || Number(row.updatedAt || 0) >= Number(prior.updatedAt || 0)) recovered[row.id] = row;
      }
      data = recovered;
      for (const [key, value] of Object.entries(got || {})) {
        const id = journalOwner(key);
        if (id || journalPrefixes.some(prefix => key.startsWith(prefix))) noteJournal(id, key, size(key) + 1 + size(value));
        if (id && !data[id] && Number(value?.createdAt) > 0 && now() - Number(value.createdAt) >= ttlMs)
          expiredOrphans.add(id);
      }
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
      try { await retireJournals(expiredOwners); } catch {}
      try { await retireJournals(expiredOrphans, {expiredOnly:true}); } catch {}
    })();
    return loaded;
  }
  // Oldest-first eviction order: terminal runs, then runs stopped (repair
  // unavailable/failed/paused) and idle >= stoppedIdleMs. Active runs
  // (collecting/repairing/applying/...) and runs with a queued update are never
  // victims: their journals are the only durable source/receipt for repair.
  function evictionOrder(candidate, keep) {
    const idle = row => !runningIds.has(String(row.id)) && String(row.id) !== String(keep);
    const byAge = (a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
    const rows = Object.values(candidate);
    return [...rows.filter(row => idle(row) && TERMINAL_RUN_PHASES.includes(row.phase)).sort(byAge),
      ...rows.filter(row => idle(row) && STOPPED_RUN_PHASES.includes(row.phase) &&
        now() - Number(row.updatedAt || 0) >= stoppedIdleMs).sort(byAge)];
  }
  function checkpointBytes(candidate) {
    let count = Object.keys(candidate).length, bytes = 2 + Math.max(0, count - 1);
    for (const [key, row] of Object.entries(candidate)) bytes += entrySize(key, row);
    return bytes + allJournalBytes();
  }
  function limitError() {
    return Object.assign(new Error('Active translation checkpoints reached their session storage limit'), { code: 'session_checkpoint_limit' });
  }
  function candidateFor(current, id, next) {
      const candidate = { ...current };
      if (next == null) delete candidate[id];
      else candidate[id] = sessionSafe({ ...next, id, updatedAt: now() });
      for (const [key, row] of Object.entries(candidate)) {
        if (key !== id && !runningIds.has(key) && now() - Number(row.createdAt || 0) >= ttlMs) delete candidate[key];
      }
      const victims = evictionOrder(candidate, id);
      let count = Object.keys(candidate).length;
      let bytes = checkpointBytes(candidate);
      while ((count > maxRuns || bytes > maxBytes) && victims.length) {
        const key = String(victims.shift().id);
        // An evicted run's journals are retired after this transition commits.
        bytes -= entrySize(key, candidate[key]) + (count > 1 ? 1 : 0) + journalTotal(key);
        count--;
        delete candidate[key];
      }
      // Removing a row never needs room; only a write may hit the limit.
      if (next != null && (count > maxRuns || bytes > maxBytes)) throw limitError();
      return candidate;
  }
  // Journal admission. A journal write first makes room by evicting
  // whole old runs (row + journals) in evictionOrder, or journals whose owner
  // run no longer exists. If the budget still cannot hold it, the write is
  // refused with session_checkpoint_limit before touching storage; the
  // coordinator then marks repair unavailable for that run (initial
  // translation continues) instead of dropping a receipt that repair needs.
  async function admitJournal(runId, key, bytes) {
    await load();
    runId = String(runId);
    const previous = journalBytes.get(runId)?.get(key);
    noteJournal(runId, key, bytes);
    const undo = () => { if (journalBytes.get(runId)?.get(key) === bytes) noteJournal(runId, key, previous ?? null); };
    try {
      for (let guard = 0; checkpointBytes(data) > maxBytes && guard < maxRuns + 64; guard++) {
        const orphan = [...journalBytes.keys()].find(id => id !== runId && !data[id] && !runningIds.has(id) && !queues.has(id));
        if (orphan) {
          const keys = [...journalBytes.get(orphan).keys()];
          await area().remove?.(keys);
          for (const k of keys) noteJournal(orphan, k, null);
          continue;
        }
        const victim = evictionOrder(data, runId)[0];
        if (!victim) break;
        await update(victim.id, () => null);
        // retireJournals already ran for the committed deletion; anything it
        // kept (a newer owner snapshot) stays counted and stops the loop below.
        if (data[victim.id]) break;
        if (journalBytes.has(String(victim.id))) {
          const keys = [...journalBytes.get(String(victim.id)).keys()];
          await area().remove?.(keys);
          for (const k of keys) noteJournal(victim.id, k, null);
        }
      }
      if (checkpointBytes(data) > maxBytes) throw limitError();
    } catch (error) { undo(); throw error; }
    return undo;
  }
  const journalBudget = {
    admit: admitJournal,
    forget(runId, keys) { for (const key of [].concat(keys)) noteJournal(runId, key, null); },
  };
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
        // durable write; other run IDs do not wait behind it.
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
          const retired = new Set(affected.filter(item => !item.applied).map(item => item.id));
          // Retirement is cleanup after a committed transition, never a reason
          // to roll back a checkpoint that the browser already accepted.
          if (retired.size) { try { await retireJournals(retired); } catch {} }
          // The current run cannot be recreated by another drain until this one
          // releases ownership, so its own tombstone can be cleaned safely.
          if (!candidate[id] && patch[translationSessionRunKey(id)]) {
            try {
              const key = translationSessionRunKey(id), saved = (await area().get(key))?.[key];
              if (!data[id] && saved?.deleted === true && saved.updatedAt === patch[key].updatedAt)
                await area().remove?.(key);
            } catch {}
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
    journalBudget,
    async usage() { await load(); return {runs:Object.keys(data).length, bytes:checkpointBytes(data),
      journalBytes:allJournalBytes(), maxBytes, maxRuns}; },
  };
}
export const translationSessions = createTranslationSessionStore();
