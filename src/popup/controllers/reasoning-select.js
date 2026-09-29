import {
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
} from "../../shared/reasoning-preference.js";

const LABELS = {
  minimum: "Lowest available", off: "Thinking off", on: "Thinking on",
  minimal: "Thinking minimal", low: "Thinking low", medium: "Thinking medium",
  high: "Thinking high", xhigh: "Thinking xhigh", max: "Thinking max", ultra: "Thinking ultra",
};

/** Render capability choices without letting a native <select> erase saved intent. */
export function renderReasoningSelect(select, capability, value = select?.value) {
  if (!select) return;
  const requested = normalizeUserReasoningPreference(value);
  const options = [...reasoningOptionsForCapability(capability)];
  if (!options.some(option => option.value === requested)) options.push({
    value: requested, label: `${LABELS[requested] || `Thinking ${requested}`} (saved)`,
  });
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
