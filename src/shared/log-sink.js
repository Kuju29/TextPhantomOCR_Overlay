/**
 *
 * Ship the extension's log lines to the API so they land in a file.
 *
 * An extension cannot write files, and its two consoles (service worker, page)
 * are not being watched at the moment a problem happens. That is how three
 * regressions in a row came to be diagnosed by guessing: by the time anyone
 * looked, the evidence was gone.
 *
 * These records go to `POST /v1/logs`, which appends them to
 * `api/logs/extension-*.log` — the same folder as the server's own log, so one
 * timeline covers both sides of a request.
 *
 * Three rules, because a diagnostic that damages the thing it is diagnosing is
 * worse than none:
 *
 * 1. **Never blocks and never throws.** Shipping is fire-and-forget. A failure
 *    to log must not fail a translation.
 * 2. **Bounded.** A capped buffer that drops the OLDEST records and counts the
 *    drops. A log sink that can grow without limit is a memory bug waiting for
 *    a loop.
 * 3. **Off unless there is somewhere to send it.** No API base, no shipping,
 *    no repeated failing requests in the background.
 */

const MAX_BUFFER = 400;
const FLUSH_AFTER_MS = 1500;
const FLUSH_AT_COUNT = 40;
const MAX_BATCH = 200;

let buffer = [];
let dropped = 0;
let timer = null;
let shipping = false;
let baseUrlProvider = null;
let enabled = false;
let consecutiveFailures = 0;
let activeBaseKey = "";
// Older servers do not advertise features.logFile. Remember a documented 503
// per API base so every image in the same session does not repeat the probe.
const unsupportedBases = new Set();

// Line identity
// Every record gets a run id and a strictly increasing number. Without them,
// two identical lines in the file are ambiguous: they can mean the event
// happened twice, or that the shipper sent the same batch twice. On 2026-08-06
// a batch of work showed five byte-identical "menu click" lines at the SAME
// millisecond, and the log could not answer which of those it was — so the
// question had to be left open. With `run` + `n` it answers itself: same `n`
// means one event written twice, different `n` means it really happened twice.
const RUN_ID = Math.random().toString(36).slice(2, 10);
let lineNo = 0;

/** Give up after this many failed shipments; a dead endpoint stays dead. */
const FAILURE_BUDGET = 3;

/**
 * Turn shipping on.
 *
 * @param {() => Promise<string>} getBaseUrl resolves the API base, or "".
 */
export function setLogShippingEnabled(on, getBaseUrl, baseKey = "", { authoritative = false } = {}) {
  if (getBaseUrl) baseUrlProvider = getBaseUrl;
  activeBaseKey = String(baseKey || "").replace(/\/+$/, "");
  if (authoritative && on && activeBaseKey) unsupportedBases.delete(activeBaseKey);
  enabled = Boolean(on) && !(activeBaseKey && unsupportedBases.has(activeBaseKey));
  if (!enabled) {
    buffer = [];
    dropped = 0;
    consecutiveFailures = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  }
}

/** Forget compatibility-probe outcomes after the configured API changes. */
export function resetLogShippingSupport(baseKey = "") {
  const key = String(baseKey || "").replace(/\/+$/, "");
  if (key) unsupportedBases.delete(key);
  else unsupportedBases.clear();
}



/**
 * Record one line.
 *
 * Called from `createLogger`, so it is on the hot path of every log call in
 * the extension: it must stay cheap and it must never throw.
 */
export function recordLogLine(record) {
  if (!enabled) return;
  try {
    buffer.push({ ...record, run: RUN_ID, n: ++lineNo });
    if (buffer.length > MAX_BUFFER) {
      // Drop the OLDEST. When a loop is spraying lines, the recent ones
      // describe the current state; the old ones describe how it started, and
      // only one of those can be kept.
      const excess = buffer.length - MAX_BUFFER;
      buffer.splice(0, excess);
      dropped += excess;
    }
    if (buffer.length >= FLUSH_AT_COUNT) {
      void flushLogs();
      return;
    }
    if (!timer) timer = setTimeout(() => void flushLogs(), FLUSH_AFTER_MS);
  } catch {
    /* a logger that can throw is worse than a logger that loses a line */
  }
}

/** Send whatever is buffered. Safe to call at any time. */
export async function flushLogs() {
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
  shipping = true;
  try {
    const response = await fetch(`${base}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      // Survives the page/worker going away mid-flight, which is precisely
      // when the last few lines matter most.
      keepalive: true,
      body: JSON.stringify({
        records: batch,
        droppedSinceLastBatch: dropped,
      }),
    });
    if (response.status === 503) {
      // The server answers 503 for exactly one reason here: file logging is
      // turned off (TP_LOG_FILE), which is the default. That is a settled
      // answer, not a transient failure — retrying it three times per run adds
      // three doomed requests to every session. Stop, and say why once.
      enabled = false;
      if (base) unsupportedBases.add(String(base).replace(/\/+$/, ""));
      buffer = [];
      dropped = 0;
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Remove THESE records, not "the first N". While the fetch was in flight
    // new lines were appended, and an overflow trim may have removed some from
    // the front — in which case slicing by count would discard lines that were
    // never sent and keep ones that were.
    const sent = new Set(batch);
    buffer = buffer.filter((r) => !sent.has(r));
    dropped = 0;
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_BUDGET) {
      // Stop rather than retry forever: an unreachable log endpoint would
      // otherwise add a failing request to every batch of work.
      buffer = [];
    }
  } finally {
    shipping = false;
    if (buffer.length && consecutiveFailures < FAILURE_BUDGET && !timer) {
      timer = setTimeout(() => void flushLogs(), FLUSH_AFTER_MS);
    }
  }
}
