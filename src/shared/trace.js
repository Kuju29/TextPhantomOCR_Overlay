/**
 *
 * Function-level trace, browser side. Ships to the API's ONE trace file.
 *
 * Why this is not `logger.js`
 * `logger.js` records decisions and writes them to the console as well as the
 * file. This records the PATH — every function entered, what it got, what it
 * returned — and never touches the console. Two reasons, both learned:
 *
 * 1. A trace on the console is unusable: one image is hundreds of lines and it
 *    buries the handful of warnings that matter.
 * 2. A trace that annoys people gets switched off, and a switched-off trace
 *    answers nothing.
 *
 * The file lives on the API (`POST /v1/trace`), interleaved with the server's
 * own lines by `trace` id, so ONE file holds the whole journey — click,
 * request, pipeline, response, insertion — in order. That is the point: the
 * bug this was built for (a client renderer that had refused 100% of images
 * since it shipped) was invisible precisely because the browser half and the
 * server half were never in the same place.
 *
 * One switch, on the server
 * There is no separate extension setting. `features.trace` from
 * `/v1/capabilities` decides. Two switches would let a run produce half a
 * trace, and a missing half reads as "that function was never called" — which
 * is the exact wrong conclusion, and the one that cost this project a day.
 */

const MAX_BUFFER = 4000;
const FLUSH_AFTER_MS = 1000;
const FLUSH_AT_COUNT = 400;
const MAX_BATCH = 2000;
/** Give up after this many failed shipments; a dead endpoint stays dead. */
const FAILURE_BUDGET = 3;

let enabled = false;
let detail = "off";
let baseUrlProvider = null;
let buffer = [];
let dropped = 0;
let timer = null;
let shipping = false;
let consecutiveFailures = 0;
let lineNo = 0;
let activeSession = "";
let refreshCapabilitiesProvider = null;
const clientBuild = (() => {
  try { return String(globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown"); }
  catch { return "unknown"; }
})();
const producerId = (() => {
  try { return String(globalThis.crypto?.randomUUID?.() || `worker-${Date.now()}-${Math.random()}`); }
  catch { return `worker-${Date.now()}-${Math.random()}`; }
})();

async function shipmentSignature(value) {
  const text = JSON.stringify(value);
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Deterministic fallback for old runtimes. Producer identity still keeps
    // shipments apart; this hash only makes exact lost-ACK retries stable.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `fnv-${(hash >>> 0).toString(16)}`;
  }
}

/** The trace id every line in this context is stamped with. */
let currentTrace = "";

/** A fresh id for one image's journey. Short: it is read by eye, a lot. */
export function newTraceId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function setTrace(id) {
  const previous = currentTrace;
  currentTrace = String(id || "");
  return previous;
}

export const getTrace = () => currentTrace;

/** Turn shipping on/off. Called with what `/v1/capabilities` reported. */
export function setTracingEnabled(
  on,
  getBaseUrl,
  traceDetail = "compact",
  traceSession = "",
  refreshCapabilities = null,
) {
  const nextEnabled = Boolean(on);
  const nextSession = String(traceSession || "");
  const sessionChanged = Boolean(nextSession) && nextSession !== activeSession;
  const becameEnabled = nextEnabled && !enabled;
  if (sessionChanged) {
    // Records buffered for an API process that has ended do not belong in the
    // new process's file.  Start the new story cleanly.
    dropped += buffer.length;
    buffer = [];
    activeSession = nextSession;
  }
  if (sessionChanged || becameEnabled) consecutiveFailures = 0;
  enabled = nextEnabled;
  detail = enabled && String(traceDetail || "").toLowerCase() === "full" ? "full" : enabled ? "compact" : "off";
  if (getBaseUrl) baseUrlProvider = getBaseUrl;
  if (refreshCapabilities) refreshCapabilitiesProvider = refreshCapabilities;
  if (!enabled) {
    buffer = [];
    dropped = 0;
    consecutiveFailures = 0;
  }
}

export const isTracing = () => enabled;
export const getTraceDetail = () => detail;

// value shortening
// A trace line is a debugging aid, not a data export. Long values are cut and
// the cut is shown, because a value that silently vanished is worse than one
// that is visibly short.

const MAX_STR = 200;
const MAX_ITEMS = 12;
const SECRET_HINTS = ["api_key", "apikey", "key", "token", "secret", "password", "cookie", "auth"];

/** Redact credentials even when they are embedded in a URL or error string. */
export function sanitizeTraceString(value) {
  return String(value ?? "")
    .replace(/\b(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|password|secret|signature|sig|policy|key-pair-id|x-amz-[^=&#\s]+|x-goog-[^=&#\s]+)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/\b((?:proxy-)?authorization)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/gi, "$1$2<redacted>")
    .replace(/\b((?:set-)?cookie)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/gi, "$1$2<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]{6,}/gi, "Bearer <redacted>")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "<redacted>")
    .replace(/\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization|cookie)(\s*[:=]\s*)[^\s,;&]+/gi, "$1$2<redacted>");
}

const isSecret = (name) => {
  const low = String(name).toLowerCase();
  return SECRET_HINTS.some((h) => low.includes(h));
};

export function shortenValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "boolean") return value;
  if (t === "number") return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : String(value);
  if (t === "string") {
    const safe = sanitizeTraceString(value);
    return safe.length <= MAX_STR ? safe : `${safe.slice(0, MAX_STR)}…(+${safe.length - MAX_STR})`;
  }
  if (t === "function") return `<fn ${value.name || "anon"}>`;
  if (depth >= 3) return `<${t}>`;
  // DOM nodes: their tag and identity, never their subtree.
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => shortenValue(v, depth + 1));
    if (value.length > MAX_ITEMS) head.push(`…+${value.length - MAX_ITEMS} more`);
    return head;
  }
  if (t === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n >= MAX_ITEMS) {
        out["…"] = `+${Object.keys(value).length - MAX_ITEMS} more keys`;
        break;
      }
      out[k] = isSecret(k) ? "<redacted>" : shortenValue(v, depth + 1);
      n++;
    }
    return out;
  }
  return String(value);
}

