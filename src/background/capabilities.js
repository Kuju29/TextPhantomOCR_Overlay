// Probes and caches what the configured API server can do.

import { note } from "../shared/trace.js";
import { API_PATHS } from "../shared/constants.js";
import { createLogger } from "../shared/logger.js";
import { noteApiSuccess } from "./api.js";

const log = createLogger("SW.caps");

// A cold Hugging Face Space answers its first request in tens of seconds, not
// milliseconds. Five seconds was short enough that every user who arrived
// while the container was booting was told the server could not do the job.
const PROBE_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000;
// A failed probe describes one bad moment — a booting server, a 502 from the
// host, a dropped socket. Remembering it for as long as a real answer turned
// seconds of upstream trouble into ten minutes of "every image on every site
// fails", continuing long after the server was healthy again.
const FAILED_CACHE_TTL_MS = 15 * 1000;

const cache = new Map();
const freshScopes = new Map();

// Returns the capability set assumed for a server that never answered /v1/capabilities.
function legacyCapabilities(reason, probe = {}) {
  return {
    apiVersion: "legacy",
    syncTranslate: false,
    engineRoutesV2: false,
    clientBackground: false,
    trace: false,
    traceDetail: "off",
    traceSession: "",
    traceFile: "",
    traceStartedAt: "",
    aiWireTrace: false,
    diagnostics: "normal",
    consoleLevel: "warn",
    logFile: null,
    capacity: null,
    capacityAi: null,
    capacityGroups: null,
    adaptive: null,
    reason,
    probe: {
      outcome: String(probe.outcome || "unavailable"),
      status: Number(probe.status) || 0,
      durationMs: Math.max(0, Number(probe.durationMs) || 0),
      errorName: String(probe.errorName || "").slice(0, 80),
      origin: String(probe.origin || "").slice(0, 200),
    },
  };
}

// Turns a /v1/capabilities response into the capability object the rest of the worker reads.
function parse(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !data.features ||
    typeof data.features !== "object" ||
    Array.isArray(data.features)
  ) {
    throw new TypeError("capabilities response has no features object");
  }
  const features =
    data?.features && typeof data.features === "object" ? data.features : {};
  const advertisedTraceDetail = String(features.traceDetail || "")
    .trim()
    .toLowerCase();
  const traceDetail =
    features.trace !== true
      ? "off"
      : advertisedTraceDetail === "compact" || advertisedTraceDetail === "full"
        ? advertisedTraceDetail
        : "full";
  const diagnostics = ["normal", "activity", "deep"].includes(
    String(features.diagnostics || "").toLowerCase(),
  )
    ? String(features.diagnostics).toLowerCase()
    : traceDetail === "full"
      ? "deep"
      : traceDetail === "compact"
        ? "activity"
        : "normal";
  const advertisedLevel = String(features.consoleLevel || "").toLowerCase();
  const consoleLevel = ["debug", "info", "warn", "error"].includes(
    advertisedLevel,
  )
    ? advertisedLevel
    : diagnostics === "deep"
      ? "debug"
      : diagnostics === "activity"
        ? "info"
        : "warn";
  return {
    apiVersion: String(data?.apiVersion || ""),
    syncTranslate: features.syncTranslate === true,
    engineRoutesV2: features.engineRoutesV2 === true,
    clientBackground: features.clientBackground === true,
    // Tracing is switched on by the server only; the extension has no setting of its own.
    trace: features.trace === true,
    traceDetail,
    traceSession: String(features.traceSession || ""),
    traceFile: String(features.traceFile || ""),
    traceStartedAt: String(features.traceStartedAt || ""),
    aiWireTrace: features.aiWireTrace === true,
    aiWireTraceRelay:
      features.aiWireTraceRelay && typeof features.aiWireTraceRelay === "object"
        ? {
            path: String(features.aiWireTraceRelay.path || ""),
            token: String(features.aiWireTraceRelay.token || ""),
            maxEventBytes: Number(features.aiWireTraceRelay.maxEventBytes) || 0,
          }
        : null,
    diagnostics,
    consoleLevel,
    // null means the server did not advertise /v1/logs support; false means do not call it.
    logFile: typeof features.logFile === "boolean" ? features.logFile : null,
    schemas: Array.isArray(data?.schemas) ? data.schemas : [],
    capacity:
      data?.capacity && typeof data.capacity === "object"
        ? data.capacity
        : null,
    capacityAi:
      data?.capacityAi && typeof data.capacityAi === "object"
        ? data.capacityAi
        : null,
    capacityGroups:
      data?.capacityGroups && typeof data.capacityGroups === "object"
        ? data.capacityGroups : null,
    adaptive:
      data?.adaptive && typeof data.adaptive === "object"
        ? data.adaptive
        : null,
    reason: "",
    probe: {
      outcome: "ok",
      status: 200,
      durationMs: 0,
      errorName: "",
      origin: "",
    },
  };
}

