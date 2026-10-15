import {
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
} from "../../shared/reasoning-preference.js";

const LABELS = {
  minimum: "Lowest available", off: "Thinking off", on: "Thinking on",
  minimal: "Thinking minimal", low: "Thinking low", medium: "Thinking medium",
  high: "Thinking high", xhigh: "Thinking xhigh", extra: "Thinking extra", max: "Thinking max", ultra: "Thinking ultra",
};

// AI think states without a selectable control. The single option keeps
// the saved preference as its value, so every reader of the select (profile
// writes, Local checks) still sees the user's choice while the label says what
// the request will do.
export const THINKING_STATE_LABELS = Object.freeze({
  none: "Provider default (this model has no AI think)",
  default: "Provider default — this model's AI think cannot be set",
  loading: "Checking model…",
});

// The last state applied by the popup controller for each select. A profile
// render only supplies the saved value; it must not bring back an older
// catalogue's options over the current selection's state.
const views = new WeakMap();

function fill(select, options, requested) {
  const doc = select.ownerDocument || globalThis.document;
  if (typeof select.replaceChildren === "function" && typeof doc?.createElement === "function") {
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
  } else if (Array.isArray(select.options)) {
    select.options.splice(0, select.options.length,
      ...options.map(({ value, label }) => ({ value, textContent: label })));
  }
  select.value = requested;
}

/** Render capability choices without letting a native <select> erase saved intent. */
function renderReasoningSelect(select, capability, value = select?.value) {
  if (!select) return;
  const requested = normalizeUserReasoningPreference(value);
  const options = [...reasoningOptionsForCapability(capability)];
  if (!options.some(option => option.value === requested)) options.push({
    value: requested, label: `${LABELS[requested] || `Thinking ${requested}`} (saved)`,
  });
  fill(select, options, requested);
}

/** Render one classified AI think state (see shared/thinking-state.js). */
export function renderThinkingControl(select, { state, reasoning = null, value = select?.value } = {}) {
  if (!select) return;
  views.set(select, { state, reasoning });
  if (state === "controllable") {
    renderReasoningSelect(select, reasoning, value);
    select.disabled = false;
    if (select.dataset) select.dataset.thinkingState = "controllable";
    return;
  }
  const requested = normalizeUserReasoningPreference(value);
  const label = THINKING_STATE_LABELS[state] || THINKING_STATE_LABELS.loading;
  fill(select, [{ value: requested, label }], requested);
  select.disabled = true;
  if (select.dataset) select.dataset.thinkingState = THINKING_STATE_LABELS[state] ? state : "loading";
}

/** Apply a saved preference within the select's current AI think state. */
export function setThinkingPreference(select, value) {
  if (!select) return;
  const view = views.get(select) || { state: "loading", reasoning: null };
  renderThinkingControl(select, { ...view, value });
}
