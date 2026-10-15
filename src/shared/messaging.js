/**
 * Promise wrappers around the `chrome.runtime` / `chrome.tabs` messaging APIs.
 * They swallow `chrome.runtime.lastError` (thrown asynchronously when there is
 * no receiver) and resolve to `null` instead.
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
        try {
          resolve(chrome.runtime.lastError ? null : (resp ?? null));
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** Fire-and-forget runtime broadcast (errors ignored). */
export function broadcast(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      try {
        void chrome.runtime.lastError;
      } catch {
        /* extension reloaded before the callback */
      }
    });
  } catch {
    /* no receiver */
  }
}
