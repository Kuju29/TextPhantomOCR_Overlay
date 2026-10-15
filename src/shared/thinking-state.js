/**
 * One pure classification of a selected model's AI think (reasoning) control.
 *
 * Mirrors api/backend/ai/thinking_state.py exactly; both are checked against
 * scripts/fixtures/thinking-states-10488.json. The input is the normalized
 * model_capabilities.reasoning record for one exact provider/account/model and
 * whether that record is fresh. No model names are interpreted here.
 *
 *   controllable  the record proves at least one selectable control
 *   none          the record proves the model has no reasoning
 *   default       fresh record, but no selectable control is proven
 *   loading       no fresh record yet (not loaded, stale, fetching, failed)
 *
 * "loading" is never "default": a late or failed catalogue lookup must not
 * send a reasoning model without its control.
 */
export const THINKING_STATES = Object.freeze(["controllable", "none", "default", "loading"]);
// claude.ai's effort ids are low/medium/high/xhigh/max (10492 capture); "extra"
// (between xhigh and max, added in .89) stays for saved profiles.
const EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "extra", "max", "ultra"]);

/** Concrete selectable controls, lowest first ("off", "on" or efforts). */
export function thinkingControlOptions(reasoning) {
  const cap = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {};
  if (cap.supported !== true) return [];
  const mandatory = cap.mandatory === true;
  const control = typeof cap.control === "string" ? cap.control : "provider";
  const listed = Array.isArray(cap.supported_efforts);
  const efforts = new Set(listed
    ? cap.supported_efforts.map(value => String(value || "").trim().toLowerCase()) : []);
  const out = [];
  if (!mandatory && (cap.mandatory === false || cap.can_disable === true ||
      control === "toggle" || control === "boolean" || efforts.has("none")))
    out.push("off");
  if (control === "toggle" || control === "boolean") {
    if (!listed || efforts.has("on")) out.push("on");
    return out;
  }
  if (control === "levels")
    for (const effort of EFFORTS) if (efforts.has(effort)) out.push(effort);
  return out;
}

/** Return exactly one of THINKING_STATES for a selected model. */
export function classifyThinkingState(reasoning, { fresh = false } = {}) {
  if (fresh !== true) return "loading";
  const cap = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {};
  if (cap.supported === false && cap.mandatory !== true) return "none";
  if (thinkingControlOptions(cap).length) return "controllable";
  return "default";
}

/** The control is not offered, so the request carries no thinking field. */
export function sendsProviderDefault(state) {
  return state === "none" || state === "default";
}
