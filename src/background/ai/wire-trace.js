import { note as traceNote } from "../../shared/trace.js";

const SCHEMA = "tp.ai-wire-trace/1";
export const AI_WIRE_TRACE_SCHEMA = SCHEMA;
const secretKey = /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|cookie|set-cookie|token|access_token|x-tp-run-token|secret)$/i;

function redactUrl(raw) {
  try {
    const url = new URL(String(raw));
    for (const name of [...url.searchParams.keys()])
      if (/^(?:key|api[-_]?key|access_token|token|secret)$/i.test(name)) url.searchParams.set(name, "<redacted>");
    return url.toString();
  } catch { return raw; }
}
export function redactAiWireValue(value, key = "") {
  if (secretKey.test(String(key))) return value ? "<redacted>" : value;
  if (Array.isArray(value)) return value.map((item) => redactAiWireValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [name, item] of Object.entries(value)) out[name] = redactAiWireValue(item, name);
    return out;
  }
  if (typeof value === "string" && /(?:url|endpoint)$/i.test(String(key))) return redactUrl(value);
  return value;
}
function collectSecrets(value, key = "", out = new Set()) {
  if (typeof value === "string" && secretKey.test(String(key))) {
    if (value.length >= 4) out.add(value);
    const bearer = value.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer?.length >= 4) out.add(bearer);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, "", out);
  } else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) collectSecrets(item, name, out);
  }
  return out;
}
function scrub(value, secrets) {
  if (typeof value === "string") {
    let text = value;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("<redacted>");
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrub(item, secrets);
    return out;
  }
  return value;
}
export function aiWireTraceEnabled(capabilities) { return capabilities?.aiWireTrace === true; }

export function createAiWireRecorder({ enabled = false, operationId = "", traceId = "", identity = {},
  apiBase = "", relay = null, fetchImpl = globalThis.fetch } = {}) {
  if (!enabled) return null;
  const executionKey = crypto.randomUUID();
  const fullIdentity = redactAiWireValue({ operationId, traceId, executionKey, ...identity });
  const endpoint = `${String(apiBase || "").replace(/\/+$/, "")}${String(relay?.path || "")}`;
  const relayToken = String(relay?.token || "");
  const relayTimeoutMs = Math.max(250, Math.min(10000, Number(relay?.timeoutMs) || 1500));
  const maxQueuedEvents = Math.max(4, Math.min(256, Number(relay?.maxQueuedEvents) || 64));
  const maxQueuedBytes = Math.max(16384, Math.min(16 * 1024 * 1024,
    Number(relay?.maxQueuedBytes) || 4 * 1024 * 1024));
  if (identity?.route !== "direct-local" || !endpoint || !relayToken || !fetchImpl) return async () => {};
  const secrets = new Set();
  const send = async (stage, value = null) => {
    const body = JSON.stringify({ schema: SCHEMA, identity: fullIdentity, stage, value });
    const max = Number(relay?.maxEventBytes) || 0;
    if (max && new TextEncoder().encode(body).length > max) throw new Error("Direct Local AI trace event is too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`AI wire relay timed out after ${relayTimeoutMs}ms`)), relayTimeoutMs);
    let response;
    try { response = await fetchImpl(endpoint, { method: "POST", headers: {
      "Content-Type": "application/json", "X-TP-AI-Wire-Capability": relayToken,
      "X-TP-Trace-Id": String(fullIdentity.traceId || traceId || ""),
      "X-TP-Request-Id": String(fullIdentity.operationId || operationId || ""),
      "X-TP-Job-Id": String(fullIdentity.jobId || ""),
      "X-TP-Batch-Id": String(fullIdentity.batchId || ""),
      "X-TP-Image-Id": String(fullIdentity.imageId || ""),
    }, body, signal: controller.signal });
      if (!response.ok) {
        let reason = "";
        try { reason = String(await response.text()).slice(0, 240); } catch {}
        throw new Error(`Direct Local AI trace relay HTTP ${response.status}${reason ? `: ${reason}` : ""}`);
      }
    } finally { clearTimeout(timer); }
  };
  const queue = [];
  let queuedBytes = 0, pumping = false, disabled = false;
  let drainPromise = Promise.resolve();
  const pump = () => {
    if (pumping || disabled || !queue.length) return;
    pumping = true;
    drainPromise = (async () => {
      while (queue.length && !disabled) {
        const event = queue.shift(); queuedBytes -= event.bytes;
        try { await send(event.stage, event.value); }
        catch (error) {
          const pendingCount = queue.length;
          disabled = true; queue.length = 0; queuedBytes = 0;
          traceNote("background/ai/wire-trace.js", "relayDisabled", {
            operationId, traceId, stage: event.stage,
            reason: "transport_failure", timeoutMs: relayTimeoutMs,
            droppedEvents: 1 + pendingCount,
          });
        }
      }
    })().finally(() => { pumping = false; if (!disabled && queue.length) pump(); });
  };
  const recorder = (stage, value) => {
    if (disabled) return Promise.resolve(false);
    if (stage === "providerRequest") collectSecrets(value, "", secrets);
    value = redactAiWireValue(scrub(value, secrets));
    const bytes = new TextEncoder().encode(JSON.stringify({ stage, value })).length;
    if (queue.length >= maxQueuedEvents || queuedBytes + bytes > maxQueuedBytes) {
      disabled = true; queue.length = 0; queuedBytes = 0;
      traceNote("background/ai/wire-trace.js", "relayDisabled", {
        operationId, traceId, stage, reason: "queue_limit", maxQueuedEvents, maxQueuedBytes,
      });
      return Promise.resolve(false);
    }
    queue.push({ stage, value, bytes }); queuedBytes += bytes; pump();
    // Recording is fail-open: translation code never waits for diagnostics.
    return Promise.resolve(true);
  };
  recorder.flush = (deadlineMs = relayTimeoutMs) => {
    return (async () => {
      const deadline = Math.max(0, Number(deadlineMs) || 0);
      if (!pumping && queue.length) pump();
      if (!pumping) return !disabled;
      let timer = null;
      try {
        await Promise.race([drainPromise, new Promise((resolve) => {
          timer = setTimeout(resolve, deadline);
        })]);
      } finally { if (timer != null) clearTimeout(timer); }
      return !disabled && !pumping && queue.length === 0;
    })();
  };
  recorder("trace_started");
  return recorder;
}
