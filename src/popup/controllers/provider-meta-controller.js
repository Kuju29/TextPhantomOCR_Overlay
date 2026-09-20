export function createProviderMetaController({
  els,
  state,
  api,
  constants,
  provider,
  profile,
  prompt,
  local,
  usage,
  persist,
  normalizeUrl,
  setModelOptions,
  setFieldMessage,
  setStatus,
  toggleUi,
}) {
  let resolveTimer = null;
  const resolveCache = new Map();
  const resolveInFlight = new Map();
  const probeCache = new Map();
  const probeInFlight = new Map();
  const RESOLVE_TTL_MS = 60_000;
  const PROBE_TTL_MS = 60_000;

  const canUse = () =>
    els.mode.value === "lens_text" &&
    String(els.sources.value || "").trim() === "ai";

  const setModelBlocked = (blocked) => {
    state.aiModelBlocked = Boolean(blocked);
  };

  const probeBlocksModel = (status) => String(status || "") !== "passed";

  // Capture the complete popup context before async work, including a revision
  // so A -> B -> A cannot revive a response started before the intervening edit.
  const selectionSnapshot = () => ({
    apiUrl: normalizeUrl(els.apiUrl?.value || ""),
    provider: String(els.aiProvider?.value || "").trim(),
    endpoint: String(els.aiBaseUrl?.value || "").trim(),
    model: String(els.aiModel?.value || "").trim(),
    credential: String(els.aiKey?.value || "").trim(),
    language: String(els.lang?.value || "en"),
  });
  const selectionMatches = (snapshot) =>
    canUse() && JSON.stringify(snapshot) === JSON.stringify(selectionSnapshot());

  const saveCapabilities = async (capabilities, snapshot, isCurrent) => {
    if (!isCurrent()) return false;
    if (capabilities && typeof capabilities === "object" &&
        !Array.isArray(capabilities) && Object.keys(capabilities).length && snapshot.credential) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot.credential));
      if (!isCurrent()) return false;
      const accountHash = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      await profile.saveModelCapabilities(capabilities, accountHash, {
        provider: snapshot.provider, endpoint: snapshot.endpoint, model: snapshot.model,
      }, isCurrent);
    }
    return isCurrent();
  };

  const renderStatus = () => {
    if (!canUse() || !state.lastAiResolve) return;
    const data = state.lastAiResolve;
    const id = String(data.provider || els.aiProvider?.value || "").trim();
    const name = provider.label(id || "provider");
    const protocol = provider.protocolLabel(data.provider_protocol);
    if (data.configuration_status === "pending") {
      setFieldMessage(els.aiKeyWrap, "warn", "Enter an API key to load account models.");
      setFieldMessage(els.aiModelWrap, "info", "Waiting for provider configuration.");
      return;
    }
    if (data.error === "provider_key_mismatch") {
      setFieldMessage(
        els.aiProviderWrap,
        "error",
        "✕ The API key belongs to a different provider",
      );
      setFieldMessage(
        els.aiModelWrap,
        "error",
        "✕ Model list was not requested",
      );
      return;
    }
    if (data.error === "unsafe_base_url") {
      setFieldMessage(els.aiProviderWrap, "", "");
      setFieldMessage(
        els.aiModelWrap,
        "error",
        "✕ This endpoint requires your own API key",
      );
      return;
    }
    setFieldMessage(
      els.aiProviderWrap,
      data.backend_supported === false ? "error" : "",
      data.backend_supported === false
        ? `✕ ${name} is not implemented by this API build`
        : "",
    );
    if (els.aiKeyWrap?.style.display !== "none") {
      const keyMessages = {
        valid: ["info", `✓ Live ${name} model list loaded`],
        invalid: ["error", `✕ ${name} rejected this API key`],
        forbidden: ["error", `✕ ${name} denied account/model access`],
        missing: ["warn", "⚠ Enter an API key to load account models"],
        unverified: ["warn", `⚠ Could not verify the key with ${name}`],
      };
      const message = keyMessages[data.key_status];
      if (message) setFieldMessage(els.aiKeyWrap, ...message);
    }
    let type = "info";
    let text = "";
    if (data.backend_supported === false)
      [type, text] = ["error", "✕ Backend transport is unavailable"];
    else if (data.key_status === "invalid")
      [type, text] = ["error", `✕ API key rejected • Backend: ${protocol}`];
    else if (data.key_status === "forbidden")
      [type, text] = [
        "error",
        `✕ Account/model access denied • Backend: ${protocol}`,
      ];
    else if (data.models_source === "live" && data.models_verified) {
      const candidates = Array.isArray(data.model_candidates) ? data.model_candidates : [];
      const usable = candidates.filter((item) => item?.eligibility === "usable").length;
      text = `✓ ${usable} compatible model${usable === 1 ? "" : "s"} • Backend: ${protocol}`;
      if (data.model_status === "unavailable")
        [type, text] = [
          "error",
          `✕ Selected model is unavailable • Backend: ${protocol}`,
        ];
    } else {
      [type, text] = [
        "warn",
        `⚠ Live model list unavailable • Backend: ${protocol}`,
      ];
    }
    const probe = state.lastAiProbe;
    const model = String(els.aiModel?.value || "").trim();
    if (
      probe &&
      String(probe.provider || "") === id &&
      String(probe.model || "") === model
    ) {
      const probeMessages = {
        checking: ["info", " • ⏳ Testing selected model…"],
        passed: ["info", " • ✓ Explicit test passed"],
        invalid_key: ["error", " • ✕ Test rejected the API key"],
        billing_required: ["error", " • ✕ Provider credits exhausted or payment required"],
        provider_key_mismatch: ["error", " • ✕ Provider/key mismatch"],
        model_access_denied: ["error", " • ✕ Account cannot use this model"],
        model_unavailable: ["error", " • ✕ Model unavailable"],
        rate_limited: ["warn", " • ⚠ Provider rate-limited the test"],
        rejected: ["error", " • ✕ Provider rejected the test"],
        request_rejected: ["error", " • ✕ Test request rejected; model availability is unverified"],
        provider_error: ["warn", " • ⚠ Provider test failed"],
        probe_busy: ["warn", " • ⚠ Model verification is busy"],
        probe_pending: ["info", " • ⏳ The same model verification is still running"],
        unreachable: ["warn", " • ⚠ Provider could not be reached"],
        probe_failed: ["error", " • ✕ Selected model could not be verified"],
      };
      const result = probeMessages[probe.status];
      if (result) {
        type = result[0];
        text += result[1];
        const reason = String(probe.error_details?.provider_message || probe.error || "").trim();
        if (probe.status !== "passed" && reason) text += ` • ${reason.slice(0, 240)}`;
      }
    }
    setFieldMessage(els.aiModelWrap, type, text);
  };

  // Synchronous UI commit, called only after all awaits and identity checks.
  const applyProbeCapabilities = (result, providerId, model) => {
    const capabilities = result?.model_capabilities;
    const hasCapabilities = capabilities && typeof capabilities === "object" &&
      !Array.isArray(capabilities) && Object.keys(capabilities).length > 0;
    if (hasCapabilities && state.lastAiResolve &&
        String(state.lastAiResolve.provider || "") === String(providerId || "") &&
        String(state.lastAiResolve.model || state.lastAiResolve.requested_model || "") === String(model || "")) {
      state.lastAiResolve = { ...state.lastAiResolve, model_capabilities: capabilities };
    }
    const probeStatus = String(result?.status || "");
    const hardFailure = new Set([
      "rejected", "model_unavailable", "model_access_denied", "invalid_model_output", "unsupported_model",
    ]).has(probeStatus);
    if ((result?.status === "passed" || hardFailure) && Array.isArray(state.lastAiResolve?.model_candidates)) {
      // A deterministic failure changes the strongest generation-health
      // evidence for this exact account/model. Cached resolve data predates that
      // evidence and could otherwise resurrect a just-blocked model for up to
      // RESOLVE_TTL_MS. A successful probe does not need to invalidate the
      // catalogue cache; probeCache will re-apply its richer capabilities.
      if (hardFailure) resolveCache.clear();
      state.lastAiResolve = {
        ...state.lastAiResolve,
        model_candidates: state.lastAiResolve.model_candidates.map((candidate) =>
          candidate?.id === model
            ? { ...candidate,
                eligibility: result?.status === "passed" ? "usable" : "blocked",
                evidence: result?.status === "passed"
                  ? "selected_generation_probe"
                  : `selected_generation_probe_${probeStatus || "rejected"}`,
                ...(capabilities ? { capabilities } : {}) }
            : candidate),
      };
      if (hardFailure && String(els.aiModel?.value || "").trim() === String(model || "")) {
        // A deterministic failure belongs to this exact provider/account/model.
        // Remove it immediately instead of leaving a known-bad choice visible.
        // Do not auto-select/probe the next model: that would turn one user
        // selection into a costly cascade across the catalogue.
        const remaining = state.lastAiResolve.model_candidates.filter((candidate) =>
          candidate && candidate.eligibility === "usable" && String(candidate.id || "").trim());
        setModelOptions(remaining, {
          keepValue: "",
          placeholder: "Selected model failed verification — choose another",
          selectFirst: false,
        });
      }
    }

  };

  const probeSelected = async () => {
    if (!canUse() || provider.isLocal(els.aiProvider?.value)) return;
    const base = normalizeUrl(els.apiUrl.value);
    const resolved = state.lastAiResolve;
    if (!base || !resolved?.backend_supported) return;
    if (
      !["valid", "unverified", "not_required"].includes(
        String(resolved.key_status || ""),
      )
    )
      return;
    const model = String(els.aiModel.value || "").trim();
    if (!model) return;
    const liveModels = Array.isArray(resolved.models) ? resolved.models : [];
    if (resolved.models_verified === true && !liveModels.includes(model)) {
      state.lastAiProbe = {
        provider: String(resolved.provider || els.aiProvider?.value || "").trim(),
        model, status: "model_unavailable", cached: false,
      };
      setModelBlocked(true);
      renderStatus();
      toggleUi();
      return;
    }
    const id = String(resolved.provider || els.aiProvider?.value || "").trim();
    const apiKey = String(els.aiKey.value || "").trim();
    if (!apiKey) { setModelBlocked(true); return; }
    const providerBase = String(els.aiBaseUrl?.value || "").trim();
    const identity = JSON.stringify([base, id, providerBase, apiKey, model]);
    const snapshot = selectionSnapshot();
    const metaRevision = state.aiMetaSeq;
    const sequence = ++state.aiProbeSeq;
    const isCurrent = () => sequence === state.aiProbeSeq &&
      metaRevision === state.aiMetaSeq && selectionMatches(snapshot);
    const cached = probeCache.get(identity);
    state.lastAiProbe = { provider: id, model, status: "checking", cached: false };
    setModelBlocked(true);
    renderStatus();
    toggleUi();
    try {
      let result;
      if (cached && Date.now() - cached.ts < PROBE_TTL_MS) {
        result = { ...cached.data, provider: id, model, cached: true };
      } else {
        let request = probeInFlight.get(identity);
        if (!request) {
          request = api.fetchJson(
            `${base}${constants.paths.AI_PROBE}`,
            { api_key: apiKey, model, provider: id, base_url: providerBase },
            constants.probeTimeout,
          ).then((data) => {
            const answer = data && typeof data.status === "string"
              ? { ...data, provider: id, model, cached: Boolean(data.cached) }
              : { provider: id, model, status: "probe_failed", cached: false };
            if (!["unreachable", "rate_limited", "probe_busy", "probe_pending", "request_rejected", "billing_required"].includes(String(answer.status || "")))
              probeCache.set(identity, { ts: Date.now(), data: answer });
            return answer;
          }).finally(() => {
            if (probeInFlight.get(identity) === request) probeInFlight.delete(identity);
          });
          probeInFlight.set(identity, request);
        }
        result = await request;
      }
      if (!isCurrent()) return;
      if (!await saveCapabilities(result?.model_capabilities, snapshot, isCurrent)) return;
      if (!isCurrent()) return;
      // No awaits from here through gate/render. A hard failure may clear the
      // model picker itself; it must not make an unrelated selection usable.
      state.lastAiProbe = result;
      applyProbeCapabilities(result, id, model);
      setModelBlocked(probeBlocksModel(result.status));
    } catch {
      if (!isCurrent()) return;
      state.lastAiProbe = { provider: id, model, status: "unreachable", cached: false };
      setModelBlocked(true);
    }
    renderStatus();
    toggleUi();
    return state.lastAiProbe;
  };


  const refresh = async () => {
    if (!canUse()) {
      setModelOptions([], { placeholder: "Select model…" });
      state.lastAiResolve = null;
      state.lastAiProbe = null;
      setModelBlocked(false);
      return;
    }
    const sequence = ++state.aiMetaSeq;
    ++state.aiProbeSeq;
    let selection = selectionSnapshot();
    const isCurrent = () => sequence === state.aiMetaSeq && selectionMatches(selection);
    const selectedProvider = String(els.aiProvider?.value || "").trim();
    const selectedBaseUrl = String(els.aiBaseUrl?.value || "").trim();
    if (!selectedProvider) {
      setModelBlocked(true);
      setModelOptions([], { placeholder: "Select a provider first" });
      setFieldMessage(els.aiProviderWrap, "warn", "Select a provider.");
      toggleUi();
      return;
    }
    setFieldMessage(els.aiProviderWrap, "", "");
    if (provider.isLocal(selectedProvider)) {
      // Check availability live; the worker reuses a verified, still-loaded model.
      if (state.localConnectInFlight) return;
      await local.connect();
      return;
    }
    const base = normalizeUrl(els.apiUrl.value);
    if (!base) {
      setModelBlocked(true);
      state.lastAiProbe = null;
      toggleUi();
      return;
    }
    const key = String(els.aiKey.value || "").trim();
    if (!key) {
      state.lastAiResolve = { provider: selectedProvider, key_status: "missing",
        configuration_status: "pending", models_verified: false, models: [], model_candidates: [] };
      state.lastAiProbe = null;
      setModelBlocked(true);
      setModelOptions([], { placeholder: "Enter API key to load models", selectFirst: false });
      renderStatus();
      toggleUi();
      return;
    }
    state.lastAiProbe = null;
    // A previously verified provider/model must never remain usable while a
    // different provider/account/model catalogue is still being refreshed.
    // Only probeSelected() may release this gate after the exact current
    // provider/account/model completes a live generation probe.
    setModelBlocked(true);
    toggleUi();
    setFieldMessage(
      els.aiModelWrap,
      "info",
      "⏳ Loading models for this provider…",
    );
    const currentModel =
      String(els.aiModel.value || "").trim() || state.desiredAiModel || "auto";
    try {
      const body = {
          api_key: key,
          model: currentModel,
          lang: els.lang.value || "en",
          provider: selectedProvider,
          base_url: selectedBaseUrl,
        };
      const identity = JSON.stringify([
        base,
        selectedProvider,
        selectedBaseUrl,
        key,
        body.lang,
        currentModel,
      ]);
      const cached = resolveCache.get(identity);
      let data;
      if (cached && Date.now() - cached.ts < RESOLVE_TTL_MS) data = cached.data;
      else {
        let request = resolveInFlight.get(identity);
        if (!request) {
          request = api.fetchJson(
            `${base}${constants.paths.AI_RESOLVE}`,
            body,
            constants.metaTimeout,
          ).then((result) => {
            resolveCache.set(identity, { ts: Date.now(), data: result });
            return result;
          }).finally(() => {
            if (resolveInFlight.get(identity) === request)
              resolveInFlight.delete(identity);
          });
          resolveInFlight.set(identity, request);
        }
        data = await request;
      }
      if (!isCurrent()) return;
      state.lastAiResolve = data || null;
      const models =
        data?.models_verified && Array.isArray(data.models) ? data.models : [];
      const candidates = data?.models_verified && Array.isArray(data.model_candidates)
        ? data.model_candidates : [];
      const usableCandidates = candidates.filter((candidate) =>
        candidate && typeof candidate === "object" &&
        candidate.eligibility === "usable" && String(candidate.id || "").trim(),
      );
      const usableModels = usableCandidates.map((candidate) => String(candidate.id).trim());
      const selectedCapability =
        data?.model_capabilities && typeof data.model_capabilities === "object"
          ? data.model_capabilities
          : {};
      let preferred =
        (state.modelDirty
          ? String(els.aiModel.value || "").trim()
          : String(state.desiredAiModel || "").trim()) || currentModel;
      const requestedWasAuto = ["", "auto"].includes(String(data?.requested_model || currentModel).toLowerCase());
      if (requestedWasAuto && data?.model) preferred = String(data.model).trim();
      const explicitUnavailable =
        data?.models_verified === true &&
        preferred && !usableModels.includes(preferred) && !requestedWasAuto;
      // The picker is provider-authoritative. Never append a stored/typed model
      // that the current provider/account did not return as compatible.
      setModelOptions(usableCandidates, {
        keepValue: explicitUnavailable ? "" : preferred || String(data?.model || "").trim(),
        placeholder:
          data?.key_status === "missing"
            ? "Enter API key to load models"
            : explicitUnavailable
              ? "Saved model unavailable — choose a verified model"
              : "No compatible models available",
        selectFirst: requestedWasAuto && !explicitUnavailable,
      });
      // Model-list eligibility is not generation verification.
      setModelBlocked(true);
      state.lastResolvedProvider =
        String(data?.provider || "").trim() || state.lastResolvedProvider;
      state.lastResolvedKey = key;
      // Auto model selection above is an intentional synchronous UI update.
      // Subsequent user edits still invalidate this new captured selection.
      selection = selectionSnapshot();
      if (selection.model === String(data?.model || "").trim() &&
          !await saveCapabilities(selectedCapability, selection, isCurrent)) return;
      if (!isCurrent()) return;
      toggleUi();
      renderStatus();
      const selectedNow = String(els.aiModel?.value || "").trim();
      if (selectedNow && usableModels.includes(selectedNow)) await probeSelected();
    } catch {
      if (isCurrent()) {
        state.lastAiResolve = null;
        state.lastAiProbe = null;
        setModelOptions([], { placeholder: "Model list could not be verified" });
        setModelBlocked(true);
        toggleUi();
        setFieldMessage(
          els.aiModelWrap,
          "warn",
          "⚠ Couldn’t verify this provider’s model list. Translation is paused until models can be checked.",
        );
      }
    }
  };

  const schedule = ({ immediate = false } = {}) => {
    clearTimeout(resolveTimer);
    if (immediate) void refresh();
    else resolveTimer = setTimeout(refresh, 350);
  };
  const cancelSchedule = () => clearTimeout(resolveTimer);

  return {
    canUse,
    refresh,
    schedule,
    cancelSchedule,
    probeSelected,
    renderStatus,
  };
}