function safeOrigin(base) {
  try {
    return new URL(base).origin;
  } catch {
    return "invalid";
  }
}

export function capabilityFailureDetails(caps) {
  const probe = caps?.probe && typeof caps.probe === "object" ? caps.probe : {};
  const outcome = String(probe.outcome || "");
  const status = Number(probe.status) || 0;
  const shared = {
    origin: "api",
    stage: "capabilities",
    httpStatus: status,
    diagnostic: String(caps?.reason || ""),
  };
  if (outcome === "timeout")
    return {
      ...shared,
      code: "NET_TIMEOUT",
      category: "network",
      retryable: true,
    };
  if (outcome === "network_unreachable")
    return {
      ...shared,
      code: "API_UNREACHABLE",
      category: "network",
      retryable: true,
    };
  if (outcome === "starting" || status === 502 || status === 503) {
    return {
      ...shared,
      code: "API_STARTING",
      category: "service",
      retryable: true,
    };
  }
  if (outcome === "legacy_endpoint" || status === 404 || status === 405) {
    return {
      ...shared,
      code: "API_CAPS_LEGACY",
      category: "compatibility",
      retryable: false,
    };
  }
  if (outcome === "invalid_response")
    return {
      ...shared,
      code: "API_BAD_RESPONSE",
      category: "contract",
      retryable: true,
    };
  if (outcome === "http_error") {
    return {
      ...shared,
      code: status >= 500 ? "API_5XX" : "API_HTTP_ERROR",
      category: "service",
      retryable: status >= 500,
    };
  }
  const reason = String(caps?.reason || "");
  if (/timed out/i.test(reason))
    return {
      ...shared,
      code: "NET_TIMEOUT",
      category: "network",
      retryable: true,
    };
  if (/failed to fetch|networkerror|load failed/i.test(reason))
    return {
      ...shared,
      code: "API_UNREACHABLE",
      category: "network",
      retryable: true,
    };
  if (/HTTP 50[23]/i.test(reason))
    return {
      ...shared,
      code: "API_STARTING",
      category: "service",
      retryable: true,
    };
  if (/HTTP 40[45]/i.test(reason))
    return {
      ...shared,
      code: "API_CAPS_LEGACY",
      category: "compatibility",
      retryable: false,
    };
  return {
    ...shared,
    code: "API_CAPS_UNAVAILABLE",
    category: "service",
    retryable: true,
  };
}

