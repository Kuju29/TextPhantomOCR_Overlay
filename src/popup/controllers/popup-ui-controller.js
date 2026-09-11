import { applyProviderKeyLink } from "../provider-key-links.js";
import { modelVisionSupport } from "../../shared/page-image-policy.js";

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
    toggleDom({ hasEnvKey: Boolean(state.metaCache?.has_env_ai_key) });
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
    // The popup exposes Off/On only when both states have a verified native
    // representation. Level-based providers may opt in after the selected-model
    // probe proves `none` plus at least one non-none effort.
    const efforts = Array.isArray(reasoning?.supported_efforts)
      ? reasoning.supported_efforts.map((value) => String(value).toLowerCase())
      : [];
    const verifiedLevelToggle = reasoning?.control === "levels" &&
      efforts.includes("none") && efforts.some((value) => value !== "none");
    const configurableThinking = reasoningSupported &&
      (["toggle", "boolean"].includes(reasoning?.control) || verifiedLevelToggle);
    const thinkingUnknown = reasoning == null || typeof reasoning?.supported !== "boolean";
    const showAi =
      (els.mode.value || "lens_text") === "lens_text" &&
      (els.sources.value || "") === "ai";
    const profileBlocked = Boolean(state.aiProfileBlocked || state.aiModelBlocked);
    const canConfigure =
      local ||
      Boolean((els.aiKey?.value || "").trim()) ||
      Boolean(state.metaCache?.has_env_ai_key);
    if (els.aiThinkingWrap) {
      els.aiThinkingWrap.style.display =
        showAi && canConfigure ? "" : "none";
    }
    if (els.aiThinking) {
      const mandatory = reasoning?.mandatory === true;
      // Capability discovery may disable the control, but it must not turn the
      // user's safe Off selection into provider-managed Auto. Provider
      // boundaries omit the native field when this capability is unverified.
      if (!["off", "on"].includes(els.aiThinking.value))
        els.aiThinking.value = "off";
      els.aiThinking.disabled = !configurableThinking;
      for (const option of els.aiThinking.options)
        option.disabled = !configurableThinking || (mandatory && option.value === "off");
    }
    if (els.aiThinkingHint) {
      els.aiThinkingHint.textContent = configurableThinking
        ? (reasoning?.mandatory === true
            ? "This model requires thinking; it cannot be turned off."
            : verifiedLevelToggle
              ? "Off and On use reasoning levels verified for this selected model."
              : "Thinking is Off by default. Turn it On only when you want reasoning.")
        : thinkingUnknown
          ? "Thinking support is not verified; no native thinking field will be sent."
          : "Thinking is unavailable for this model; no native thinking field will be sent.";
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
