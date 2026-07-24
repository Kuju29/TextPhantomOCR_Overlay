/**
 * Promise helpers implemented on top of callback-compatible `chrome.*`.
 *
 * Firefox's `chrome` namespace is callback-first while Chromium MV3 also
 * supports promises. Keeping all shared code on these wrappers prevents a
 * package from installing successfully and then failing only at runtime.
 */

function callbackPromise(register, fallback) {
  return new Promise((resolve, reject) => {
    try {
      register((value) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message || String(error)));
          return;
        }
        resolve(value ?? fallback);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function queryTabs(queryInfo = {}) {
  return callbackPromise((done) => chrome.tabs.query(queryInfo, done), []);
}

export function getTab(tabId) {
  return callbackPromise((done) => chrome.tabs.get(tabId, done), null);
}

export function createTab(createProperties) {
  return callbackPromise((done) => chrome.tabs.create(createProperties, done), null);
}
