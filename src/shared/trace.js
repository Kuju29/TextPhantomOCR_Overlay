import "./diagnostic-schema.js";
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
const MAX_PRECAP_RECORDS = 128;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 48 * 1024;
// Transient failure is not an authoritative TP_TRACE=0. After three failures,
// probe at a bounded backoff instead of silently discarding the whole run.
const FAILURE_BUDGET = 3;
const MAX_RETRY_MS = 30_000;
const SHIP_DEADLINE_MS = 10_000;

// null = capabilities have not answered yet. Keep a small memory-only prefix
// so an offline Local-AI Connect immediately after extension reload is not
// lost. It is never written until the API explicitly enables tracing.
let enabled = null;
let detail = "off";
let contentDiagnostics = false;
let baseUrlProvider = null;
let buffer = [];
let dropped = 0;
let timer = null;
let shipping = false;
let configurationRevision = 0;
let consecutiveFailures = 0;
let retryAt = 0;
let shippingHealth = newShippingHealth();
let lineNo = 0;
let activeSession = "";
let refreshCapabilitiesProvider = null;
let preCapabilities = [];
const clientBuild = (() => {
  try {
    return String(
      globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown",
    );
  } catch {
    return "unknown";
  }
})();
const producerId = (() => {
  try {
    return String(
      globalThis.crypto?.randomUUID?.() ||
        `worker-${Date.now()}-${Math.random()}`,
    );
  } catch {
    return `worker-${Date.now()}-${Math.random()}`;
  }
})();

async function shipmentSignature(value) {
  const text = JSON.stringify(value);
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    // Deterministic fallback for old runtimes. Producer identity still keeps
    // shipments apart; this hash only makes exact lost-ACK retries stable.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `fnv-${(hash >>> 0).toString(16)}`;
  }
}

function newShippingHealth() {
  return { attempts: 0, acknowledged: 0, totalFailures: 0,
    lastCode: "", lastStage: "", lastStatus: 0, failedAt: 0, ackAt: 0, ackSequence: 0 };
}

/** Bounded metadata only; safe to persist with a final repair summary. */
export function getTraceShippingState() {
  return {
    schema: "tp.trace-shipping/1", producerId, clientBuild,
    traceSession: activeSession,
    state: enabled === null ? "unnegotiated" : !enabled ? "disabled" :
      retryAt > Date.now() ? "backoff" : "active",
    transport: { ...shippingHealth, consecutiveFailures, retryAt },
    buffer: {
      queued: buffer.length,
      dropped,
      reason: shippingHealth.lastCode ||
        (enabled === null ? "unnegotiated" : !enabled ? "disabled" : ""),
    },
  };
}

function scheduleTraceFlush() {
  if (enabled !== true || shipping || timer || (!buffer.length && !dropped)) return;
  timer = setTimeout(() => void flushTrace(), Math.max(FLUSH_AFTER_MS, retryAt - Date.now()));
}

