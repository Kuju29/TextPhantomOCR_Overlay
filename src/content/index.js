// Content-script bootstrap: configures logging and tracing, then marks the script ready.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  try {
    chrome.runtime.sendMessage({ type: "TP_TRACE_STATE" }, (resp) => {
      void chrome.runtime.lastError;
      const detail = resp?.detail === "full" ? "full" : resp?.enabled ? "compact" : "off";
      TP.setLogLevel?.(resp?.consoleLevel || "warn");
      TP.setTracingEnabled?.(Boolean(resp?.enabled), detail);
      const wrapped = detail === "full" ? (TP.installTrace?.() || 0) : 0;
      if (resp?.enabled) TP.traceNote?.("content/index.js", "ready", { detail, wrapped });
    });
  } catch {
  }

  TP.ready = true;
  TP.log.debug("content script ready");
})();
