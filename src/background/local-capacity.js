import { isLocalAiProvider, isLocalHostUrl } from "../shared/constants.js";

export const LOCAL_CAPACITY_DEFAULT_MODE = "auto";
export const LOCAL_CAPACITY_MAX = 4;

function integer(value, fallback = 0) {
  const n = Math.floor(Number(value) || 0);
  return n > 0 ? n : fallback;
}

export function isLocalAiPayload(payload) {
  const ai = payload?.ai || {};
  return isLocalAiProvider(ai.provider) || isLocalHostUrl(ai.base_url || ai?.local_adapter?.baseUrl);
}

// This is deliberately a narrow contract. Runtime discovery may publish a
// *measured/executable* concurrent-generation limit, but model size, CPU count,
// or browser hardwareConcurrency alone are not proof that two generations fit.
export function localCapacityConfig(payload) {
  const limits = payload?.limits || {};
  const modeValue = String(
    limits.capacityMode || limits.aiLocalCapacityMode || limits.localAiCapacityMode || "auto",
  ).trim().toLowerCase();
  const mode = ["auto", "safe", "manual"].includes(modeValue) ? modeValue : "auto";
  const manual = Math.min(LOCAL_CAPACITY_MAX, integer(
    limits.manualConcurrency ?? limits.aiLocalManualConcurrency ?? limits.localAiManualConcurrency,
    1,
  ));
  // Auto has a deliberately lower ceiling than Manual. Capability discovery
  // is a hint for this exact loaded model, not permission for a four-way burst.
  const evidence = Math.min(2, integer(
    limits.localCapability?.recommendedMax ??
      limits.aiLocalCapabilityConcurrency ??
      payload?.ai?.local_adapter?.capabilities?.maxConcurrentGenerations ??
      payload?.ai?.local_adapter?.maxConcurrentGenerations,
    0,
  ));
  const ceiling = mode === "manual" ? manual : (mode === "safe" ? 1 : Math.max(1, evidence));
  return { mode, manual, evidence, ceiling, initial: mode === "manual" ? manual : 1 };
}

export function normalizeLocalEndpoint(raw) {
  const value = String(raw || "").trim();
  try {
    const url = new URL(value || "http://localhost");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}:${port}${path}`;
  } catch {
    return value.toLowerCase().replace(/\/+$/, "") || "local";
  }
}

export function localRuntimeIdentity(payload) {
  const ai = payload?.ai || {};
  const adapter = ai.local_adapter || {};
  const protocol = String(adapter.protocol || ai.provider || "local").trim().toLowerCase();
  const endpoint = normalizeLocalEndpoint(adapter.baseUrl || ai.base_url);
  const model = String(ai.model || "auto").trim().toLowerCase();
  return { protocol, endpoint, model };
}

export function isLocalCapacityFailure(error) {
  if (Number(error?.generationAttempts || error?.providerAttempts || 0) < 1) return false;
  const status = Number(error?.status) || 0;
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return status === 503 || /(?:out.?of.?memory|\boom\b|cuda|vram|context.*memory|timed?.?out|timeout|overload|queue.*full)/.test(text);
}
