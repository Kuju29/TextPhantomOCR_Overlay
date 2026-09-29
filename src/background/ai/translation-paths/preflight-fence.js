// Only deterministic, undispatched model-control failures can stop identical
// outstanding reservations. Never fence a transient provider error or a bad
// translation, and never carry the failure into a newly requested run.
const CONTROL_FAILURES = new Set([
  "ai_thinking_minimum_unavailable", "ai_thinking_off_unavailable",
  "ai_thinking_unavailable", "ai_thinking_level_unavailable",
]);
export function isControlPreflightFailure(error) {
  return error?.requestDispatched === false &&
    Number(error.generationAttempts || error.providerAttempts || 0) === 0 &&
    CONTROL_FAILURES.has(String(error.code || ""));
}
export function controlFenceError(error) {
  return Object.assign(new Error(String(error.message || "The selected model control is unavailable")), {
    code: String(error.code), category: "configuration", stage: "ai_reasoning_preflight",
    status: 409, retryable: false, requestDispatched: false, generationAttempts: 0,
    providerAttempts: 0, configurationFenced: true,
  });
}