// Returns the capabilities of an API base, probing at most once per TTL and reporting an unreachable server as legacy.
export async function getCapabilities(base, { forceRefresh = false } = {}) {
  const key = String(base || "").replace(/\/+$/, "");
  if (!key)
    return legacyCapabilities("no api base configured", {
      outcome: "network_unreachable",
      origin: "invalid",
    });

  // `reason` is set only by legacyCapabilities(), so it is exactly "this entry
  // is a guess we made because the probe failed".
  const hit = cache.get(key);
  if (
    !forceRefresh &&
    hit &&
    Date.now() - hit.at < (hit.caps.reason ? FAILED_CACHE_TTL_MS : CACHE_TTL_MS)
  ) {
    return hit.caps;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  const origin = safeOrigin(key);
  let caps;
  try {
    const res = await fetch(key + API_PATHS.CAPABILITIES, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (res.status === 404 || res.status === 405) {
      caps = legacyCapabilities(
        `server has no ${API_PATHS.CAPABILITIES} (HTTP ${res.status})`,
        {
          outcome: "legacy_endpoint",
          status: res.status,
          origin,
        },
      );
    } else if (!res.ok) {
      caps = legacyCapabilities(
        `capabilities probe returned HTTP ${res.status}`,
        {
          outcome:
            res.status === 502 || res.status === 503
              ? "starting"
              : "http_error",
          status: res.status,
          origin,
        },
      );
    } else {
      noteApiSuccess(key);
      try {
        caps = parse(await res.json());
      } catch (e) {
        caps = legacyCapabilities("capabilities response was not valid JSON", {
          outcome: "invalid_response",
          status: res.status,
          errorName: e?.name,
          origin,
        });
      }
    }
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    caps = legacyCapabilities(
      timedOut
        ? `capabilities probe timed out after ${PROBE_TIMEOUT_MS}ms`
        : `capabilities probe failed: ${e?.message || String(e)}`,
      {
        outcome: timedOut ? "timeout" : "network_unreachable",
        errorName: e?.name,
        origin,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  caps.probe.durationMs = Math.max(0, Date.now() - startedAt);
  caps.probe.origin = origin;

  cache.set(key, { at: Date.now(), caps });
  if (caps.syncTranslate) {
    log.info("api supports the sync path", { api: caps.apiVersion });
  } else if (!["ok", "legacy_endpoint"].includes(caps.probe.outcome)) {
    log.warn(
      "api capabilities are unavailable — inspect connection/configuration before translating",
      {
        reason: caps.reason,
      },
    );
  }
  note("background/capabilities.js", "routeCapability", {
    schema:"tp.audit/1", event:"route_capability",
    reason:caps.syncTranslate ? "sync_supported" : ["ok","legacy_endpoint"].includes(caps.probe.outcome) ? "legacy_supported" : "capability_unavailable",
    timing:{status:caps.probe.status,elapsedMs:caps.probe.durationMs},
  });
  log.info("capabilities probe", {
    origin: caps.probe.origin,
    durationMs: caps.probe.durationMs,
    outcome: caps.probe.outcome,
    status: caps.probe.status || undefined,
    errorName: caps.probe.errorName || undefined,
  });
  return caps;
}

/**
 * Return one authoritative fresh capability snapshot for a logical translation
 * scope (normally one batch/pass). Concurrent images in that scope share the
 * same probe instead of issuing one /v1/capabilities request per image.
 */
export async function getFreshCapabilitiesForScope(base, scope = "") {
  const normalizedBase = String(base || "").replace(/\/+$/, "");
  const normalizedScope = String(scope || "").trim();
  if (!normalizedBase) return getCapabilities(normalizedBase, { forceRefresh: true });
  if (!normalizedScope) return getCapabilities(normalizedBase, { forceRefresh: true });
  const key = `${normalizedBase}\n${normalizedScope}`;
  const current = freshScopes.get(key);
  if (current) return current;
  const promise = getCapabilities(normalizedBase, { forceRefresh: true }).catch((error) => {
    freshScopes.delete(key);
    throw error;
  });
  freshScopes.set(key, promise);
  return promise;
}

// Drops the cached capabilities for one base, or for every base when none is given.
export function forgetCapabilities(base = "") {
  if (base) {
    const normalized = String(base).replace(/\/+$/, "");
    cache.delete(normalized);
    for (const key of freshScopes.keys())
      if (key.startsWith(`${normalized}\n`)) freshScopes.delete(key);
  } else {
    cache.clear();
    freshScopes.clear();
  }
}

// Returns a user-facing compatibility failure when the selected engine cannot
// be honoured by this API build.  In particular, an extension-owned text job
// must never be handed to the legacy full-server pipeline merely because the
// capability probe did not advertise the synchronous split pipeline.
export function engineCompatibilityIssue(payload, caps) {
  const extensionText =
    payload?.engine !== "api" && payload?.mode === "lens_text";
  if (!extensionText || caps?.syncTranslate === true) return "";
  const detail = String(
    caps?.reason || "the API did not advertise syncTranslate",
  ).trim();
  return (
    "Extension engine compatibility error: this API build cannot run the extension-owned " +
    `text pipeline (${detail}). Update/start the matching API build or select API server. ` +
    "The job was stopped; it was not sent to the legacy full-server pipeline."
  );
}
