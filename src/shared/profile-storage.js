/** Field-level profile mutations. The background worker is the single storage writer. */
import { getStorage, setStorage } from './storage.js';
import { sendRuntimeMessage } from './messaging.js';
export const PROFILE_KEYS = ['aiProfilesV1', 'paidAiProfilesV1', 'loginAiProfilesV1', 'aiProfilePromptsV1', 'aiProfileCredentialsV1'];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export function profileChanges(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (object(after) && (object(before) || before == null))
    return [...new Set([...Object.keys(before || {}), ...Object.keys(after)])].flatMap(k =>
      profileChanges(before?.[k], after[k], [...path, k]));
  return [{path, ...(after === undefined ? {remove:true} : {value:structuredClone(after)})}];
}
function applyProfileChanges(current, changes) {
  const result = structuredClone(current);
  for (const {path, value, remove} of changes) {
    if (!Array.isArray(path) || !PROFILE_KEYS.includes(path[0]) || path.length < 1 ||
        path.some(k => typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k)))
      throw new Error('Invalid profile storage field');
    let parent = result;
    for (const k of path.slice(0, -1)) {
      if (!object(parent[k])) parent[k] = {};
      parent = parent[k];
    }
    if (remove) delete parent[path.at(-1)];
    else parent[path.at(-1)] = structuredClone(value);
  }
  return result;
}
export async function commitProfileChanges(changes) {
  if (!changes.length) return;
  const response = await sendRuntimeMessage({type:'AI_PROFILE_PATCH', changes});
  if (!response?.ok) throw new Error(response?.error || 'Could not save AI profile settings');
}
let queue = Promise.resolve();
export function writeProfileChanges(changes) {
  const run = async () => {
    const current = await getStorage(PROFILE_KEYS);
    const merged = applyProfileChanges(current, changes);
    const keys = [...new Set(changes.map(c => c.path[0]))];
    await setStorage(Object.fromEntries(keys.map(k => [k, merged[k]])));
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
