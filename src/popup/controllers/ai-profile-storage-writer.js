/** Merge changed profile fields across Popup and Prompt Studio without stale map writes. */
import { PROFILE_KEYS, profileChanges, commitProfileChanges } from '../../shared/profile-storage.js';
export function createAiProfileStorageWriter(write, {onError, onSaved} = {}) {
  let baseline = {};
  let active = false;
  let failedChanges = [], lastError = null;
  const queue = [], idle = [];
  const run = entry => {
    active = true;
    let result;
    // Start the first write synchronously, including during popup pagehide.
    try { result = Promise.resolve(entry.run()); }
    catch (error) { result = Promise.reject(error); }
    result.then(entry.resolve, entry.reject).finally(() => {
      const next = queue.shift();
      if (next) run(next);
      else { active = false; while (idle.length) idle.shift()(); }
    });
  };
  const persist = patch => {
    if (!PROFILE_KEYS.some(key => Object.prototype.hasOwnProperty.call(patch || {}, key))) return write(patch);
    const snapshot = structuredClone(patch);
    const changes = PROFILE_KEYS.filter(k => Object.hasOwn(snapshot, k)).flatMap(k => profileChanges(baseline[k], snapshot[k], [k]));
    const ordinary = Object.fromEntries(Object.entries(snapshot).filter(([k]) => !PROFILE_KEYS.includes(k)));
    Object.assign(baseline, snapshot);
    const writeChanges = async () => {
      // Preserve failed intent even when the next snapshot equals the optimistic
      // baseline. Newer edits to the same field win; other entries remain scoped.
      const merged = new Map([...failedChanges, ...changes].map(change => [JSON.stringify(change.path), change]));
      const pending = [...merged.values()];
      try {
        if (globalThis.chrome?.runtime?.id && globalThis.chrome.runtime.sendMessage) {
          await commitProfileChanges(pending);
          if (Object.keys(ordinary).length) await write(ordinary);
        } else await write(snapshot);
        failedChanges = []; lastError = null;
        try {onSaved?.();} catch {}
      } catch (error) {
        failedChanges = pending; lastError = error;
        try {onError?.(error);} catch {}
        throw error;
      }
    };
    return new Promise((resolve,reject) => {
      const entry = {run:writeChanges,resolve,reject};
      if (active) queue.push(entry); else run(entry);
    });
  };
  persist.seed = stored => { baseline = structuredClone(stored || {}); };
  persist.orderedProfileWrites = true;
  persist.whenIdle = async () => {
    if (active) await new Promise(resolve => idle.push(resolve));
    if (lastError) throw lastError;
  };
  return persist;
}
