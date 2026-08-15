/**
 *
 * Tiny namespaced console logger shared by the service worker, popup and viewer.
 *
 * Defaults to warnings/errors. The API capability response may raise it for a
 * deliberate diagnostics session; ordinary browsing must not become a second
 * trace console.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevelName = "warn";
try {
  if (typeof window !== "undefined" && window.LOG_LEVEL) {
    currentLevelName = String(window.LOG_LEVEL).toLowerCase();
  }
} catch {
  /* service worker has no window */
}
let currentLevel = LEVELS[currentLevelName] ?? LEVELS.warn;

/** Change the visible console threshold without affecting the diagnostic sink. */
export function setLogLevel(name) {
  const next = String(name || "").trim().toLowerCase();
  currentLevelName = Object.hasOwn(LEVELS, next) ? next : "warn";
  currentLevel = LEVELS[currentLevelName];
  return currentLevelName;
}

export const getLogLevel = () => currentLevelName;

/** Trim long strings so log lines stay readable. */
function safeSerialize(value) {
  if (typeof value === "string" && value.length > 500) {
    return value.slice(0, 500) + "…";
  }
  return value;
}

/** Render an argument so it survives a console that flattens it to a string.
 *
 * `console.warn(msg, obj)` is expandable in DevTools and the literal text
 * "[object Object]" everywhere else — copied lines, screenshots, bug reports.
 * The structured object still goes to the log FILE untouched; only the console
 * copy is flattened.
 */
function readable(value) {
  if (typeof value === "string" || value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return `[unserialisable ${Object.prototype.toString.call(value)}]`;
  }
}

/**
 * Create a logger bound to `namespace`.
 * @param {string} namespace
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
/**
 * Where log lines go besides the console, if anywhere.
 *
 * Injected rather than imported so this module stays usable in contexts that
 * have no sink (the popup, tests) and so a sink failure can never reach the
 * caller of `log.info()`.
 */
let sink = null;

/** Route every line through `fn(record)` as well as the console. */
export function setLogSink(fn) {
  sink = typeof fn === "function" ? fn : null;
}

export function createLogger(namespace) {
  const emit = (level, args) => {
    // The SINK gets every level regardless of the console threshold: raising
    // the console level is about noise, and the file exists to answer "what
    // happened" afterwards — the debug lines are the ones that explain a
    // decision.
    if (sink) {
      try {
        const [message, ...rest] = args;
        sink({
          ns: namespace,
          level,
          msg: typeof message === "string" ? message : safeSerialize(message),
          data: rest.length === 1 ? safeSerialize(rest[0]) : rest.map(safeSerialize),
          t: Date.now(),
        });
      } catch {
        /* the sink must never break the caller */
      }
    }
    if (LEVELS[level] < currentLevel) return;
    const prefix = `[${new Date().toISOString()}][${namespace}][${level.toUpperCase()}]`;
    const out = args.map((a) => readable(safeSerialize(a)));
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