/**
 * Record one line. Never throws, never logs, never blocks.
 *
 * @param {string} file  the source file, e.g. "content/overlay.js"
 * @param {string} fn    the function name
 * @param {string} ev    "->" entered, "<-" returned, "!!" threw, ".." a note
 */
export function traceLine(file, fn, ev, data, traceId = undefined) {
  if (!enabled) return;
  try {
    buffer.push({
      t: Date.now(),
      n: ++lineNo,
      trace: sanitizeTraceString(traceId === undefined ? currentTrace : String(traceId || "")),
      side: "ext",
      producerId,
      clientBuild,
      traceClientSchema: 2,
      file: sanitizeTraceString(file),
      fn: sanitizeTraceString(fn),
      ev: sanitizeTraceString(ev),
      ...(data === undefined ? {} : { d: shortenValue(data) }),
    });
    if (buffer.length > MAX_BUFFER) {
      // Drop the OLDEST: when a loop is spraying lines, the recent ones
      // describe the current state and only one of those can be kept.
      const excess = buffer.length - MAX_BUFFER;
      buffer.splice(0, excess);
      dropped += excess;
    }
    if (buffer.length >= FLUSH_AT_COUNT) {
      void flushTrace();
      return;
    }
    if (!timer) timer = setTimeout(() => void flushTrace(), FLUSH_AFTER_MS);
  } catch {
    /* a tracer that can throw is worse than a tracer that loses a line */
  }
}

/** A hand-placed note at a decision point. */
export const note = (file, fn, data, traceId = undefined) =>
  traceLine(file, fn, "..", data, traceId);

/**
 * Buffer a line produced in the PAGE, verbatim.
 *
 * Not `traceLine`: that stamps the service worker's own trace id and counter,
 * which would overwrite the page's — and the page's id is the whole reason a
 * click and the request it caused end up in the same story. The page's clock
 * (`t`) is kept for the same reason the log sink keeps it: the moment this
 * worker saw the line is not the moment the page produced it.
 */
export function traceRelay(record) {
  if (!enabled || !record || typeof record !== "object") return;
  try {
    buffer.push({
      t: Number(record.t) || Date.now(),
      n: record.n,
      trace: sanitizeTraceString(record.trace || ""),
      side: sanitizeTraceString(record.side || "page"),
      producerId: sanitizeTraceString(record.producerId || producerId),
      clientBuild: sanitizeTraceString(record.clientBuild || clientBuild),
      traceClientSchema: Number(record.traceClientSchema) || 2,
      file: sanitizeTraceString(record.file || "?"),
      fn: sanitizeTraceString(record.fn || "?"),
      ev: sanitizeTraceString(record.ev || ".."),
      ...(record.d === undefined ? {} : { d: shortenValue(record.d) }),
      ...(record.tabId === undefined ? {} : { tabId: record.tabId }),
      ...(record.frameId === undefined ? {} : { frameId: record.frameId }),
    });
    if (buffer.length > MAX_BUFFER) {
      const excess = buffer.length - MAX_BUFFER;
      buffer.splice(0, excess);
      dropped += excess;
    }
    if (buffer.length >= FLUSH_AT_COUNT) {
      void flushTrace();
      return;
    }
    if (!timer) timer = setTimeout(() => void flushTrace(), FLUSH_AFTER_MS);
  } catch {
    /* never throw out of a tracer */
  }
}

