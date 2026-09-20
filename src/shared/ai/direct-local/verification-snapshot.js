import { normalizeReasoningPreference } from "../../reasoning-preference.js";
/** Shared Local AI availability/capability snapshot used by popup and background. */

export const LOCAL_CAPABILITY_SNAPSHOTS_KEY = "aiLocalCapabilitySnapshotsV1";
export const LOCAL_MODEL_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;
export const LOCAL_MODEL_VERIFICATION_VERSION = 5;

export function normalizeLocalConnectionEndpoint(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function normalizeLocalConnectionIdentity(provider, endpoint) {
  return `${String(provider || "").trim().toLowerCase()}|${normalizeLocalConnectionEndpoint(endpoint)}`;
}

export function savedLocalCapabilitySnapshot(records, provider, endpoint) {
  const key = normalizeLocalConnectionIdentity(provider, endpoint);
  const record = records && typeof records === "object" ? records[key] : null;
  if (!record || record.identity !== key || !record.capability ||
      typeof record.capability !== "object") return null;
  return record;
}

export function localVerificationSnapshotStatus(record, {
  provider,
  endpoint,
  model,
  // Retained in the call contract for compatibility. Availability metadata is
  // deliberately independent from the user's current reasoning preference.
  thinking = "minimum",
  now = Date.now(),
  maxAgeMs = LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
} = {}) {
  void thinking;
  if (!record) return { fresh: false, reason: "missing" };
  const expectedIdentity = normalizeLocalConnectionIdentity(provider, endpoint);
  if (String(record.identity || "") !== expectedIdentity)
    return { fresh: false, reason: "identity_mismatch" };
  if (String(record.verificationStatus || "") !== "passed")
    return { fresh: false, reason: "availability_not_passed" };
  if (record.verificationVersion !== LOCAL_MODEL_VERIFICATION_VERSION)
    return { fresh: false, reason: "verification_version_mismatch" };
  const selectedModel = String(model || "").trim();
  if (!selectedModel || String(record.verifiedModel || "").trim() !== selectedModel)
    return { fresh: false, reason: "model_mismatch" };
  if (!Array.isArray(record.models) || !record.models.includes(selectedModel))
    return { fresh: false, reason: "model_unavailable" };
  if (!record.capability?.models?.[selectedModel])
    return { fresh: false, reason: "model_capability_missing" };
  const checkedAt = Number(record.checkedAt) || 0;
  const ageMs = Math.max(0, Number(now) - checkedAt);
  if (!checkedAt || ageMs > Math.max(0, Number(maxAgeMs) || 0))
    return { fresh: false, reason: "expired", ageMs };
  return { fresh: true, reason: "fresh", ageMs };
}

export function buildLocalCapabilityHint({ provider, endpoint, model, capability } = {}) {
  const selected = String(model || "").trim();
  const modelHint = capability?.models?.[selected];
  if (!selected || !modelHint || typeof modelHint !== "object") return null;
  const recommendedMax = Number(modelHint.recommendedMax);
  return {
    provider: String(provider || "").trim().toLowerCase(),
    baseUrl: normalizeLocalConnectionEndpoint(endpoint),
    model: selected,
    recommendedMax: Number.isFinite(recommendedMax)
      ? Math.min(2, Math.max(1, Math.floor(recommendedMax)))
      : 1,
    reason: String(modelHint.reason || capability?.reason || ""),
    structuredOutput:
      modelHint.structuredOutput && typeof modelHint.structuredOutput === "object"
        ? { ...modelHint.structuredOutput }
        : null,
    modelCapabilities: {
      ...(modelHint.generation && typeof modelHint.generation === "object"
        ? { generation: { ...modelHint.generation } }
        : {}),
      ...(modelHint.reasoning && typeof modelHint.reasoning === "object"
        ? { reasoning: { ...modelHint.reasoning } }
        : {}),
      ...(modelHint.structuredOutput && typeof modelHint.structuredOutput === "object"
        ? { structuredOutput: { ...modelHint.structuredOutput } }
        : {}),
      ...(modelHint.limits && typeof modelHint.limits === "object"
        ? { limits: { ...modelHint.limits } }
        : {}),
    },
  };
}

export function buildLocalVerificationSnapshot({
  provider,
  endpoint,
  capability,
  models,
  verification,
  thinking = "minimum",
  checkedAt = Date.now(),
} = {}) {
  const identity = normalizeLocalConnectionIdentity(provider, endpoint);
  return {
    identity,
    provider: String(provider || "").trim().toLowerCase(),
    endpoint: normalizeLocalConnectionEndpoint(endpoint),
    models: Array.isArray(models) ? [...models] : [],
    capability,
    verifiedModel:
      verification?.status === "passed"
        ? String(verification.model || "").trim()
        : "",
    // Kept for diagnostics/backward readability only. Version 5 freshness no
    // longer depends on this field because no generation happens here.
    verifiedThinking: normalizeReasoningPreference(thinking, "minimum"),
    verificationEvidence: String(verification?.evidence || "model_metadata"),
    metadataOnly: verification?.metadataOnly === true,
    verificationStatus: String(verification?.status || "not_tested"),
    verificationVersion: LOCAL_MODEL_VERIFICATION_VERSION,
    checkedAt: Number(checkedAt) || Date.now(),
  };
}
