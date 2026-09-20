import { applyProviderKeyLink } from "../provider-key-links.js";
import { modelVisionSupport } from "../../shared/page-image-policy.js";
import {
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
} from "../../shared/reasoning-preference.js";


function replaceReasoningOptions(select, options) {
  const doc = select?.ownerDocument || globalThis.document;
  if (typeof select?.replaceChildren === "function" && typeof doc?.createElement === "function") {
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
    return;
  }
  // Dependency-light test/runtime shims may expose a mutable options array
  // without a browser Document. Real browser selects always take the path above.
  if (Array.isArray(select?.options)) {
    select.options.splice(0, select.options.length,
      ...options.map(({ value, label }) => ({ value, textContent: label })));
  }
}

export function reasoningCapabilityForSelection({
  local,
  provider,
  model,
  credential = "",
  resolved = null,
  resolvedCredential = "",
  localCapability = null,
  baseUrl = "",
}) {
  if (local) {
    const endpoint = (value) => String(value || "").trim().replace(/\/+$/, "");
    if ((localCapability?.provider && localCapability.provider !== provider) ||
      (localCapability?.baseUrl && endpoint(localCapability.baseUrl) !== endpoint(baseUrl))) return null;
    return localCapability?.models?.[model]?.reasoning || null;
  }
  const resolvedProvider = String(resolved?.provider || "").trim().toLowerCase();
  const resolvedModel = String(
    resolved?.model || resolved?.requested_model || "",
  ).trim();
  if (
    resolvedProvider !== provider ||
    resolvedModel !== model ||
    (resolvedCredential && resolvedCredential !== credential)
  )
    return null;
  return resolved?.model_capabilities?.reasoning || null;
}

export function visionCapabilityForSelection({
  local, provider, model, credential = "", resolved = null,
  resolvedCredential = "", localCapability = null, baseUrl = "",
}) {
  if (local) {
    const endpoint = (value) => String(value || "").trim().replace(/\/+$/, "");
    if ((localCapability?.provider && localCapability.provider !== provider) ||
      (localCapability?.baseUrl && endpoint(localCapability.baseUrl) !== endpoint(baseUrl))) return null;
    return localCapability?.models?.[model]?.vision || null;
  }
  if (String(resolved?.provider || "").trim().toLowerCase() !== provider ||
      String(resolved?.model || resolved?.requested_model || "").trim() !== model ||
      (resolvedCredential && resolvedCredential !== credential)) return null;
  return resolved?.model_capabilities?.vision || null;
}

