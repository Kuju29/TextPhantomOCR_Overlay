/**
 * Content-script bootstrap + shared namespace.
 *
 * The content script is split across several classic (non-module) files that
 * all run in the same isolated world. They share a single namespace object,
 * `window.__TP` — each file attaches its public helpers to it, and cross-file
 * calls go through `TP.xxx` so load order between sibling modules doesn't
 * matter (only this file must run first).
 *
 * A double-load guard makes re-injection (or the viewer page also loading the
 * scripts) a no-op for every file: they all check `TP.bail`.
 */

(function () {
  // Already loaded once in this world — mark bail so sibling files skip.
  if (globalThis.__TextPhantomContentLoaded) {
    window.__TP = window.__TP || {};
    window.__TP.bail = true;
    return;
  }
  globalThis.__TextPhantomContentLoaded = true;

  /** @type {object} shared namespace for the content-script modules */
  const TP = (window.__TP = { bail: false });

  // --- Lightweight console logger -----------------------------------------
  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const CURRENT = LEVELS.debug;
  function emit(level, args) {
    if (LEVELS[level] < CURRENT) return;
    const prefix = `[${new Date().toISOString()}][content][${level.toUpperCase()}]`;
    (console[level] || console.log)(prefix, ...args);
  }
  TP.log = {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
  };

  // --- Environment --------------------------------------------------------
  TP.version = (() => {
    try {
      return (chrome?.runtime?.getManifest?.() || {}).version || "";
    } catch {
      return "";
    }
  })();
  TP.isTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  /** Truncate a value for log lines. */
  TP.truncate = (s, len = 180) => {
    if (!s) return s;
    try {
      s = String(s);
    } catch {
      return s;
    }
    return s.length > len ? s.slice(0, len) + "…" : s;
  };

  // --- Tell the service worker we're alive --------------------------------
  try {
    chrome.runtime.sendMessage(
      { type: "TP_CONTENT_READY", href: location.href, ver: TP.version, top: TP.isTop },
      () => void chrome.runtime.lastError,
    );
  } catch {
    /* SW not ready */
  }

  // --- Notify the SW of SPA navigation (top frame only) -------------------
  if (TP.isTop && !globalThis.__tpLocationNotifyInstalled) {
    globalThis.__tpLocationNotifyInstalled = true;
    let lastHref = location.href;
    let canSend = true;
    const notify = () => {
      if (!canSend || location.href === lastHref) return;
      lastHref = location.href;
      try {
        chrome.runtime.sendMessage(
          { type: "TP_LOCATION_CHANGED", href: location.href, top: true, ver: TP.version },
          () => void chrome.runtime.lastError,
        );
      } catch {
        canSend = false;
      }
    };
    for (const name of ["pushState", "replaceState"]) {
      const orig = history[name];
      if (typeof orig === "function") {
        history[name] = function (...args) {
          const r = orig.apply(this, args);
          Promise.resolve().then(notify);
          return r;
        };
      }
    }
    addEventListener("popstate", notify, { passive: true });
    addEventListener("hashchange", notify, { passive: true });
  }

  TP.log.info("loaded", { href: location.href, ver: TP.version, top: TP.isTop });
})();
