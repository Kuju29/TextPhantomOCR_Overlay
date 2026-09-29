import { applyProviderKeyLink } from "../provider-key-links.js";
import { localAiPreset, localProviderWebsite } from "../../shared/ai/providers/local-registry.js";
import { modelVisionSupport } from "../../shared/page-image-policy.js";
import {
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
} from "../../shared/reasoning-preference.js";


import { renderReasoningSelect } from "./reasoning-select.js";

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
  applyPaidMode = null,
}) {
  const toggle = () => {
    toggleDom({ hasEnvKey: false });
    applyPaidMode?.();
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    const local = isLocalProvider(provider);
    applyProviderKeyLink(els.aiKeyGet, local ? "" : provider);
    if (els.aiLocalWebsite) {
      const website = local ? localProviderWebsite(provider) : "";
      els.aiLocalWebsite.href = website || "#";
      els.aiLocalWebsite.hidden = !website;
    }
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
    const preset = local && localAiPreset(provider);
    const runtimeControlsThinking = thinkingUnknown && preset?.protocol === "openai" && !preset.thinking;
    const showAi =
      (els.mode.value || "lens_text") === "lens_text" &&
      (els.sources.value || "") === "ai";
    const profileBlocked = !state.paidActive && Boolean(state.aiProfileBlocked || state.aiModelBlocked);
    const canConfigure =
      local ||
      Boolean((els.aiKey?.value || "").trim());
    if (els.aiThinkingWrap) {
      els.aiThinkingWrap.style.display =
        showAi && canConfigure && !state.paidActive ? "" : "none";
    }
    if (els.aiThinking) {
      // The profile owns the user's reasoning intent. Capability discovery is
      // allowed to describe what the selected model can execute, but it must
      // never rewrite Off/Low/etc. in the control while the popup is open.
      // The leaf adapter resolves unsupported intent at dispatch time.
      renderReasoningSelect(els.aiThinking, reasoning);
      // Capability discovery describes execution, never ownership of the user's
      // saved intent. Keep the control editable even when the selected model has
      // no reasoning support; unsupported selections need a visible error.
      els.aiThinking.disabled = false;
    }
    if (els.aiThinkingHint) {
      const control = String(reasoning?.control || "provider");
      const efforts = Array.isArray(reasoning?.supported_efforts)
        ? reasoning.supported_efforts.join(", ") : "";
      const requested = normalizeUserReasoningPreference(els.aiThinking?.value);
      const executable = reasoningOptionsForCapability(reasoning).some(option => option.value === requested);
      els.aiThinkingHint.textContent = local && provider === "lmstudio" && reasoning?.supported === true && !executable && requested !== "minimum"
        ? `Saved ${requested === "off" ? "Thinking off" : `Thinking ${requested}`}; LM Studio cannot execute this mode with the selected model. Choose Lowest available or a verified mode before translation.`
        : reasoning?.supported === true && !executable && requested !== "minimum"
        ? `Saved ${requested === "off" ? "Thinking off" : `Thinking ${requested}`}; this model cannot verify that exact mode. Translation will report a configuration error instead of silently changing your choice.`
        : reasoning?.supported === false && !["off", "minimum"].includes(requested)
        ? `Saved Thinking ${requested}; this model does not support reasoning. Translation will report a configuration error. Choose Thinking off or Lowest available before translation.`
        : reasoning?.supported === false
        ? "This model has no reasoning support. Execution is Off; your saved selection is kept."
        : local && provider === "ollama" && thinkingUnknown
          ? "Ollama Thinking controls are not verified. Off and Lowest available try to turn thinking off when permitted; translation reports an error if reasoning is returned. Other levels require verified controls."
        : runtimeControlsThinking
          ? "This Local AI adapter cannot verify or set the model's reasoning mode. Lowest available uses the runtime default, which may think; Off requires verified control."
        : local && thinkingUnknown
          ? "Local runtime reasoning control is not verified. Lowest available uses the runtime default, which may think; Off requires verified control."
        : thinkingUnknown
          ? "TextPhantom checks the selected Cloud model before translation. If Lowest available cannot be verified, translation reports a configuration error; Off and named levels also require verified controls."
          : control === "levels"
            ? `Lowest available is TextPhantom's default; the saved policy is kept. Verified levels${efforts ? `: ${efforts}` : ""}.`
            : ["toggle", "boolean"].includes(control)
              ? "Lowest available is TextPhantom's default; the saved policy is kept."
              : "This model exposes no verified lower reasoning control. Your saved choice is kept; dispatch uses the model's required/default behavior when necessary.";
    }
    if (els.aiPageImage) els.aiPageImage.disabled = state.paidActive || visionSupport !== true;
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
  };

  return { toggle, traceProviderTransition, setProviderTransitionPending };
}
