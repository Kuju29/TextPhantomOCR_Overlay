// Holds a runtime port open while a batch runs so the service worker stays alive.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const PORT_NAME = "TP_KEEPALIVE";
  const PING_MS = 20_000;
  const DEFAULT_DURATION_MS = 10 * 60 * 1000;

  let port = null;
  let timer = null;
  let stopAt = 0;

  // Closes the port and timer while keeping the deadline so it can resume.
  function teardownPort() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (port) {
      try {
        port.disconnect();
      } catch {
      }
      port = null;
    }
  }

  // Stops the keep-alive and forgets the deadline.
  function stop() {
    stopAt = 0;
    teardownPort();
  }

  // Acknowledges a close from the other end and keeps the deadline for a later restore.
  function onPortDisconnect() {
    void chrome.runtime?.lastError;
    teardownPort();
  }

  // Starts or extends the keep-alive for the given number of milliseconds.
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

  window.addEventListener("pagehide", (e) => {
    if (e.persisted) teardownPort();
    else stop();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && stopAt && Date.now() < stopAt) start(stopAt - Date.now());
  });

  TP.keepAlive = { start, stop };
})();