// Also bound API-base resolution, body parsing and capability refresh. A hung
// diagnostic dependency must not monopolize the shipper after the HTTP timeout.
function beforeDeadline(value, signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Trace deadline", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Trace deadline", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
  explicitContentDiagnostics = false,
) {
  const nextEnabled = Boolean(on);
  const nextSession = String(traceSession || "");
  const sessionChanged = Boolean(nextSession) && nextSession !== activeSession;
  const becameEnabled = nextEnabled && !enabled;
  if (nextEnabled !== enabled || sessionChanged) configurationRevision++;
  if (sessionChanged) {
    // Records buffered for an API process that has ended do not belong in the
    // new process's file.  Start the new story cleanly.
    dropped += buffer.length;
    buffer = [];
    activeSession = nextSession;
  }
  if (sessionChanged || becameEnabled) {
    consecutiveFailures = 0;
    retryAt = 0;
    shippingHealth = newShippingHealth();
  }
  enabled = nextEnabled;
  detail =
    enabled && String(traceDetail || "").toLowerCase() === "full"
      ? "full"
      : enabled
        ? "compact"
        : "off";
  // Content capture is deliberately independent from TP_TRACE/traceDetail.
  // No production caller enables it; an explicit future diagnostic control
  // must pass true and warn the user before source/model text can be handled.
  contentDiagnostics = enabled && explicitContentDiagnostics === true;
  if (getBaseUrl) baseUrlProvider = getBaseUrl;
  if (refreshCapabilities) refreshCapabilitiesProvider = refreshCapabilities;
  if (!enabled) {
    buffer = [];
    preCapabilities = [];
    dropped = 0;
    consecutiveFailures = 0;
    contentDiagnostics = false;
    retryAt = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  if (enabled && preCapabilities.length) {
    buffer.push(...preCapabilities);
    preCapabilities = [];
  }
  scheduleTraceFlush();
}

export const isTracing = () => enabled === true;
export const getTraceDetail = () => detail;
// Despite the historical name, this gates privacy-safe diagnostic metadata
// (counts, hashes and timings), never OCR/prompt/provider text previews.
export const diagnosticPreviewsEnabled = () => enabled === true;
export const diagnosticContentEnabled = () => contentDiagnostics === true;

/** API identity changed: records for the old sink must never enter the new one. */
export function resetTracingForBaseChange() {
  configurationRevision++;
  enabled = null;
  detail = "off";
  contentDiagnostics = false;
  buffer = [];
  preCapabilities = [];
  dropped = 0;
  consecutiveFailures = 0;
  retryAt = 0;
  shippingHealth = newShippingHealth();
  activeSession = "";
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// value shortening
// A trace line is a debugging aid, not a data export. Long values are cut and
// the cut is shown, because a value that silently vanished is worse than one
// that is visibly short.

const MAX_STR = 200;
const MAX_ITEMS = 12;
const SECRET_HINTS = [
  "api_key",
  "apikey",
  "key",
  "token",
  "secret",
  "password",
  "cookie",
  "auth",
  "bearer",
  "source",
  "translation",
  "prompt",
  "text",
  "content",
  "response",
  "ocr",
  "image",
  "url",
  "original",
  "authorization",
];

/** Redact credentials even when they are embedded in a URL or error string. */
export function sanitizeTraceString(value) {
  return String(value ?? "")
    .replace(/\bdata:[^\s"'<>]+/gi, "<redacted-data-url>")
    .replace(/\bblob:[^\s"'<>]+/gi, "<redacted-blob-url>")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        return `${new URL(raw).origin}/<redacted>`;
      } catch {
        return "<redacted-url>";
      }
    })
    .replace(/\b(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1<redacted>@")
    .replace(
      /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|auth|authorization|password|secret|signature|sig|policy|key-pair-id|x-amz-[^=&#\s]+|x-goog-[^=&#\s]+)=)[^&#\s]+/gi,
      "$1<redacted>",
    )
    .replace(
      /\b((?:proxy-)?authorization)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/gi,
      "$1$2<redacted>",
    )
    .replace(
      /\b((?:set-)?cookie)(\s*:\s*)[^\r\n]+(?:\r?\n[ \t]+[^\r\n]*)*/gi,
      "$1$2<redacted>",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]{6,}/gi, "Bearer <redacted>")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g,
      "<redacted>",
    )
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization|cookie)(\s*[:=]\s*)[^\s,;&]+/gi,
      "$1$2<redacted>",
    );
}

const isSecret = (name) => {
  const low = String(name).toLowerCase();
  if (
    ["sourcefingerprint", "imageid", "imagekey", "sourcehashes"].includes(low)
  )
    return false;
  return SECRET_HINTS.some((h) => low.includes(h));
};

const NUMERIC_AI_DIAGNOSTICS = new Set([
  "requestedoutputtokens",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "thinkingtokens",
  "cachedinputtokens",
  "cachewriteinputtokens",
  "sourcechars",
  "targetsourcechars",
  "estimatedresponsechars",
]);
const SAFE_OPERATIONAL_BOOLEANS = new Set([
  "pageimagetoai", "manualairatecap", "manualratecapenabled", "ratecapenabled",
]);

export function shortenValue(value, depth = 0) {
  if (value?.schema === "tp.audit/1") return globalThis.TPAuditSchema.sanitize(value);
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "boolean") return value;
  if (t === "number")
    return Number.isFinite(value)
      ? Math.round(value * 1e4) / 1e4
      : String(value);
  if (t === "string") {
    const safe = sanitizeTraceString(value);
    return safe.length <= MAX_STR
      ? safe
      : `${safe.slice(0, MAX_STR)}…(+${safe.length - MAX_STR})`;
  }
  if (t === "function") return `<fn ${value.name || "anon"}>`;
  // One extra bounded level keeps unitLayout's reading-order/rotation arrays
  // and AI contract diagnostics useful in compact TP_TRACE exports.
  if (depth >= 4) return `<${t}>`;
  // DOM nodes: their tag and identity, never their subtree.
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
  }
  if (Array.isArray(value)) {
    const head = value
      .slice(0, MAX_ITEMS)
      .map((v) => shortenValue(v, depth + 1));
    if (value.length > MAX_ITEMS)
      head.push(`…+${value.length - MAX_ITEMS} more`);
    return head;
  }
  if (t === "object") {
    const out = {};
    let n = 0;
    const priority = new Set([
      "wrongLanguageIds",
      "missingIds",
      "languageDiagnostics",
      "detectedScripts",
      "unitLayout",
      "units",
      "readingOrder",
      "members",
      "inputRotations",
      "inputSigns",
      "outputRotation",
      "outputSign",
      "outputRotationSource",
      // Operational booleans must remain visible in activity traces.  They
      // contain no content and answer whether an optional path was active.
      "pageImageToAi",
      "manualAiRateCap",
      "manualRateCapEnabled",
      "rateCapEnabled",
      "cache",
      "scope",
      "incidentId",
      "owner",
      "severity",
      "outcome",
      "retryable",
      "final",
    ]);
    const entries = Object.entries(value).sort(
      ([a], [b]) => Number(priority.has(b)) - Number(priority.has(a)),
    );
    for (const [k, v] of entries) {
      if (n >= MAX_ITEMS) {
        out["…"] = `+${Object.keys(value).length - MAX_ITEMS} more keys`;
        break;
      }
      // This exact boolean states that no cloud credential crossed the local
      // trust boundary. Never relax redaction for a string or truthy value.
      const lowKey = k.toLowerCase().replace(/[_-]/g, "");
      out[k] =
        NUMERIC_AI_DIAGNOSTICS.has(lowKey) &&
        typeof v === "number" &&
        Number.isFinite(v)
          ? shortenValue(v, depth + 1)
          : SAFE_OPERATIONAL_BOOLEANS.has(lowKey) && typeof v === "boolean"
            ? v
          : k.toLowerCase() === "cloudkeysent" && v === false
            ? false
            : isSecret(k)
              ? "<redacted>"
              : shortenValue(v, depth + 1);
      n++;
    }
    return out;
  }
  return String(value);
}

