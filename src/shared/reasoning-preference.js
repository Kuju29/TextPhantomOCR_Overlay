/** Provider-neutral user intent for model reasoning/thinking controls. */
export const REASONING_PREFERENCES = Object.freeze([
  "minimum", "default", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

const PREFERENCE_SET = new Set(REASONING_PREFERENCES);
const EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const EFFORT_SET = new Set(EFFORTS);

export function normalizeReasoningPreference(value, fallback = "minimum") {
  if (value === true) return "on";
  if (value === false) return "off";
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "auto") return "minimum";
  if (raw === "provider" || raw === "provider_default") return "default";
  if (raw === "lowest" || raw === "lowest_available" || raw === "min") return "minimum";
  if (raw === "none") return "off";
  if (PREFERENCE_SET.has(raw)) return raw;
  const safeFallback = String(fallback || "minimum").trim().toLowerCase();
  return PREFERENCE_SET.has(safeFallback) ? safeFallback : "minimum";
}

export function normalizeUserReasoningPreference(value) {
  // Persist the policy, not its current model-specific result. New/reset
  // profiles choose Lowest available. Earlier builds stored "default" or
  // "auto"; keep those profiles on their former Lowest available policy.
  // The leaf adapter resolves this intent only when building a request.
  const normalized = normalizeReasoningPreference(value, "minimum");
  return normalized === "default" ? "minimum" : normalized;
}

export function reasoningEffortPreference(value) {
  const normalized = normalizeReasoningPreference(value, "default");
  return EFFORT_SET.has(normalized) ? normalized : "";
}

/** Return the concrete model options in ascending reasoning cost/strength. */
export function concreteReasoningPreferences(reasoning) {
  const cap = reasoning && typeof reasoning === "object" ? reasoning : {};
  if (cap.supported !== true) return [];
  const mandatory = cap.mandatory === true;
  const control = String(cap.control || "provider");
  const supported = new Set(Array.isArray(cap.supported_efforts)
    ? cap.supported_efforts.map(value => String(value || "").trim().toLowerCase())
    : []);
  const options = [];
  // Explicit mandatory=false is enough to preserve Off as an executable user
  // intent even when a stale catalogue snapshot omits can_disable/none.
  if (!mandatory && (cap.mandatory === false || cap.can_disable === true || control === "toggle" || control === "boolean" || supported.has("none")))
    options.push("off");
  if (control === "toggle" || control === "boolean") {
    if (!Array.isArray(cap.supported_efforts) || supported.has("on")) options.push("on");
    return options;
  }
  if (control === "levels")
    for (const effort of EFFORTS) if (supported.has(effort)) options.push(effort);
  return options;
}

/** Lowest available is an alias for the first concrete option, never a fixed effort. */
export function minimumReasoningPreference(reasoning) {
  const concrete = concreteReasoningPreferences(reasoning);
  // A verified disable control is lower than any named reasoning level.
  if (concrete[0] === "off") return "off";
  // A provider may advertise an unfamiliar named level that could rank below
  // every level we recognize. Do not assert a known level is its minimum.
  const unknownLevel = Array.isArray(reasoning?.supported_efforts) &&
    reasoning.supported_efforts.some(value =>
      !EFFORT_SET.has(String(value).trim().toLowerCase()) &&
      !["off", "none", "on"].includes(String(value).trim().toLowerCase()));
  if (reasoning?.minimum_unresolved === true || unknownLevel) return "default";
  return concrete[0] || "default";
}

export function reasoningOptionsForCapability(reasoning) {
  const cap = reasoning && typeof reasoning === "object" ? reasoning : null;
  if (!cap || typeof cap.supported !== "boolean") {
    return [
      { value: "minimum", label: "Lowest available" },
      { value: "off", label: "Thinking off" },
    ];
  }
  // Even when the resolved result is Off, keep the Lowest available policy
  // selectable. Capability refresh must not replace a user's stored intent.
  if (cap.supported === false) return [
    { value: "minimum", label: "Lowest available" },
    { value: "off", label: "Thinking off" },
  ];

  const options = [{ value: "minimum", label: "Lowest available" }];
  const labels = {
    off: "Thinking off", on: "Thinking on",
    minimal: "Thinking minimal", low: "Thinking low", medium: "Thinking medium",
    high: "Thinking high", xhigh: "Thinking xhigh", max: "Thinking max", ultra: "Thinking ultra",
  };
  for (const value of concreteReasoningPreferences(cap))
    options.push({ value, label: labels[value] || `Thinking ${value}` });
  return options;
}

/** Resolve provider-neutral intent to one concrete, capability-proven mode. */
export function resolveReasoningPreference(value, reasoning) {
  const requested = normalizeReasoningPreference(value, "minimum");
  const cap = reasoning && typeof reasoning === "object" ? reasoning : {};
  const minimum = minimumReasoningPreference(cap);
  if (requested === "minimum") return minimum;
  // Off is a user constraint, not a hint. A provider that cannot prove it can
  // honor Off must reject the request before dispatch instead of silently
  // converting it to its lowest enabled reasoning level.
  if (requested === "off") return "off";
  const options = reasoningOptionsForCapability(cap);
  if (!options.length) return "default";
  if (options.some(option => option.value === requested)) return requested;
  return "default";
}

export function reasoningPreferenceIsActive(value, reasoning) {
  const selected = resolveReasoningPreference(value, reasoning);
  if (selected === "off") return false;
  if (selected === "on" || EFFORT_SET.has(selected)) return true;
  const cap = reasoning && typeof reasoning === "object" ? reasoning : {};
  return cap.mandatory === true || cap.default_enabled === true;
}
