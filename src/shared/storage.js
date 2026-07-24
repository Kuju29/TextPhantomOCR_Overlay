/**
 * Promise wrappers around `chrome.storage.local`.
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 */

/**
 * Read keys from `chrome.storage.local`.
 * @param {string[]|Record<string,*>} keys - key list, or `{key: default}` map
 * @returns {Promise<Record<string,*>>}
 */
export function getStorage(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (items) => resolve(items || {}));
    } catch {
      resolve({});
    }
  });
}

/**
 * Write a patch into `chrome.storage.local`.
 * @param {Record<string,*>} patch
 * @returns {Promise<void>}
 */
export function setStorage(patch) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(patch, () => resolve());
    } catch {
      resolve();
    }
  });
}
