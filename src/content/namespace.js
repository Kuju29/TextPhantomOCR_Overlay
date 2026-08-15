// Creates the window.__TP namespace, logger and environment shared by the content modules.

(function () {
  if (globalThis.__TextPhantomContentLoaded) {
    window.__TP = window.__TP || {};
    window.__TP.bail = true;
    return;
  }
  globalThis.__TextPhantomContentLoaded = true;

  const TP = (window.__TP = { bail: false });

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let currentLevelName = "warn";
  let currentLevel = LEVELS.warn;

  const RUN_ID = Math.random().toString(36).slice(2, 10);
  let lineNo = 0;

  // Forwards a log line to the service worker, which writes it to the log file.
  function relay(level, args) {
    try {
      const [message, ...rest] = args;
      chrome.runtime.sendMessage(
        {
          type: "TP_LOG",
          record: {
            ns: "content",
            level,
            msg: typeof message === "string" ? message : String(message),
            data: rest.length === 1 ? rest[0] : rest,
            href: location.href,
            run: RUN_ID,
            n: ++lineNo,
            t: Date.now(),
          },
        },
        () => void chrome.runtime.lastError,
      );
    } catch {
    }
  }

  // Converts a log argument into something that survives being flattened to text.
  function readable(value) {
    if (typeof value === "string" || value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return `[unserialisable ${Object.prototype.toString.call(value)}]`;
    }
  }

  function emit(level, args) {
    relay(level, args);
    if (LEVELS[level] < currentLevel) return;
    const prefix = `[${new Date().toISOString()}][content][${level.toUpperCase()}]`;
    (console[level] || console.log)(prefix, ...args.map(readable));
  }
  TP.log = {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
  };
  TP.setLogLevel = (name) => {
    const next = String(name || "").trim().toLowerCase();
    currentLevelName = Object.prototype.hasOwnProperty.call(LEVELS, next) ? next : "warn";
    currentLevel = LEVELS[currentLevelName];
    return currentLevelName;
  };
  TP.getLogLevel = () => currentLevelName;

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

  // Truncates a value for log lines.
  TP.truncate = (s, len = 180) => {
    if (!s) return s;
    try {
      s = String(s);
    } catch {
      return s;
    }
    return s.length > len ? s.slice(0, len) + "…" : s;
  };

  try {
    chrome.runtime.sendMessage(
      { type: "TP_CONTENT_READY", href: location.href, ver: TP.version, top: TP.isTop },
      () => void chrome.runtime.lastError,
    );
  } catch {
  }

  if (TP.isTop && !globalThis.__tpLocationNotifyInstalled) {
    globalThis.__tpLocationNotifyInstalled = true;
    let lastHref = location.href;
    let canSend = true;
    const notify = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      try {
        TP.resetForNavigation?.("spa_navigation");
      } catch (e) {
        TP.log.warn("navigation reset failed", { error: e?.message || String(e) });
      }
      if (!canSend) return;
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