const CORRELATION_FIELDS = ["traceId", "operationId", "requestId", "jobId", "batchId",
  "imageId", "runId", "taskId", "attemptId", "clientInstanceHash", "userScopeHash"];
function incidentHash(value) {
  let hash = 2166136261;
  for (const ch of String(value)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return `inc:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function opaqueScope(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (new RegExp(`^${label}:[0-9a-f]{8,64}$`).test(String(value))) return String(value);
  return `${label}:${incidentHash(String(value)).slice(4)}`;
}

/** Additive activity metadata only when evidence supports it. */
export function enrichOperationalTrace(fn, ev, data, traceId = "") {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out = { ...data };
  // A field named *Hash is still an untrusted client claim. Canonicalise it
  // before it can enter either the flat backwards-compatible fields or scope.
  if (out.clientInstanceHash) out.clientInstanceHash = opaqueScope(out.clientInstanceHash, "client");
  if (out.userScopeHash) out.userScopeHash = opaqueScope(out.userScopeHash, "user");
  const normalizedScopes = {
    clientInstanceHash: opaqueScope(out.clientInstanceHash || out.scope?.clientInstanceHash, "client"),
    userScopeHash: opaqueScope(out.userScopeHash || out.scope?.userScopeHash, "user"),
  };
  if (normalizedScopes.clientInstanceHash) out.clientInstanceHash = normalizedScopes.clientInstanceHash;
  if (normalizedScopes.userScopeHash) out.userScopeHash = normalizedScopes.userScopeHash;
  const cached = Number(out?.usage?.cachedInput ?? out?.usage?.cachedInputTokens ?? 0);
  if (fn === "aiModelWorkload" && out.event === "observation")
    out.cache = { kind: "provider_prompt", hit: cached > 0, cachedInputTokens: Math.max(0, cached) };
  const failed = ev === "!!" || /(?:failed|error|unresolved|rejected)/i.test(String(out.event || out.state || out.phase || "")) ||
    Number(out.unresolved || out.rejectedCount || 0) > 0;
  const terminal = out.final === true || out.event === "final" || ["done", "cancelled", "failed"].includes(String(out.phase || out.state || ""));
  if (!failed && !terminal) return out;
  const scope = {};
  for (const key of CORRELATION_FIELDS) {
    let value = normalizedScopes[key] || out[key] || out.scope?.[key];
    if (value !== undefined && value !== null && value !== "") scope[key] = String(value).slice(0, 160);
  }
  if (traceId && !scope.traceId) scope.traceId = String(traceId).slice(0, 160);
  const anchor = scope.operationId || scope.imageId || scope.jobId || scope.runId || scope.traceId || scope.batchId;
  const owner = out.owner || (/config|profile_validation/i.test(String(out.event || out.stage || "")) ? "user_config" : "unknown");
  const outcome = out.outcome || (failed ? "failed" : "succeeded");
  return { ...out, owner, outcome, severity: out.severity || (failed ? "warning" : "info"),
    retryable: out.retryable === true, final: terminal, correlation: { scope: typeof out.scope === "string" ? out.scope : (scope.imageId ? "image" : scope.batchId ? "batch" : "operation"), ...scope },
    ...(anchor ? { incidentId: out.incidentId || incidentHash(`${scope.userScopeHash || scope.clientInstanceHash || ""}|${anchor}|${out.code || out.stage || fn}`) } : {}) };
}

/**
 * Record one line. Never throws, never logs, never blocks.
 *
 * @param {string} file  the source file, e.g. "content/overlay.js"
 * @param {string} fn    the function name
 * @param {string} ev    "->" entered, "<-" returned, "!!" threw, ".." a note
 */
export function traceLine(file, fn, ev, data, traceId = undefined) {
  if (enabled === false) return;
  try {
    const record = {
      t: Date.now(),
      n: ++lineNo,
      trace: sanitizeTraceString(
        traceId === undefined ? currentTrace : String(traceId || ""),
      ),
      side: "ext",
      producerId,
      clientBuild,
      traceClientSchema: 2,
      file: sanitizeTraceString(file),
      fn: sanitizeTraceString(fn),
      ev: sanitizeTraceString(ev),
      ...(data === undefined ? {} : { d: shortenValue(enrichOperationalTrace(fn, ev, data,
        traceId === undefined ? currentTrace : String(traceId || ""))) }),
    };
    let bounded = record;
    try {
      if (
        new TextEncoder().encode(JSON.stringify(record)).length >
        MAX_RECORD_BYTES
      ) {
        bounded = { ...record, d: { traceRecordOmitted: "record_byte_limit" } };
      }
    } catch {
      bounded = {
        ...record,
        d: { traceRecordOmitted: "serialization_failed" },
      };
    }
    if (enabled === null) {
      preCapabilities.push(bounded);
      if (preCapabilities.length > MAX_PRECAP_RECORDS)
        preCapabilities.splice(0, preCapabilities.length - MAX_PRECAP_RECORDS);
      return;
    }
    buffer.push(bounded);
    trimTraceBuffer();
    if (buffer.length >= FLUSH_AT_COUNT) {
      void flushTrace();
      return;
    }
    scheduleTraceFlush();
  } catch {
    /* a tracer that can throw is worse than a tracer that loses a line */
  }
}

// Reserve surviving context for recent decisions/terminal events when a verbose
// loop exhausts the bounded buffer. Losses still increment the existing counter;
// no unbounded/durable diagnostic queue is introduced.
function criticalTrace(record) {
  const event = record?.d?.schema === "tp.audit/1" ? record.d.event : "";
  if (event && !["geometry_snapshot", "group_membership", "geometry_overlap", "unknown"].includes(event)) return true;
  return ["repairPatch", "repairProgress", "done", "cancelled"].includes(record?.fn);
}
function trimTraceBuffer() {
  while (buffer.length > MAX_BUFFER) {
    let candidate = buffer.findIndex(record => !criticalTrace(record));
    // All-critical floods are bounded too: retaining a suffix is honest, and
    // producer sequences plus dropped counts expose the missing prefix.
    if (candidate < 0) candidate = 0;
    buffer.splice(candidate, 1);
    dropped++;
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
  if (enabled === false || !record || typeof record !== "object") return;
  try {
    const bounded = {
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
    };
    if (enabled === null) {
      preCapabilities.push(bounded);
      if (preCapabilities.length > MAX_PRECAP_RECORDS)
        preCapabilities.splice(0, preCapabilities.length - MAX_PRECAP_RECORDS);
      return;
    }
    buffer.push(bounded);
    trimTraceBuffer();
    if (buffer.length >= FLUSH_AT_COUNT) {
      void flushTrace();
      return;
    }
    scheduleTraceFlush();
  } catch {
    /* never throw out of a tracer */
  }
}

/** Send buffered diagnostics, never waiting on a translation or provider lane. */
export async function flushTrace() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (enabled !== true || shipping || (!buffer.length && !dropped)) return;
  if (Date.now() < retryAt) { scheduleTraceFlush(); return; }

  // Claim before the first await. Late replies from an old base/session have
  // no authority to delete current records or turn the new sink off.
  shipping = true;
  const revision = configurationRevision;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SHIP_DEADLINE_MS);
  const wait = value => beforeDeadline(value, controller.signal);
  let status = 0, failureCode = "network_error", failureStage = "base";
  try {
    const base = String((await wait(baseUrlProvider?.())) || "").replace(/\/+$/, "");
    if (enabled !== true || revision !== configurationRevision) return;
    if (!base) { failureCode = "no_api_base"; throw new Error(failureCode); }
    const expectedSession = activeSession;
    const batch = [], oversized = new Set();
    let bytes = 2048; // Reserve for identity and bounded shipping-health metadata.
    for (const record of buffer.slice(0, MAX_BATCH)) {
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).length + 1;
      if (recordBytes > MAX_RECORD_BYTES || recordBytes + 2048 > MAX_REQUEST_BYTES) {
        oversized.add(record); continue;
      }
      if (batch.length && bytes + recordBytes > MAX_REQUEST_BYTES) break;
      batch.push(record); bytes += recordBytes;
    }
    if (oversized.size) {
      buffer = buffer.filter(record => !oversized.has(record));
      dropped += oversized.size;
    }
    if (!batch.length && !dropped) return;
    const droppedAtSend = dropped;
    failureStage = "signature";
    const shipmentId = await wait(shipmentSignature({
      traceSession: expectedSession, droppedSinceLastBatch: droppedAtSend, records: batch,
    }));
    if (revision !== configurationRevision || enabled !== true) return;
    failureStage = "http";
    shippingHealth.attempts++;
    const response = await wait(fetch(`${base}/v1/trace`, {
      signal: controller.signal, method: "POST",
      headers: { "Content-Type": "application/json" }, cache: "no-store", keepalive: false,
      body: JSON.stringify({ records: batch, droppedSinceLastBatch: droppedAtSend,
        traceSession: expectedSession, clientBuild, traceClientSchema: 2, producerId,
        shipmentId, shipping: getTraceShippingState() }),
    }));
    if (revision !== configurationRevision) return;
    status = Number(response.status) || 0;
    let reply = null;
    if (response.ok || status === 503 || status === 409) {
      // A reverse proxy's generic 503 is NOT proof that TP_TRACE is disabled.
      failureStage = "ack";
      try { reply = await wait(response.json()); }
      catch (error) { if (controller.signal.aborted) throw error; }
      if (revision !== configurationRevision) return;
    }
    if (status === 503 && reply?.detail?.code === "trace_disabled") {
      setTracingEnabled(false);
      shippingHealth.lastCode = "trace_disabled";
      shippingHealth.lastStatus = status;
      return;
    }
    if (status === 409) {
      failureCode = "session_mismatch";
      failureStage = "session";
      const refreshed = await wait(refreshCapabilitiesProvider?.());
      if (revision !== configurationRevision) return;
      // Only a successful capabilities handshake can enable a new session.
      if (!refreshed || refreshed.reason || typeof refreshed.trace !== "boolean")
        throw new Error(failureCode);
      const currentSession = String(refreshed.traceSession || "");
      if (!currentSession || currentSession === expectedSession) throw new Error(failureCode);
      setTracingEnabled(refreshed.trace, null, refreshed.traceDetail, currentSession);
      return;
    }
    if (!response.ok) { failureCode = "http_error"; throw new Error(failureCode); }
    if (reply?.ok !== true || (expectedSession && reply.session && reply.session !== expectedSession)) {
      failureCode = "invalid_ack";
      throw new Error(failureCode);
    }
    const sent = new Set(batch);
    buffer = buffer.filter(record => !sent.has(record));
    if (activeSession === expectedSession) dropped = Math.max(0, dropped - droppedAtSend);
    consecutiveFailures = 0;
    retryAt = 0;
    shippingHealth.acknowledged++;
    shippingHealth.ackAt = Date.now();
    shippingHealth.ackSequence = Math.max(shippingHealth.ackSequence,
      ...batch.filter(r => r.producerId === producerId).map(r => Number(r.n) || 0));
  } catch {
    if (revision !== configurationRevision) return;
    consecutiveFailures++;
    shippingHealth.totalFailures++;
    shippingHealth.lastCode = controller.signal.aborted ? "deadline_exceeded" : failureCode;
    shippingHealth.lastStatus = status;
    shippingHealth.lastStage = failureStage;
    shippingHealth.failedAt = Date.now();
    retryAt = consecutiveFailures >= FAILURE_BUDGET
      ? Date.now() + Math.min(MAX_RETRY_MS, 5000 * 2 ** Math.min(3, consecutiveFailures - FAILURE_BUDGET))
      : 0;
    // Keep the bounded buffer (with overflow accounting). These are diagnostic
    // retries only; no provider request, renderer or repair state is repeated.
  } finally {
    clearTimeout(deadline);
    shipping = false;
    scheduleTraceFlush();
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
