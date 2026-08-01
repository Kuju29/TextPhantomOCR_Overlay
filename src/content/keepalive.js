/**
 *
 * STATUS: ACTIVE — in use in the current flow.
 * Keep-alive connection.
 *
 * While a batch runs, the content script holds a `chrome.runtime` port open so
 * the service worker isn't suspended (and so the SW can detect the page
 * unloading). The port is pinged periodically and auto-closes after a deadline.
 */

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const PORT_NAME = "TP_KEEPALIVE";
  const PING_MS = 20_000;
  const DEFAULT_DURATION_MS = 10 * 60 * 1000;

  let port = null;
  let timer = null;
  let stopAt = 0;

  /** Drop the port + timer but KEEP the deadline (so we can resume later). */
  function teardownPort() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (port) {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      port = null;
    }
  }

  /** Fully stop the keep-alive and forget the deadline. */
  function stop() {
    stopAt = 0;
    teardownPort();
  }

  /**
   * The port closed from the other end. Chrome force-closes it when the page is
   * frozen into the back/forward cache; if we don't READ runtime.lastError here
   * it logs "Unchecked runtime.lastError: ...moved into back/forward cache...".
   * Read it to acknowledge the expected close, and keep the deadline so a
   * bfcache restore (pageshow) can re-open the port.
   */
  function onPortDisconnect() {
    void chrome.runtime?.lastError;
    teardownPort();
  }

  /**
   * Start (or extend) the keep-alive for `ms` milliseconds.
   * @param {number} [ms]
   */
  function start(ms) {
    const duration = Number(ms) > 0 ? Number(ms) : DEFAULT_DURATION_MS;
    stopAt = Math.max(stopAt || 0, Date.now() + duration);

    if (!port) {
      try {
        port = chrome.runtime.connect({ name: PORT_NAME });
        port.onDisconnect.addListener(onPortDisconnect);
      } catch {
        teardownPort();
        return;
      }
    }

    const ping = () => {
      if (!port) return;
      if (stopAt && Date.now() >= stopAt) {
        stop();
        return;
      }
      try {
        port.postMessage({ type: "TP_KEEPALIVE", ts: Date.now() });
      } catch {
        teardownPort();
      }
    };
    ping();
    if (!timer) timer = setInterval(ping, PING_MS);
  }

  // Back/forward cache handling. A live port left open while the page freezes
  // into the bfcache is force-closed by Chrome and logs an "Unchecked
  // runtime.lastError". Close it OURSELVES before the freeze (a self-disconnect
  // is clean and does not fire onDisconnect), keeping the deadline; then re-open
  // on restore if the keep-alive is still meant to be running. A real unload
  // (not persisted) is a full stop.
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) teardownPort();
    else stop();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && stopAt && Date.now() < stopAt) start(stopAt - Date.now());
  });

  TP.keepAlive = { start, stop };
})();
