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

export async function ensureTraceHandshake(rawBase) {
  const base = String(rawBase || "").replace(/\/+$/, "");
  if (!base) return { known: false, trace: false, reason: "no_api_base" };
  if (activeBase && activeBase !== base) {
    handshakeEpoch += 1;
    resetTracingForBaseChange();
  }
  activeBase = base;
  if (inFlight.has(base)) return inFlight.get(base);
  const epoch = handshakeEpoch;
  const task = (async () => {
    const caps = await getCapabilities(base);
    if (epoch !== handshakeEpoch || base !== activeBase) {
      return { known: false, trace: false, reason: "stale_capabilities", caps };
    }
    // Probe failures are not authoritative trace=false. Preserve the bounded
    // memory prefix so a later successful handshake can still tell the story.
    if (caps?.reason)
      return {
        known: false,
        trace: false,
        reason: "capabilities_unavailable",
        caps,
      };
    setTracingEnabled(
      caps.trace === true,
      () => base,
      caps.traceDetail,
      caps.traceSession,
      async () => {
        forgetCapabilities(base);
        return getCapabilities(base);
      },
    );
    if (caps.trace === true) await flushTrace();
    return { known: true, trace: caps.trace === true, caps };
  })().finally(() => inFlight.delete(base));
  inFlight.set(base, task);
  return task;
}

export function resetTraceHandshakeIdentity() {
  handshakeEpoch += 1;
  activeBase = "";
  inFlight.clear();
  resetTracingForBaseChange();
}
