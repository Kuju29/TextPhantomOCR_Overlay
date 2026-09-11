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

  const renderStatus = () => {
    if (!canUse() || !state.lastAiResolve) return;
    const data = state.lastAiResolve;
    const id = String(data.provider || els.aiProvider?.value || "").trim();
    const name = provider.label(id || "provider");
    const protocol = provider.protocolLabel(data.provider_protocol);
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
      const count = Array.isArray(data.models) ? data.models.length : 0;
      const candidates = Array.isArray(data.model_candidates) ? data.model_candidates : [];
      const usable = candidates.filter((item) => item?.eligibility === "usable").length;
      const unknown = candidates.filter((item) => item?.eligibility === "unknown").length;
      text = candidates.length
        ? `✓ ${usable} usable${unknown ? ` • ${unknown} require verification` : ""} • Backend: ${protocol}`
        : `✓ ${count} live model${count === 1 ? "" : "s"} reported by ${name} • Backend: ${protocol}`;
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
        provider_key_mismatch: ["error", " • ✕ Provider/key mismatch"],
        model_access_denied: ["error", " • ✕ Account cannot use this model"],
        model_unavailable: ["error", " • ✕ Model unavailable"],
        rate_limited: ["warn", " • ⚠ Provider rate-limited the test"],
        rejected: ["error", " • ✕ Provider rejected the test"],
        unreachable: ["warn", " • ⚠ Provider could not be reached"],
        probe_failed: ["error", " • ✕ Selected model could not be verified"],
      };
      const result = probeMessages[probe.status];
      if (result) {
        type = result[0];
        text += result[1];
      }
    }
    setFieldMessage(els.aiModelWrap, type, text);
  };

  const applyProbeCapabilities = async (result, apiKey, providerId, model) => {
    const capabilities = result?.model_capabilities;
    const hasCapabilities = capabilities && typeof capabilities === "object" &&
      !Array.isArray(capabilities) && Object.keys(capabilities).length > 0;
    if (hasCapabilities && state.lastAiResolve &&
        String(state.lastAiResolve.provider || "") === String(providerId || "") &&
        String(state.lastAiResolve.model || state.lastAiResolve.requested_model || "") === String(model || "")) {
      state.lastAiResolve = { ...state.lastAiResolve, model_capabilities: capabilities };
    }
    if (result?.status === "passed" && Array.isArray(state.lastAiResolve?.model_candidates)) {
      state.lastAiResolve = {
        ...state.lastAiResolve,
        model_candidates: state.lastAiResolve.model_candidates.map((candidate) =>
          candidate?.id === model
            ? { ...candidate, eligibility: "usable", evidence: "selected_generation_probe",
                ...(capabilities ? { capabilities } : {}) }
            : candidate),
      };
    }
    if (hasCapabilities && apiKey) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
      const accountHash = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      await profile.saveModelCapabilities(capabilities, accountHash);
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
    const providerBase = String(els.aiBaseUrl?.value || "").trim();
    const identity = JSON.stringify([base, id, providerBase, apiKey, model]);
    const cached = probeCache.get(identity);
    if (cached && Date.now() - cached.ts < PROBE_TTL_MS) {
      state.lastAiProbe = { ...cached.data, provider: id, model, cached: true };
      await applyProbeCapabilities(state.lastAiProbe, apiKey, id, model);
      setModelBlocked(probeBlocksModel(state.lastAiProbe.status));
      renderStatus();
      toggleUi();
      return state.lastAiProbe;
    }
    const sequence = ++state.aiProbeSeq;
    state.lastAiProbe = { provider: id, model, status: "checking", cached: false };
    setModelBlocked(true);
    renderStatus();
    toggleUi();
    try {
      let request = probeInFlight.get(identity);
      if (!request) {
        request = api.fetchJson(
          `${base}${constants.paths.AI_PROBE}`,
          { api_key: apiKey, model, provider: id, base_url: providerBase },
          constants.probeTimeout,
        ).then((data) => {
          const result = data && typeof data.status === "string"
            ? { ...data, provider: id, model, cached: false }
            : { provider: id, model, status: "probe_failed", cached: false };
          if (!["unreachable", "rate_limited"].includes(String(result.status || "")))
            probeCache.set(identity, { ts: Date.now(), data: result });
          return result;
        }).finally(() => {
          if (probeInFlight.get(identity) === request) probeInFlight.delete(identity);
        });
        probeInFlight.set(identity, request);
      }
      const result = await request;
      if (sequence !== state.aiProbeSeq) return;
      state.lastAiProbe = result;
      await applyProbeCapabilities(result, apiKey, id, model);
      setModelBlocked(probeBlocksModel(result.status));
    } catch {
      if (sequence !== state.aiProbeSeq) return;
      state.lastAiProbe = { provider: id, model, status: "unreachable", cached: false };
      // Catalogue eligibility is not generation health. Keep translation paused
      // until this exact provider/account/model has one successful tiny probe.
      setModelBlocked(true);
    }
    renderStatus();
    toggleUi();
    return state.lastAiProbe;
  };

  const discoverLocal = async (selectedProvider, selectedBaseUrl, sequence) => {
    if (state.localConnectInFlight) return;
    const explicitAtStart = state.localConnectSeq;
    try {
      const stored = await api.getStorage(["localAiAdapter"]);
      const source =
        selectedProvider === "customlocal"
          ? stored.localAiAdapter
          : {
              ...(api.localPreset(selectedProvider) || {}),
              baseUrl: selectedBaseUrl,
            };
      const adapter = api.normalizeLocalAdapter(source, {
        provider: selectedProvider,
      });
      const discoveryId = crypto.randomUUID();
      const response = await api.sendMessage({
        type: "TP_LOCAL_AI_DISCOVER",
        adapter,
        provider: selectedProvider,
        model: String(els.aiModel?.value || state.desiredAiModel || "").trim(),
        discoveryId,
        apiBase: normalizeUrl(els.apiUrl.value),
      });
      if (
        sequence !== state.aiMetaSeq ||
        explicitAtStart !== state.localConnectSeq
      ) {
        void api.sendMessage({
          type: "TP_LOCAL_AI_DISCOVERY_STALE",
          discoveryId,
          provider: selectedProvider,
        });
        return;
      }
      if (!response?.ok)
        throw new Error(
          response?.error ||
            response?.message ||
            "Local server could not be reached",
        );
      const models = Array.isArray(response.models) ? response.models : [];
      const verification = response.selectedModelVerification &&
        typeof response.selectedModelVerification === "object"
        ? response.selectedModelVerification : { model: "", status: "not_tested" };
      state.localAiCapability =
        response.capability && typeof response.capability === "object"
          ? { ...response.capability, provider: selectedProvider, baseUrl: adapter.baseUrl }
          : null;
      const saved = local.savedModel();
      const savedMissing = Boolean(saved && !models.includes(saved));
      setModelOptions(models, {
        keepValue: savedMissing ? "" : (els.aiModel.value || state.desiredAiModel),
        placeholder: savedMissing
          ? "Saved model is not installed — choose a model"
          : "Select a model",
        selectFirst: !savedMissing,
      });
      const selected = String(els.aiModel?.value || "").trim();
      const verified = verification.status === "passed" &&
        String(verification.model || "").trim() === selected;
      setModelBlocked(savedMissing || models.length === 0 || !verified);
      if (selected && selected !== state.desiredAiModel) {
        state.desiredAiModel = selected;
        profile.selectModel(selected);
        await prompt.render(state.desiredLang);
        state.modelDirty = true;
        prompt.scheduleSave();
      }
      state.lastAiResolve = {
        provider: selectedProvider,
        backend_supported: true,
        key_status: "not_required",
        models_verified: true,
        models,
      };
      const thinkingRequired = verification.status === "thinking_required" ||
        verification.code === "local_ai_thinking_required";
      setFieldMessage(
        els.aiModelWrap,
        verified ? "info" : thinkingRequired ? "error" : "warn",
        thinkingRequired
          ? "✕ This model requires thinking. Open [AI option > AI thinking], enable thinking, then Connect again."
          : verified
          ? `✓ ${selected} verified · ${models.length} installed model(s)`
          : `⚠ ${models.length} installed model(s) found; Reconnect to verify the selected model`,
      );
      if (els.aiLocalStatus)
        els.aiLocalStatus.textContent = thinkingRequired
          ? "✕ This model requires thinking. Open [AI option > AI thinking], enable thinking, then Connect again."
          : `✓ Connected directly to ${adapter.baseUrl}`;
      local.renderCapacity();
      await local.persistCapacity();
      toggleUi();
    } catch (error) {
      if (
        sequence === state.aiMetaSeq &&
        explicitAtStart === state.localConnectSeq
      ) {
        state.lastAiResolve = null;
        setModelBlocked(true);
        if (els.aiLocalStatus)
          els.aiLocalStatus.textContent = `✕ ${error.message}. Start the runtime and connect again.`;
        local.showFallback();
        toggleUi();
      }
    }
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
      const snapshot = state.lastAiResolve;
      if (
        snapshot?.models_verified === true &&
        String(snapshot.provider || "") === selectedProvider
      ) return;
      // Opening/changing ordinary UI must not contact a local runtime. The
      // explicit Connect action owns discovery and its terminal status.
      local.showFallback();
      return;
    }
    const base = normalizeUrl(els.apiUrl.value);
    if (!base) {
      setModelBlocked(true);
      state.lastAiProbe = null;
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
    const key = String(els.aiKey.value || "").trim();
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
      if (sequence !== state.aiMetaSeq) return;
      state.lastAiResolve = data || null;
      const models =
        data?.models_verified && Array.isArray(data.models) ? data.models : [];
      const candidates = data?.models_verified && Array.isArray(data.model_candidates)
        ? data.model_candidates : models;
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
        preferred && !models.includes(preferred) && !requestedWasAuto;
      // The picker is provider-authoritative. Never append a stored/typed model
      // that the current provider/account did not return as compatible.
      setModelOptions(candidates, {
        keepValue: explicitUnavailable ? "" : preferred || String(data?.model || "").trim(),
        placeholder:
          data?.key_status === "missing"
            ? "Enter API key to load models"
            : explicitUnavailable
              ? "Saved model unavailable — choose a verified model"
              : "No compatible models available",
        selectFirst: requestedWasAuto && !explicitUnavailable,
      });
      const resolveBlocked = data?.ok === false && [
        "provider_key_mismatch", "invalid_api_key", "provider_access_forbidden",
        "model_unavailable", "unsupported_provider",
      ].includes(String(data?.error || ""));
      setModelBlocked(resolveBlocked || explicitUnavailable ||
        (data?.models_verified === true && models.length === 0));
      state.lastResolvedProvider =
        String(data?.provider || "").trim() || state.lastResolvedProvider;
      state.lastResolvedKey = key;
      if (Object.keys(selectedCapability).length && key) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
        const accountHash = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
          byte.toString(16).padStart(2, "0")).join("");
        if (sequence !== state.aiMetaSeq) return;
        await profile.saveModelCapabilities(selectedCapability, accountHash);
      }
      toggleUi();
      renderStatus();
      const selectedNow = String(els.aiModel?.value || "").trim();
      if (selectedNow && models.includes(selectedNow)) await probeSelected();
    } catch {
      if (sequence === state.aiMetaSeq) {
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
