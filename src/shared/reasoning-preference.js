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
  if (raw === "auto" || raw === "provider" || raw === "provider_default") return "default";
  if (raw === "lowest" || raw === "lowest_available" || raw === "min") return "minimum";
  if (raw === "none") return "off";
  if (PREFERENCE_SET.has(raw)) return raw;
  const safeFallback = String(fallback || "minimum").trim().toLowerCase();
  return PREFERENCE_SET.has(safeFallback) ? safeFallback : "minimum";
}

export function normalizeUserReasoningPreference(value) {
  // Persist the policy, not its current model-specific result. New/reset
  // profiles choose Lowest available; explicit Off/Low/etc. remain untouched.
  // The leaf adapter resolves this intent only when building a request.
  const normalized = normalizeReasoningPreference(value, "minimum");
  // Provider default remains an internal transport fallback only. Older saved
  // Provider-default/Auto choices migrate to the user-facing Lowest available intent.
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
    options.push("on");
    return options;
  }
  if (control === "levels")
    for (const effort of EFFORTS) if (supported.has(effort)) options.push(effort);
  return options;
}

/** Lowest available is an alias for the first concrete option, never a fixed effort. */
export function minimumReasoningPreference(reasoning) {
  return concreteReasoningPreferences(reasoning)[0] || "default";
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

  // Provider default is deliberately not user-selectable. "minimum" is only
  // an alias for the first concrete capability option.
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
  // Off belongs to the user profile, not capability discovery. Unknown or
  // explicitly non-reasoning models keep Off. Only a model that explicitly
  // requires reasoning may clamp it to its verified minimum at dispatch time.
  if (requested === "off") {
    if (cap.mandatory === true) return minimum !== "default" ? minimum : "default";
    return "off";
  }
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
