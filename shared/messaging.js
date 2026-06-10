/**
 * Promise wrappers around the `chrome.runtime` / `chrome.tabs` messaging APIs.
 *
 * All helpers swallow `chrome.runtime.lastError` (the messaging APIs throw it
 * asynchronously when there is no receiver) and resolve to `null` instead, so
 * callers can simply `await` them.
 */

/**
 * Send a message to the service worker (or other extension pages).
 * @param {*} message
 * @returns {Promise<*|null>} the response, or null on error
 */
export function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Fire-and-forget runtime broadcast (errors ignored). */
export function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    /* no receiver */
  }
}

/**
 * Send a message to a specific tab/frame.
 * @param {number} tabId
 * @param {*} message
 * @param {number} [frameId]
 * @returns {Promise<{ok:boolean, resp:*, err:string|null}>}
 */
export function sendTabMessage(tabId, message, frameId = 0) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: Number(frameId) || 0 }, (resp) => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err, resp: resp ?? null, err: err?.message || null });
      });
    } catch (e) {
      resolve({ ok: false, resp: null, err: e?.message || String(e) });
    }
  });
}
