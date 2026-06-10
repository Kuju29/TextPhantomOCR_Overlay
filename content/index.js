/**
 * Content-script bootstrap (runs last).
 *
 * By the time this file executes, every sibling module has attached its
 * helpers to `window.__TP`. There is nothing to wire up imperatively — the
 * `chrome.runtime.onMessage` listener (messaging.js) and the MangaDex
 * observers (mangadex.js) install themselves on load. This file just records
 * that the content script finished initialising.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  TP.ready = true;
  TP.log.debug("content script ready");
})();
