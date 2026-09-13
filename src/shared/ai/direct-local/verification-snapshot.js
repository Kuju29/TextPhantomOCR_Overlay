/** Shared Local AI verification snapshot contract used by popup and background. */

export const LOCAL_CAPABILITY_SNAPSHOTS_KEY = "aiLocalCapabilitySnapshotsV1";
export const LOCAL_MODEL_VERIFICATION_MAX_AGE_MS = 5 * 60 * 1000;
export const LOCAL_MODEL_VERIFICATION_VERSION = 2;

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
  thinking = "off",
  now = Date.now(),
  maxAgeMs = LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
} = {}) {
  if (!record) return { fresh: false, reason: "missing" };
  const expectedIdentity = normalizeLocalConnectionIdentity(provider, endpoint);
  if (String(record.identity || "") !== expectedIdentity)
    return { fresh: false, reason: "identity_mismatch" };
  if (String(record.verificationStatus || "") !== "passed")
    return { fresh: false, reason: "verification_not_passed" };
  // Earlier proofs accepted text from an incomplete provider stream and could
  // label an in-flight probe with a newer thinking setting.
  if (record.verificationVersion !== LOCAL_MODEL_VERIFICATION_VERSION)
    return { fresh: false, reason: "verification_version_mismatch" };
  const selectedModel = String(model || "").trim();
  if (!selectedModel || String(record.verifiedModel || "").trim() !== selectedModel)
    return { fresh: false, reason: "model_mismatch" };
  const requestedThinking = thinking === "on" ? "on" : "off";
  const verifiedThinking = String(record.verifiedThinking || "off") === "on" ? "on" : "off";
  if (verifiedThinking !== requestedThinking)
    return { fresh: false, reason: "thinking_mismatch" };
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
  thinking = "off",
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
    verifiedThinking: thinking === "on" ? "on" : "off",
    verificationStatus: String(verification?.status || "not_tested"),
    verificationVersion: LOCAL_MODEL_VERIFICATION_VERSION,
    checkedAt: Number(checkedAt) || Date.now(),
  };
}
