// Live provider-stream phase for the in-page status (bottom right).
//
// The API reports what the provider stream itself shows (tp.ai.stream/1
// `progress` rows, sent only when the request carries X-TP-Stream-Phases: 1):
//   waiting  · response open, only keep-alives so far ("waiting at provider")
//   thinking · reasoning frames are arriving
//   writing  · visible text is arriving; linesDone/linesTotal translated lines
//   stalled  · no reasoning or text inside the idle window; the API stops it
//   stopping · another progress rule stopped it (reason = error code)
// No model text crosses this boundary.

const STREAM_PHASES = Object.freeze(["waiting", "thinking", "writing", "stalled", "stopping"]);
export const STREAM_PHASE_HEADER = "X-TP-Stream-Phases";
// UI updates for one request: at most two per second.
export const PHASE_UI_INTERVAL_MS = 500;

const count = value => Number.isInteger(value) && value >= 0 && value <= 86_400_000 ? value : null;

/** Validated, bounded copy of one progress row; null when it is not one. */
export function normalizeStreamPhase(event, receivedAt = Date.now()) {
  const phase = String(event?.phase || "");
  if (!STREAM_PHASES.includes(phase)) return null;
  const linesTotal = count(event.linesTotal);
  const linesDone = count(event.linesDone);
  return {
    phase,
    phaseElapsedMs: count(event.phaseElapsedMs) ?? 0,
    elapsedMs: count(event.elapsedMs) ?? 0,
    linesDone: linesDone === null ? null : linesTotal === null ? linesDone : Math.min(linesDone, linesTotal),
    linesTotal: linesTotal && linesTotal > 0 ? linesTotal : null,
    thinkingLimitMs: count(event.thinkingLimitMs),
    keepalive: event.keepalive === true,
    reason: typeof event.reason === "string" ? event.reason.slice(0, 40) : "",
    receivedAt: Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now(),
  };
}

/**
 * Leading + trailing throttle: an update goes out at once when the window
 * allows it, otherwise the newest one waits for the window to end (it is never
 * lost), so a request produces at most one UI update per `intervalMs`.
 */
export function createPhaseThrottle(emit, {
  intervalMs = PHASE_UI_INTERVAL_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  let lastAt = -Infinity, pending = null, timer = null, closed = false;
  const send = value => {
    lastAt = now();
    try { emit(value); } catch { /* Display never affects translation. */ }
  };
  const flush = () => {
    timer = null;
    if (closed || !pending) return;
    const value = pending; pending = null;
    send(value);
  };
  return {
    push(value) {
      if (closed || !value) return;
      const wait = intervalMs - (now() - lastAt);
      if (wait <= 0 && !timer) { send(value); return; }
      pending = value;
      if (!timer) timer = setTimer(flush, Math.max(0, wait));
    },
    // A stop decision (stalled/stopping) is shown at once: it is the last
    // phase of the request and must not be dropped by the terminal close().
    final(value) {
      if (closed || !value) return;
      pending = null;
      if (timer) { clearTimer(timer); timer = null; }
      send(value);
    },
    // A terminal result/error supersedes any phase still waiting to be shown.
    close() {
      closed = true; pending = null;
      if (timer) { clearTimer(timer); timer = null; }
    },
  };
}

// Same rule as the API's LineCompletionDetector.closed_count: distinct record
// IDs whose `<<ID:text>>` line is closed (or, for the JSON contract, whose
// string value is closed). Display only; never completion evidence.
const CLOSED_RECORD = /^[ \t]*<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6})):(.*?\S.*?)>>[ \t]*$/gmu;
const CLOSED_JSON_FIELD = /"((?:TP_)?P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6})"\s*:\s*"(?:[^"\\]|\\.)*"/gu;
export function closedLineCount(content, expectedIds = []) {
  const source = String(content || "").replace(/\r\n?/g, "\n");
  const ids = new Set();
  if (source.trimStart().startsWith("{"))
    for (const match of source.matchAll(CLOSED_JSON_FIELD)) ids.add(match[1].replace(/^TP_/, ""));
  else
    for (const match of source.matchAll(CLOSED_RECORD)) ids.add(match[1] || match[2]);
  const expected = new Set((expectedIds || []).map(id => String(id).replace(/^TP_/, "")));
  return expected.size ? [...ids].filter(id => expected.has(id)).length : ids.size;
}

// Browser-direct Local AI states (local-transport-runtime.js) → stream phase.
const LOCAL_STATE_PHASE = Object.freeze({
  waiting_for_model: "waiting", thinking: "thinking", first_response: "writing", generating: "writing",
});

/**
 * Phase reporting for the browser's direct Local AI stream, which has no API
 * progress rows. Report-only: a local runtime may load a model or run on slow
 * hardware for minutes without bytes, so (like the API's local runtimes) it is
 * never stopped by the cloud phase limits. One tracker per image; each new
 * request ("connecting") starts a fresh phase clock.
 */
export function createLocalPhaseTracker(emit, {now = () => Date.now(), ...timers} = {}) {
  let throttle = null, phase = "", phaseAt = 0, startedAt = 0, linesDone = null, linesTotal = null;
  const stop = () => { throttle?.close(); throttle = null; phase = ""; };
  return {
    /** Returns true when the state was shown as a stream phase. */
    observe(state, details = {}) {
      if (state === "connecting") { stop(); startedAt = now(); linesDone = null; linesTotal = null; return false; }
      const next = LOCAL_STATE_PHASE[state];
      if (!next) { if (state === "waiting_for_terminal" || state === "completed") stop(); return false; }
      if (!throttle) { throttle = createPhaseThrottle(emit, {now, ...timers}); if (!startedAt) startedAt = now(); }
      const at = now();
      if (next !== phase) { phase = next; phaseAt = at; }
      if (Number.isInteger(details?.linesDone)) linesDone = Math.max(linesDone ?? 0, details.linesDone);
      if (Number.isInteger(details?.linesTotal) && details.linesTotal > 0) linesTotal = details.linesTotal;
      const value = normalizeStreamPhase({phase, phaseElapsedMs: Math.max(0, Math.round(at - phaseAt)),
        elapsedMs: Math.max(0, Math.round(at - startedAt)), linesDone: phase === "writing" ? linesDone ?? 0 : null,
        linesTotal}, at);
      throttle.push(value);
      return true;
    },
    close: stop,
  };
}