export function createPopupUiController({
  els,
  state,
  isLocalProvider,
  toggleDom,
  updatePromptWarning,
  validateAiKey,
  validateLangSource,
  applyApiAvailabilityGate = null,
}) {
  const toggle = () => {
    toggleDom({ hasEnvKey: false });
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    const local = isLocalProvider(provider);
    applyProviderKeyLink(els.aiKeyGet, local ? "" : provider);
    const model = String(els.aiModel?.value || state.desiredAiModel || "").trim();
    const reasoning = reasoningCapabilityForSelection({
      local,
      provider,
      model,
      credential: String(els.aiKey?.value || "").trim(),
      resolved: state.lastAiResolve,
      resolvedCredential: state.lastResolvedKey,
      localCapability: state.localAiCapability,
      baseUrl: els.aiBaseUrl?.value,
    });
    const vision = visionCapabilityForSelection({
      local, provider, model,
      credential: String(els.aiKey?.value || "").trim(),
      resolved: state.lastAiResolve,
      resolvedCredential: state.lastResolvedKey,
      localCapability: state.localAiCapability,
      baseUrl: els.aiBaseUrl?.value,
    });
    const visionSupport = modelVisionSupport({ vision });
    const reasoningSupported =
      reasoning?.supported === true || reasoning?.mandatory === true;
    const thinkingUnknown = reasoning == null || typeof reasoning?.supported !== "boolean";
    const showAi =
      (els.mode.value || "lens_text") === "lens_text" &&
      (els.sources.value || "") === "ai";
    const profileBlocked = Boolean(state.aiProfileBlocked || state.aiModelBlocked);
    const canConfigure =
      local ||
      Boolean((els.aiKey?.value || "").trim());
    if (els.aiThinkingWrap) {
      els.aiThinkingWrap.style.display =
        showAi && canConfigure ? "" : "none";
    }
    if (els.aiThinking) {
      // The profile owns the user's reasoning intent. Capability discovery is
      // allowed to describe what the selected model can execute, but it must
      // never rewrite Off/Low/etc. in the control while the popup is open.
      // The leaf adapter resolves unsupported intent at dispatch time.
      const requested = normalizeUserReasoningPreference(els.aiThinking.value);
      const options = reasoningOptionsForCapability(reasoning);
      const labels = {
        minimum: "Lowest available", off: "Thinking off", on: "Thinking on",
        minimal: "Thinking minimal", low: "Thinking low", medium: "Thinking medium",
        high: "Thinking high", xhigh: "Thinking xhigh", max: "Thinking max", ultra: "Thinking ultra",
      };
      const requestedVisible = options.some(option => option.value === requested);
      const visibleOptions = options.length ? [...options] : [];
      if (!requestedVisible) visibleOptions.push({
        value: requested,
        label: `${labels[requested] || `Thinking ${requested}`} (saved)`,
      });
      replaceReasoningOptions(els.aiThinking, visibleOptions);
      els.aiThinking.value = requested;
      // Capability discovery describes execution, never ownership of the user's
      // saved intent. Keep the control editable even when the selected model has
      // no reasoning support; in that case Off is simply the effective state.
      els.aiThinking.disabled = false;
    }
    if (els.aiThinkingHint) {
      const control = String(reasoning?.control || "provider");
      const efforts = Array.isArray(reasoning?.supported_efforts)
        ? reasoning.supported_efforts.join(", ") : "";
      const requested = normalizeUserReasoningPreference(els.aiThinking?.value);
      const executable = reasoningOptionsForCapability(reasoning).some(option => option.value === requested);
      els.aiThinkingHint.textContent = reasoning?.supported === true && !executable && requested !== "minimum"
        ? `Saved ${requested === "off" ? "Thinking off" : `Thinking ${requested}`}; this model cannot execute that exact mode, so dispatch uses its lowest verified mode without changing your saved choice.`
        : reasoning?.supported === false
        ? "This model has no reasoning support. Execution is Off; your saved selection is kept."
        : thinkingUnknown
          ? "Reasoning control is not verified yet. Your selected thinking mode is kept; the provider adapter resolves it only when capability is known."
          : control === "levels"
            ? `Lowest available is TextPhantom's default; the saved policy is kept. Verified levels${efforts ? `: ${efforts}` : ""}.`
            : ["toggle", "boolean"].includes(control)
              ? "Lowest available is TextPhantom's default; the saved policy is kept."
              : "This model exposes no verified lower reasoning control. Your saved choice is kept; dispatch uses the model's required/default behavior when necessary.";
    }
    if (els.aiPageImage) els.aiPageImage.disabled = visionSupport !== true;
    const imageHint = els.aiPageImageWrap?.querySelector?.(".hint");
    if (imageHint) imageHint.textContent = visionSupport === true
      ? "The verified model will receive each page image."
      : visionSupport === false
        ? "The selected model does not support page images."
        : "Page images require verified image support for this selected model.";
    updatePromptWarning();
    validateAiKey();
    validateLangSource();
    // A broken profile blocks dispatch, not its own recovery controls.
    if (els.translatePageBtn)
      els.translatePageBtn.disabled =
        state.providerTransitionPending || (profileBlocked && showAi);
    applyApiAvailabilityGate?.();
  };

  const traceProviderTransition = (
    status,
    { provider, revision, local, error } = {},
  ) => {
    console.info("[TextPhantom][popup] ai.provider_transition", {
      status: String(status || "unknown"),
      provider: String(provider || "unknown"),
      runtime: local ? "local" : "cloud",
      revision: Number(revision) || 0,
      ...(error ? { errorType: String(error?.name || "Error") } : {}),
    });
  };

  const setProviderTransitionPending = (pending) => {
    state.providerTransitionPending = Boolean(pending);
    if (els.aiProvider)
      els.aiProvider.disabled = state.providerTransitionPending;
    if (els.translatePageBtn)
      els.translatePageBtn.disabled = state.providerTransitionPending;
  };

  return { toggle, traceProviderTransition, setProviderTransitionPending };
}
