// Authoritative, bounded trace negotiation used by UI actions that can occur
// before the first translation job (notably Local-AI Connect).
import { getCapabilities, forgetCapabilities } from "./capabilities.js";
import {
  flushTrace,
  resetTracingForBaseChange,
  setTracingEnabled,
} from "../shared/trace.js";

let activeBase = "";
let handshakeEpoch = 0;
const inFlight = new Map();
let lastHandshake = {
  outcome: "unnegotiated", status: 0, durationMs: 0,
  endpointClass: "empty", traceSession: "", traceFile: "",
};

function endpointClass(rawBase) {
  try {
    const host = new URL(String(rawBase || "")).hostname.toLowerCase();
    if (!host) return "empty";
    if (host === "localhost" || host === "127.0.0.1" || host === "::1")
      return "loopback";
    if (/^10\./.test(host) || /^192\.168\./.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) || /^fc|^fd/i.test(host))
      return "private";
    return "public";
  } catch {
    return rawBase ? "invalid" : "empty";
  }
}

function rememberHandshake(base, result = {}) {
  const caps = result?.caps || {};
  lastHandshake = {
    outcome: String(result?.reason || (result?.known ?
      (result.trace ? "active" : "disabled") : "unavailable")),
    status: Number(caps?.probe?.status || 0),
    durationMs: Math.max(0, Number(caps?.probe?.durationMs || 0)),
    endpointClass: endpointClass(base),
    traceSession: String(caps?.traceSession || ""),
    traceFile: String(caps?.traceFile || ""),
  };
  return result;
}

/** Trusted diagnostic snapshot. Contains no URL, host, request or credential. */
export function getTraceHandshakeState() {
  return { schema: "tp.trace-handshake/1", ...lastHandshake };
}

export async function ensureTraceHandshake(rawBase) {
  const base = String(rawBase || "").replace(/\/+$/, "");
  if (!base) return rememberHandshake(base,
    { known: false, trace: false, reason: "no_api_base" });
  if (activeBase && activeBase !== base) {
    handshakeEpoch += 1;
    resetTracingForBaseChange();
  }
  activeBase = base;
  if (inFlight.has(base)) return inFlight.get(base);
  const epoch = handshakeEpoch;
  const task = (async () => {
    const caps = await getCapabilities(base, { forceRefresh: true });
    if (epoch !== handshakeEpoch || base !== activeBase) {
      return rememberHandshake(base,
        { known: false, trace: false, reason: "stale_capabilities", caps });
    }
    // Probe failures are not authoritative trace=false. Preserve the bounded
    // memory prefix so a later successful handshake can still tell the story.
    if (caps?.reason)
      return rememberHandshake(base, {
        known: false,
        trace: false,
        reason: "capabilities_unavailable",
        caps,
      });
    setTracingEnabled(
      caps.trace === true,
      () => base,
      caps.traceDetail,
      caps.traceSession,
      async () => {
        forgetCapabilities(base);
        const refreshed = await getCapabilities(base, { forceRefresh: true });
        if (!refreshed?.reason) rememberHandshake(base, {
          known: true, trace: refreshed.trace === true, caps: refreshed,
        });
        return refreshed;
      },
    );
    if (caps.trace === true) await flushTrace();
    return rememberHandshake(base,
      { known: true, trace: caps.trace === true, caps });
  })().finally(() => inFlight.delete(base));
  inFlight.set(base, task);
  return task;
}

export function resetTraceHandshakeIdentity() {
  handshakeEpoch += 1;
  activeBase = "";
  inFlight.clear();
  resetTracingForBaseChange();
  lastHandshake = {
    outcome: "unnegotiated", status: 0, durationMs: 0,
    endpointClass: "empty", traceSession: "", traceFile: "",
  };
}
