/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
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

  /** Tear down the keep-alive port + timer. */
  function stop() {
    stopAt = 0;
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
        port.onDisconnect.addListener(stop);
      } catch {
        stop();
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
        stop();
      }
    };
    ping();
    if (!timer) timer = setInterval(ping, PING_MS);
  }

  TP.keepAlive = { start, stop };
})();
