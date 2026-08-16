// Probes and caches what the configured API server can do.

import { API_PATHS } from "../shared/constants.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.caps");

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map();

// Returns the capability set assumed for a server that never answered /v1/capabilities.
function legacyCapabilities(reason) {
  return {
    apiVersion: "legacy",
    syncTranslate: false,
    clientBackground: false,
    trace: false,
    traceDetail: "off",
    traceSession: "",
    traceFile: "",
    traceStartedAt: "",
    diagnostics: "normal",
    consoleLevel: "warn",
    logFile: null,
    capacity: null,
    capacityAi: null,
    adaptive: null,
    reason,
  };
}

// Turns a /v1/capabilities response into the capability object the rest of the worker reads.
function parse(data) {
  const features = data?.features && typeof data.features === "object" ? data.features : {};
  const advertisedTraceDetail = String(features.traceDetail || "").trim().toLowerCase();
  const traceDetail = features.trace !== true
    ? "off"
    : advertisedTraceDetail === "compact" || advertisedTraceDetail === "full"
      ? advertisedTraceDetail
      : "full";
  const diagnostics = ["normal", "activity", "deep"].includes(String(features.diagnostics || "").toLowerCase())
    ? String(features.diagnostics).toLowerCase()
    : traceDetail === "full" ? "deep" : traceDetail === "compact" ? "activity" : "normal";
  const advertisedLevel = String(features.consoleLevel || "").toLowerCase();
  const consoleLevel = ["debug", "info", "warn", "error"].includes(advertisedLevel)
    ? advertisedLevel
    : diagnostics === "deep" ? "debug" : diagnostics === "activity" ? "info" : "warn";
  return {
    apiVersion: String(data?.apiVersion || ""),
    syncTranslate: features.syncTranslate === true,
    clientBackground: features.clientBackground === true,
    // Tracing is switched on by the server only; the extension has no setting of its own.
    trace: features.trace === true,
    traceDetail,
    traceSession: String(features.traceSession || ""),
    traceFile: String(features.traceFile || ""),
    traceStartedAt: String(features.traceStartedAt || ""),
    diagnostics,
    consoleLevel,
    // null means the server did not advertise /v1/logs support; false means do not call it.
    logFile: typeof features.logFile === "boolean" ? features.logFile : null,
    schemas: Array.isArray(data?.schemas) ? data.schemas : [],
    capacity: data?.capacity && typeof data.capacity === "object" ? data.capacity : null,
    capacityAi: data?.capacityAi && typeof data.capacityAi === "object" ? data.capacityAi : null,
    adaptive: data?.adaptive && typeof data.adaptive === "object" ? data.adaptive : null,
    reason: "",
  };
}

// Returns the capabilities of an API base, probing at most once per TTL and reporting an unreachable server as legacy.
export async function getCapabilities(base) {
  const key = String(base || "").replace(/\/+$/, "");
  if (!key) return legacyCapabilities("no api base configured");

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.caps;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  let caps;
  try {
    const res = await fetch(key + API_PATHS.CAPABILITIES, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.status === 404 || res.status === 405) {
      caps = legacyCapabilities(`server has no ${API_PATHS.CAPABILITIES} (HTTP ${res.status})`);
    } else if (!res.ok) {
      caps = legacyCapabilities(`capabilities probe returned HTTP ${res.status}`);
    } else {
      caps = parse(await res.json());
    }
  } catch (e) {
    caps = legacyCapabilities(
      e?.name === "AbortError"
        ? `capabilities probe timed out after ${PROBE_TIMEOUT_MS}ms`
        : `capabilities probe failed: ${e?.message || String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  cache.set(key, { at: Date.now(), caps });
  if (caps.syncTranslate) {
    log.info("api supports the sync path", { api: caps.apiVersion });
  } else {
    log.warn("api does NOT support the sync path — legacy submit+poll is available only to allowed routes", {
      reason: caps.reason,
    });
  }
  return caps;
}

// Drops the cached capabilities for one base, or for every base when none is given.
export function forgetCapabilities(base = "") {
  if (base) cache.delete(String(base).replace(/\/+$/, ""));
  else cache.clear();
}

// Returns a user-facing compatibility failure when the selected engine cannot
// be honoured by this API build.  In particular, an extension-owned text job
// must never be handed to the legacy full-server pipeline merely because the
// capability probe did not advertise the synchronous split pipeline.
export function engineCompatibilityIssue(payload, caps) {
  const extensionText = payload?.engine !== "api" && payload?.mode === "lens_text";
  if (!extensionText || caps?.syncTranslate === true) return "";
  const detail = String(caps?.reason || "the API did not advertise syncTranslate").trim();
  return (
    "Extension engine compatibility error: this API build cannot run the extension-owned " +
    `text pipeline (${detail}). Update/start the matching API build or select API server. ` +
    "The job was stopped; it was not sent to the legacy full-server pipeline."
  );
}
