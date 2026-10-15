import { applyProviderKeyLink } from "../provider-key-links.js";
import { localProviderWebsite } from "../../shared/ai/providers/local-registry.js";
import { modelVisionSupport } from "../../shared/page-image-policy.js";
import {
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
} from "../../shared/reasoning-preference.js";


import { renderThinkingControl } from "./reasoning-select.js";
import { classifyThinkingState } from "../../shared/thinking-state.js";

const THINKING_STATE_HINTS = Object.freeze({
  loading: "AI think options appear after the selected model is checked. Translation waits for them; your saved choice is kept.",
  none: "This model has no AI think. Requests use the provider default; your saved choice is kept for other models.",
  default: "This model does not publish an AI think control. Requests use the provider default; your saved choice is kept for other models.",
});

/**
 * The fresh AI think record for the exact current selection, or null.
 * Paid/Login records come from their verified catalogue rows; Manual Cloud from
 * the live /ai/resolve catalogue for this provider/credential/model; Local from
 * live runtime metadata (a saved snapshot is stale until rechecked).
 */
export function thinkingRecordForSelection({
  paidActive = false, paidSource = "", paidCapabilities = null, paidFresh = false,
  loginCapabilities = null, loginFresh = false,
  local, provider, model, credential = "", resolved = null, resolvedCredential = "",
  localCapability = null, baseUrl = "",
}) {
  if (paidActive) {
    const login = paidSource === "login";
    const fresh = login ? loginFresh === true : paidFresh === true;
    const caps = login ? loginCapabilities : paidCapabilities;
    return { fresh, reasoning: fresh ? caps?.reasoning || null : null };
  }
  if (local) {
    const endpoint = (value) => String(value || "").trim().replace(/\/+$/, "");
    const matches = Boolean(localCapability) &&
      (!localCapability.provider || localCapability.provider === provider) &&
      (!localCapability.baseUrl || endpoint(localCapability.baseUrl) === endpoint(baseUrl));
    const entry = matches && model ? localCapability.models?.[model] : null;
    const fresh = Boolean(entry && typeof entry === "object" && localCapability.snapshotSource !== "saved");
    return { fresh, reasoning: fresh ? entry.reasoning || null : null };
  }
  const reasoning = reasoningCapabilityForSelection({ local, provider, model, credential, resolved, resolvedCredential });
  const sameSelection = String(resolved?.provider || "").trim().toLowerCase() === provider &&
    String(resolved?.model || resolved?.requested_model || "").trim() === model &&
    (!resolvedCredential || resolvedCredential === credential);
  // A live catalogue (models_verified) or a returned reasoning record (resolve
  // catalogue) is this selection's record; an unverified list
  // without one is a failed/late lookup and stays "loading".
  const fresh = Boolean(sameSelection && model &&
    (resolved?.models_verified === true || (reasoning && typeof reasoning === "object")) &&
    resolved?.model_status !== "unavailable" &&
    (!Array.isArray(resolved?.models) || !resolved.models.length || resolved.models.includes(model)));
  return { fresh, reasoning: fresh ? reasoning : null };
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

function visionCapabilityForSelection({
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
    toggleDom();
    applyPaidMode?.();
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    const local = !state.paidActive && isLocalProvider(provider);
    applyProviderKeyLink(els.aiKeyGet, local ? "" : provider);
    if (els.aiLocalWebsite) {
      const website = local ? localProviderWebsite(provider) : "";
      els.aiLocalWebsite.href = website || "#";
      els.aiLocalWebsite.hidden = !website;
    }
    const model = String(els.aiModel?.value || state.desiredAiModel || "").trim();
    const thinkingRecord = thinkingRecordForSelection({
      paidActive: state.paidActive === true,
      paidSource: state.paidTranslationSource,
      paidCapabilities: state.paidModelCapabilities,
      paidFresh: state.paidModelCapabilitiesFresh,
      loginCapabilities: state.loginModelCapabilities,
      loginFresh: state.loginModelCapabilitiesFresh,
      local,
      provider,
      model,
      credential: String(els.aiKey?.value || "").trim(),
      resolved: state.lastAiResolve,
      resolvedCredential: state.lastResolvedKey,
      localCapability: state.localAiCapability,
      baseUrl: els.aiBaseUrl?.value,
    });
    const reasoning = thinkingRecord.reasoning;
    const thinkingState = classifyThinkingState(reasoning, { fresh: thinkingRecord.fresh });
    const vision = state.paidActive ? (state.paidTranslationSource === "login" ? state.loginModelCapabilities : state.paidModelCapabilities)?.vision || null : visionCapabilityForSelection({
      local, provider, model,
      credential: String(els.aiKey?.value || "").trim(),
      resolved: state.lastAiResolve,
      resolvedCredential: state.lastResolvedKey,
      localCapability: state.localAiCapability,
      baseUrl: els.aiBaseUrl?.value,
    });
    const visionSupport = modelVisionSupport({ vision });
    // Login web chats without a verified switch (Gemini web): the website
    // decides and the request carries no thinking field, so the control is the
    // disabled provider-default state, never the saved choice. Only a fresh
    // catalogue row can say so; until then the state stays "loading".
    const websiteThinking = state.paidActive === true && state.paidTranslationSource === "login" &&
      thinkingRecord.fresh === true && reasoning?.app_controlled === false;
    const showAi =
      (els.mode.value || "lens_text") === "lens_text" &&
      (els.sources.value || "") === "ai";
    const canConfigure =
      state.paidActive || local ||
      Boolean((els.aiKey?.value || "").trim());
    if (els.aiThinkingWrap) {
      els.aiThinkingWrap.style.display =
        showAi && canConfigure && !state.paidAccountOpen ? "" : "none";
    }
    if (els.aiThinking) {
      // The profile owns the user's reasoning intent. Capability discovery only
      // decides whether this exact model offers a control (shared/thinking-state.js):
      // controllable → its proven options; none/default → disabled "Provider
      // default"; loading → disabled "Checking model…" until the record arrives.
      // The saved value is never rewritten in any state.
      renderThinkingControl(els.aiThinking, {
        state: websiteThinking ? "default" : thinkingState, reasoning,
      });
    }
    if (els.aiThinkingHint) {
      const requested = normalizeUserReasoningPreference(els.aiThinking?.value);
      const executable = reasoningOptionsForCapability(reasoning).some(option => option.value === requested);
      els.aiThinkingHint.textContent = websiteThinking
        ? "This website chooses its own thinking for this model. TextPhantom cannot change it."
        : thinkingState !== "controllable"
        ? THINKING_STATE_HINTS[thinkingState] || THINKING_STATE_HINTS.loading
        : local && provider === "lmstudio" && !executable && requested !== "minimum"
        ? `Saved ${requested === "off" ? "Thinking off" : `Thinking ${requested}`}; LM Studio cannot execute this mode with the selected model. Choose Lowest available or a verified mode before translation.`
        : !executable && requested !== "minimum"
        ? `Saved ${requested === "off" ? "Thinking off" : `Thinking ${requested}`}; this model cannot verify that exact mode. Translation will report a configuration error instead of silently changing your choice.`
        : "";
    }
    if (els.aiPageImage) els.aiPageImage.disabled = visionSupport !== true && !els.aiPageImage.checked;
    const imageHint = els.aiPageImageWrap?.querySelector?.(".hint");
    if (imageHint) imageHint.textContent = visionSupport === true
      ? els.aiPageImage?.checked
        ? "Images may increase time and cost."
        : "Images may increase time and cost."
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
