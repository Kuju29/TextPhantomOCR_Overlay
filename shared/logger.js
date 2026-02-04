const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let CURRENT_LEVEL_NAME = "debug";

try {
  if (typeof window !== "undefined" && window.LOG_LEVEL)
    CURRENT_LEVEL_NAME = String(window.LOG_LEVEL).toLowerCase();
} catch {}

const CURRENT_LEVEL = LEVELS[CURRENT_LEVEL_NAME] ?? 0;

function formatTimestamp() {
  return new Date().toISOString();
}

function safeSerialize(v) {
  try {
    if (typeof v === "string") {
      return v.length > 500 ? v.slice(0, 500) + "…" : v;
    }
    return v;
  } catch {
    return v;
  }
}

export function createLogger(namespace) {
  function log(level, ...args) {
    if (LEVELS[level] >= CURRENT_LEVEL) {
      const prefix = `[${formatTimestamp()}][${namespace}][${level.toUpperCase()}]`;
      const out = args.map(safeSerialize);
      if (level === "debug") console.debug(prefix, ...out);
      else if (level === "info") console.info(prefix, ...out);
      else if (level === "warn") console.warn(prefix, ...out);
      else if (level === "error") console.error(prefix, ...out);
      else console.log(prefix, ...out);
    }
  }
  return {
    debug: (...a) => log("debug", ...a),
    info: (...a) => log("info", ...a),
    warn: (...a) => log("warn", ...a),
    error: (...a) => log("error", ...a),
  };
}
