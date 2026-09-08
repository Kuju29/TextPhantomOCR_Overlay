import { applyProviderKeyLink } from "../provider-key-links.js";

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
    const reasoningSupported =
      reasoning?.supported === true || reasoning?.mandatory === true;
    // The popup exposes only a truthful binary control. Models that use
    // provider-specific thinking levels are not shown as On/Off-capable.
    const configurableThinking = reasoningSupported &&
      ["toggle", "boolean"].includes(reasoning?.control);
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
        showAi && canConfigure && configurableThinking ? "" : "none";
    }
    if (els.aiThinking) {
      const mandatory = reasoning?.mandatory === true;
      if (mandatory) els.aiThinking.value = "on";
      else if (els.aiThinking.value !== "on") els.aiThinking.value = "off";
      els.aiThinking.disabled = mandatory;
      for (const option of els.aiThinking.options)
        option.disabled = mandatory && option.value === "off";
    }
    if (els.aiThinkingHint) {
      els.aiThinkingHint.textContent = configurableThinking
        ? (reasoning?.mandatory === true
            ? "This model requires thinking; it cannot be turned off."
            : "Thinking is Off by default. Turn it On only when you want reasoning.")
        : "";
    }
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
