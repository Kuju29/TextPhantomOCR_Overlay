import { isLocalAiProvider, isLocalHostUrl } from "../shared/constants.js";

export const LOCAL_CAPACITY_DEFAULT_MODE = "auto";
export const LOCAL_CAPACITY_MAX = 4;
export const LOCAL_PROVIDER_MANAGED_MAX = 24;

function integer(value, fallback = 0) {
  const n = Math.floor(Number(value) || 0);
  return n > 0 ? n : fallback;
}

export function isLocalAiPayload(payload) {
  const ai = payload?.ai || {};
  return (
    isLocalAiProvider(ai.provider) ||
    isLocalHostUrl(ai.base_url || ai?.local_adapter?.baseUrl)
  );
}

// Runtime discovery is diagnostic because local providers do not expose one
// portable per-model concurrency contract. Auto therefore starts with one safe
// generation, learns only from successful execution, and may ramp toward a
// browser-capacity safety bound; Safe/Manual remain explicit user overrides.
export function localCapacityConfig(payload) {
  const limits = payload?.limits || {};
  const modeValue = String(
    limits.capacityMode ||
      limits.aiLocalCapacityMode ||
      limits.localAiCapacityMode ||
      "auto",
  )
    .trim()
    .toLowerCase();
  const mode = ["auto", "safe", "manual"].includes(modeValue)
    ? modeValue
    : "auto";
  const manual = Math.min(
    LOCAL_CAPACITY_MAX,
    integer(
      limits.manualConcurrency ??
        limits.aiLocalManualConcurrency ??
        limits.localAiManualConcurrency,
      1,
    ),
  );
  // Runtime metadata remains diagnostic evidence only. Ollama does not expose
  // a portable per-model concurrency limit, so its conservative `1`/`2` hint
  // must not become an artificial browser queue. In Auto, let the local
  // provider manage generation scheduling after positive execution evidence,
  // while retaining a bounded client safety ceiling derived from executable
  // browser capacity. Unknown runtimes must never burst to that ceiling first.
  const evidence = integer(
    limits.localCapability?.recommendedMax ??
      limits.aiLocalCapabilityConcurrency ??
      payload?.ai?.local_adapter?.capabilities?.maxConcurrentGenerations ??
      payload?.ai?.local_adapter?.maxConcurrentGenerations,
    0,
  );
  const browserCapacity = Math.min(
    LOCAL_PROVIDER_MANAGED_MAX,
    Math.max(2, integer(globalThis.navigator?.hardwareConcurrency, 8)),
  );
  const ceiling =
    mode === "manual" ? manual : mode === "safe" ? 1 : browserCapacity;
  return {
    mode,
    manual,
    evidence,
    ceiling,
    initial: mode === "manual" ? manual : 1,
    capacitySource: mode === "auto" ? "success_ramp_bounded" : "user_selected",
  };
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
  const protocol = String(adapter.protocol || ai.provider || "local")
    .trim()
    .toLowerCase();
  const endpoint = normalizeLocalEndpoint(adapter.baseUrl || ai.base_url);
  const model = String(ai.model || "auto")
    .trim()
    .toLowerCase();
  return { protocol, endpoint, model };
}

export function isLocalCapacityFailure(error) {
  if (Number(error?.generationAttempts || error?.providerAttempts || 0) < 1)
    return false;
  const status = Number(error?.status) || 0;
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return (
    status === 503 ||
    /(?:out.?of.?memory|\boom\b|cuda|vram|context.*memory|timed?.?out|timeout|overload|queue.*full)/.test(
      text,
    )
  );
}
