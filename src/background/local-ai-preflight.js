/**
 * Background-owned Local AI readiness gate.
 *
 * The popup is not guaranteed to be open before a batch starts. A saved popup
 * snapshot is therefore only a short-lived cache; the service worker confirms
 * the exact provider + endpoint + model and its capability metadata before
 * admitting a Local AI batch. No dummy generation is allowed here.
 */
import { getStorage, setStorage } from "../shared/storage.js";
import { classifyAiRuntime } from "../shared/ai-settings-contract.js";
import { normalizeReasoningPreference } from "../shared/reasoning-preference.js";
import {
  localAiPreset,
  normalizeLocalAiAdapter,
} from "../shared/ai/providers/local-registry.js";
import { discoverLocalModels } from "../shared/ai/direct-local/model-discovery.js";
import {
  LOCAL_CAPABILITY_SNAPSHOTS_KEY,
  LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
  buildLocalCapabilityHint,
  buildLocalVerificationSnapshot,
  localVerificationSnapshotStatus,
  normalizeLocalConnectionEndpoint,
  normalizeLocalConnectionIdentity,
  savedLocalCapabilitySnapshot,
} from "../shared/ai/direct-local/verification-snapshot.js";
import { note as traceNote } from "../shared/trace.js";

const inFlight = new Map();

function exactLocalAdapter(settings, provider, endpoint) {
  if (settings?.localAiAdapter && typeof settings.localAiAdapter === "object") {
    return normalizeLocalAiAdapter(
      { ...settings.localAiAdapter, baseUrl: endpoint },
      { provider },
    );
  }
  const preset = localAiPreset(provider);
  if (!preset) {
    const error = new Error("Local AI adapter is missing for the selected provider");
    error.code = "LOCAL_ADAPTER_MISSING";
    throw error;
  }
  return normalizeLocalAiAdapter({ ...preset, baseUrl: endpoint }, { provider });
}

function readinessError(verification, cause = null) {
  const status = String(verification?.status || cause?.code || "unreachable");
  const table = {
    model_unavailable: [
      "LOCAL_MODEL_UNAVAILABLE",
      "The selected Local AI model is not installed or is not exposed by the current runtime.",
    ],
    unsupported_model: [
      "LOCAL_MODEL_UNSUPPORTED",
      "The selected Local AI model is installed but its runtime metadata says it cannot generate chat completions.",
    ],
    invalid_output: [
      "LOCAL_MODEL_METADATA_INVALID",
      "The selected Local AI model did not expose usable capability metadata.",
    ],
    local_models_empty: [
      "LOCAL_MODELS_EMPTY",
      "The Local AI runtime returned no installed models.",
    ],
    local_ai_timeout: [
      "LOCAL_AI_UNREACHABLE",
      "The Local AI runtime did not answer model discovery in time.",
    ],
    local_ai_unreachable: [
      "LOCAL_AI_UNREACHABLE",
      "The Local AI runtime on this PC could not be reached.",
    ],
    unreachable: [
      "LOCAL_AI_UNREACHABLE",
      "The Local AI runtime could not confirm the selected model's availability.",
    ],
  };
  const [code, message] = table[status] || [
    "LOCAL_MODEL_METADATA_INVALID",
    "The selected Local AI model could not be confirmed from runtime metadata before translation started.",
  ];
  const error = new Error(message);
  if (cause) error.cause = cause;
  error.code = code;
  error.profileValidationStage = "local_model_preflight";
  error.profileValidationReason = status;
  error.requestDispatched = false;
  error.providerAttempts = 0;
  error.generationAttempts = 0;
  error.verificationStatus = status;
  return error;
}

async function clearActiveHint(set) {
  try { await set({ aiLocalCapabilityHint: null }); } catch {}
}

function enrichSettings(settings, hint) {
  return {
    ...settings,
    aiLocalCapabilityHint: structuredClone(hint),
    aiModelCapabilities:
      hint?.modelCapabilities && typeof hint.modelCapabilities === "object"
        ? structuredClone(hint.modelCapabilities)
        : {},
  };
}

function trace(event, data, traceId, emit = traceNote) {
  emit(
    "background/local-ai-preflight.js",
    "localModelPreflight",
    { event, ...data },
    traceId,
  );
}

/**
 * Confirm the exact Local AI execution identity before a batch is admitted.
 * Returns settings enriched with selected-model capability metadata. The first
 * real translation request is the first generation request; readiness must not
 * load a model merely to produce a throw-away "OK".
 */
