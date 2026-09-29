/** Order only canonical profile snapshots; never queue translation/usage work. */
export function createAiProfileStorageWriter(write) {
  let active = false;
  const queue = [], idle = [];
  const run = entry => {
    active = true;
    let result;
    // Start the first write synchronously, including during popup pagehide.
    try { result = Promise.resolve(write(entry.patch)); }
    catch (error) { result = Promise.reject(error); }
    result.then(entry.resolve, entry.reject).finally(() => {
      const next = queue.shift();
      if (next) run(next);
      else { active = false; while (idle.length) idle.shift()(); }
    });
  };
  const persist = patch => {
    if (!Object.prototype.hasOwnProperty.call(patch || {}, 'aiProfilesV1')) return write(patch);
    const snapshot = structuredClone(patch);
    return new Promise((resolve,reject) => {
      const entry = {patch:snapshot,resolve,reject};
      if (active) queue.push(entry); else run(entry);
    });
  };
  persist.orderedProfileWrites = true;
  persist.whenIdle = () => active ? new Promise(resolve => idle.push(resolve)) : Promise.resolve();
  return persist;
}
