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
  const activeBatches = new Set();

  // Closes the port and timer while keeping the deadline so it can resume.
  function teardownPort({ graceful = false } = {}) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (port) {
      try {
        if (graceful)
          port.postMessage({ type: "TP_KEEPALIVE_GRACEFUL_STOP" });
      } catch {}
      const closing = port;
      port = null;
      setTimeout(() => {
        try {
          closing.disconnect();
        } catch {}
      }, 0);
    }
  }

  // Stops the keep-alive and forgets the deadline.
  function stop(batchId = "") {
    const id = String(batchId || "").trim();
    if (id) activeBatches.delete(id);
    else activeBatches.clear();
    if (activeBatches.size) return;
    stopAt = 0;
    teardownPort({ graceful: true });
  }

  // Acknowledges a close from the other end and keeps the deadline for a later restore.
  function onPortDisconnect() {
    void chrome.runtime?.lastError;
    teardownPort();
  }

  // Starts or extends the keep-alive for the given number of milliseconds.
  function start(ms, batchId = "") {
    const id = String(batchId || "").trim();
    if (id) activeBatches.add(id);
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
    else {
      try {
        port?.postMessage({ type: "TP_KEEPALIVE_PAGE_UNLOAD" });
      } catch {}
      activeBatches.clear();
      stopAt = 0;
      teardownPort();
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && stopAt && Date.now() < stopAt)
      start(stopAt - Date.now());
  });

  TP.keepAlive = { start, stop, activeCount: () => activeBatches.size };
})();