/** Send whatever is buffered. Safe to call at any time. */
export async function flushTrace() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!enabled || shipping || !buffer.length) return;
  if (consecutiveFailures >= FAILURE_BUDGET) return;

  let base = "";
  try {
    base = String((await baseUrlProvider?.()) || "").replace(/\/+$/, "");
  } catch {
    base = "";
  }
  if (!base) return;

  const batch = buffer.slice(0, MAX_BATCH);
  const expectedSession = activeSession;
  const shipmentId = await shipmentSignature({
    traceSession: expectedSession,
    droppedSinceLastBatch: dropped,
    records: batch,
  });
  shipping = true;
  try {
    const response = await fetch(`${base}/v1/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      keepalive: true,
      body: JSON.stringify({
        records: batch,
        droppedSinceLastBatch: dropped,
        traceSession: expectedSession,
        clientBuild,
        traceClientSchema: 2,
        producerId,
        shipmentId,
      }),
    });
    if (response.status === 503) {
      // Tracing was switched off on the server. A settled answer, not a
      // transient failure — stop rather than retry it on every batch.
      enabled = false;
      buffer = [];
      dropped = 0;
      return;
    }
    if (response.status === 409) {
      let responseDetail = {};
      try {
        const body = await response.json();
        responseDetail = body?.detail && typeof body.detail === "object" ? body.detail : {};
      } catch {
        responseDetail = {};
      }
      let refreshed = null;
      try {
        refreshed = await refreshCapabilitiesProvider?.();
      } catch {
        refreshed = null;
      }
      const currentSession = String(
        refreshed?.traceSession ||
        responseDetail?.currentSession ||
        response.headers?.get?.("X-TP-Trace-Session") ||
        "",
      );
      if (!currentSession) throw new Error("trace session mismatch without current session");

      // Every buffered line was created against the rejected session. Do not
      // retry it into the new file; preserve the count so the next accepted
      // batch writes an explicit gap marker instead.
      dropped += buffer.length;
      buffer = [];
      activeSession = currentSession;
      consecutiveFailures = 0;
      enabled = refreshed?.trace !== false;
      if (refreshed?.traceDetail) {
        detail = String(refreshed.traceDetail).toLowerCase() === "full" ? "full" : "compact";
      }
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Remove THESE records, not "the first N": lines were appended while the
    // request was in flight, and an overflow trim may have removed some from
    // the front.
    const sent = new Set(batch);
    buffer = buffer.filter((r) => !sent.has(r));
    // A capability refresh may have switched sessions while this request was
    // in flight. Its success belongs to the old session and must not erase the
    // gap count accumulated for the new one.
    if (activeSession === expectedSession) dropped = 0;
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_BUDGET) {
      dropped += buffer.length;
      buffer = [];
      // A later successful capabilities/readiness answer can enable shipping
      // again.  Previously the failure counter stayed terminal for the whole
      // service-worker lifetime after a brief API restart.
      enabled = false;
    }
  } finally {
    shipping = false;
    if (buffer.length && consecutiveFailures < FAILURE_BUDGET && !timer) {
      timer = setTimeout(() => void flushTrace(), FLUSH_AFTER_MS);
    }
  }
}

// Why the service worker is hand-placed, not wrapped
//
// The page context gets wrapped automatically: content scripts register their
// helpers on `window.__TP`, so one pass over that object covers every function
// crossing a file boundary (see content/trace.js). The API gets wrapped
// automatically too (backend/trace_install.py, 207 functions).
//
// The service worker cannot. Its files are ES modules, and an `import` is a
// live binding to the exporting module's variable — it cannot be reassigned
// from outside, so there is no object to walk. Doing it anyway would mean a
// build-time source transform, which needs an AST parser this project
// deliberately does not have (zero dependencies) and would put a rewriting
// step between the code being read and the code being run.
//
// So the worker's ~15 waypoints carry a hand-placed `note()` instead: the job
// starting, the request going out, the reply coming back, the insert. That is
// a real gap and it is written here rather than left to be discovered — a
// function of the worker that does not appear in the trace was not
// necessarily skipped; it may simply never have been given a line.