export async function ensureLocalAiBatchReady(settings, {
  traceId = "",
  now = Date.now(),
  maxAgeMs = LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
  probeTimeoutMs = 5_000,
  force = false,
  get = getStorage,
  set = setStorage,
  discover = discoverLocalModels,
  emitTrace = traceNote,
} = {}) {
  if (!classifyAiRuntime(settings).local) {
    return {
      settings,
      audit: { status: "skipped", reason: "not_local" },
    };
  }

  const provider = String(settings?.aiProvider || "").trim().toLowerCase();
  const endpoint = normalizeLocalConnectionEndpoint(settings?.aiBaseUrl);
  const model = String(settings?.aiModel || "").trim();
  const thinking = normalizeReasoningPreference(
    settings?.aiLocalThinking ?? settings?.aiThinking,
    "off",
  );

  if (!provider || !endpoint || !model || model.toLowerCase() === "auto") {
    throw readinessError({ status: !model || model.toLowerCase() === "auto"
      ? "model_unavailable"
      : "unreachable" });
  }

  const identity = normalizeLocalConnectionIdentity(provider, endpoint);
  const executionKey = `${identity}|${model}`;
  const run = async () => {
    const stored = await get([
      LOCAL_CAPABILITY_SNAPSHOTS_KEY,
      "aiLocalCapabilityHint",
    ]);
    const records = stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] &&
      typeof stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] === "object"
      ? stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY]
      : {};
    const snapshot = savedLocalCapabilitySnapshot(records, provider, endpoint);
    const cached = localVerificationSnapshotStatus(snapshot, {
      provider,
      endpoint,
      model,
      thinking,
      now,
      maxAgeMs,
    });
    if (!force && cached.fresh) {
      const hint = buildLocalCapabilityHint({
        provider,
        endpoint,
        model,
        capability: snapshot.capability,
      });
      if (hint) {
        trace("cache_hit", {
          provider,
          model,
          thinking,
          ageMs: cached.ageMs,
          verificationStatus: "passed",
        }, traceId, emitTrace);
        const currentHint = stored?.aiLocalCapabilityHint;
        const sameHint =
          String(currentHint?.provider || "") === provider &&
          normalizeLocalConnectionEndpoint(currentHint?.baseUrl) === endpoint &&
          String(currentHint?.model || "") === model;
        if (!sameHint) await set({ aiLocalCapabilityHint: hint });
        return {
          hint,
          audit: {
            status: "passed",
            source: "fresh_snapshot",
            ageMs: cached.ageMs,
            provider,
            model,
            thinking,
          },
        };
      }
    }

    trace("metadata_check_started", {
      provider,
      model,
      thinking,
      cacheReason: cached.reason,
    }, traceId, emitTrace);

    let result;
    try {
      const adapter = exactLocalAdapter(settings, provider, endpoint);
      result = await discover(adapter, {
        provider,
        model,
        thinking,
        verifySelected: true,
        probeTimeoutMs,
      });
    } catch (cause) {
      trace("metadata_check_failed", {
        provider,
        model,
        thinking,
        verificationStatus: String(cause?.code || "unreachable"),
      }, traceId, emitTrace);
      await clearActiveHint(set);
      throw readinessError({ status: cause?.code || "unreachable" }, cause);
    }

    const verification = result?.selectedModelVerification || {
      model,
      status: "not_tested",
    };
    const passed = verification.status === "passed" &&
      String(verification.model || "").trim() === model &&
      Array.isArray(result?.models) && result.models.includes(model);
    if (!passed) {
      trace("metadata_check_failed", {
        provider,
        model,
        thinking,
        verificationStatus: String(verification.status || "not_tested"),
      }, traceId, emitTrace);
      await clearActiveHint(set);
      throw readinessError(verification);
    }

    const capability = result?.capability && typeof result.capability === "object"
      ? result.capability
      : null;
    const hint = buildLocalCapabilityHint({ provider, endpoint, model, capability });
    if (!hint) {
      trace("metadata_check_failed", {
        provider,
        model,
        thinking,
        verificationStatus: "model_capability_missing",
      }, traceId, emitTrace);
      await clearActiveHint(set);
      throw readinessError({ status: "invalid_output" });
    }

    const checkedAt = Date.now();
    const record = buildLocalVerificationSnapshot({
      provider,
      endpoint,
      capability,
      models: result.models,
      verification,
      thinking,
      checkedAt,
    });
    await set({
      [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: {
        ...records,
        [identity]: record,
      },
      aiLocalCapabilityHint: hint,
    });
    trace("metadata_check_passed", {
      provider,
      model,
      thinking,
      modelCount: result.models.length,
      elapsedMs: Number(verification.elapsedMs) || null,
    }, traceId, emitTrace);
    return {
      hint,
      audit: {
        status: "passed",
        source: "live_metadata",
        ageMs: 0,
        provider,
        model,
        thinking,
      },
    };
  };

  let pending = inFlight.get(executionKey);
  if (!pending) {
    pending = run().finally(() => {
      if (inFlight.get(executionKey) === pending) inFlight.delete(executionKey);
    });
    inFlight.set(executionKey, pending);
  } else {
    trace("metadata_check_joined", { provider, model }, traceId, emitTrace);
  }
  // Share availability/capability evidence only. Each batch still owns its prompt, language,
  // memory mode and other execution settings, even when it joins the same metadata check.
  const evidence = await pending;
  return {
    settings: enrichSettings(settings, evidence.hint),
    audit: { ...evidence.audit },
  };
}

export function clearLocalAiPreflightInflightForTest() {
  inFlight.clear();
}
