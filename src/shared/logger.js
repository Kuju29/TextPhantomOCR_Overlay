/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Tiny namespaced console logger shared by the service worker, popup and viewer.
 *
 * Level can be raised by setting `window.LOG_LEVEL` before this module loads;
 * defaults to "debug" (everything).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevelName = "debug";
try {
  if (typeof window !== "undefined" && window.LOG_LEVEL) {
    currentLevelName = String(window.LOG_LEVEL).toLowerCase();
  }
} catch {
  /* service worker has no window */
}
const CURRENT_LEVEL = LEVELS[currentLevelName] ?? 0;

/** Trim long strings so log lines stay readable. */
function safeSerialize(value) {
  if (typeof value === "string" && value.length > 500) {
    return value.slice(0, 500) + "…";
  }
  return value;
}

/**
 * Create a logger bound to `namespace`.
 * @param {string} namespace
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
export function createLogger(namespace) {
  const emit = (level, args) => {
    if (LEVELS[level] < CURRENT_LEVEL) return;
    const prefix = `[${new Date().toISOString()}][${namespace}][${level.toUpperCase()}]`;
    const out = args.map(safeSerialize);
    const fn = console[level] || console.log;
    fn(prefix, ...out);
  };
  return {
    debug: (...a) => emit("debug", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
  };
}
