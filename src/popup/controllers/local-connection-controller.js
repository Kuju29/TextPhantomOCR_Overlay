import {
  localAiPreset,
  normalizeLocalAiAdapter,
  parseLocalAiAdapterJson,
  serializeLocalAiAdapter,
} from "../../shared/ai/providers/local-registry.js";

export const LOCAL_CAPABILITY_SNAPSHOTS_KEY = "aiLocalCapabilitySnapshotsV1";

export function normalizeLocalConnectionIdentity(provider, endpoint) {
  return `${String(provider || "").trim().toLowerCase()}|${String(endpoint || "")
    .trim().replace(/\/+$/, "")}`;
}

export function savedLocalCapabilitySnapshot(records, provider, endpoint) {
  const key = normalizeLocalConnectionIdentity(provider, endpoint);
  const record = records && typeof records === "object" ? records[key] : null;
  if (!record || record.identity !== key || !record.capability ||
      typeof record.capability !== "object") return null;
  return record;
}

export function createLocalConnectionController({
  els,
  state,
  profile,
  persist,
  getStorage,
  sendMessage,
  normalizeUrl,
  setModelOptions,
  setFieldMessage,
  renderPrompt,
  scheduleSave,
  clearResolveTimer,
  clearCapacity,
  renderCapacity,
  persistCapacity,
  toggleUi,
}) {
  const identity = (
    provider = els.aiProvider?.value,
    endpoint = els.aiBaseUrl?.value,
  ) => normalizeLocalConnectionIdentity(provider, endpoint);

  const persistSnapshot = async ({ provider, endpoint, capability, models, verification = null }) => {
    const stored = await getStorage([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
    const records = stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] &&
      typeof stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] === "object"
      ? stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] : {};
    const key = identity(provider, endpoint);
    await persist({
      [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: {
        ...records,
        [key]: {
          identity: key,
          provider,
          endpoint: String(endpoint || "").trim().replace(/\/+$/, ""),
          models: Array.isArray(models) ? models : [],
          capability,
          verifiedModel: verification?.status === "passed" ? String(verification.model || "").trim() : "",
          verificationStatus: String(verification?.status || "not_tested"),
          checkedAt: Date.now(),
        },
      },
    });
  };

  const forgetSnapshot = async (provider, endpoint) => {
    const stored = await getStorage([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
    const records = stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] &&
      typeof stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] === "object"
      ? { ...stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] } : {};
    delete records[identity(provider, endpoint)];
    await persist({ [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: records });
  };

  const restoreSnapshot = (records) => {
    if (!isCurrentProviderLocal()) return false;
    const provider = String(els.aiProvider?.value || "").trim().toLowerCase();
    const endpoint = String(els.aiBaseUrl?.value || "").trim();
    const record = savedLocalCapabilitySnapshot(records, provider, endpoint);
    if (!record) return false;
    state.localAiCapability = {
      ...record.capability,
      provider,
      baseUrl: endpoint,
      snapshotCheckedAt: Number(record.checkedAt) || 0,
      snapshotSource: "saved",
    };
    const models = Array.isArray(record.models) ? record.models : [];
    const saved = savedModel();
    const savedPresent = Boolean(saved && models.includes(saved));
    const verifiedModel = String(record.verifiedModel || "").trim();
    const verified = Boolean(savedPresent && verifiedModel === saved &&
      String(record.verificationStatus || "") === "passed");
    setModelOptions(models, {
      keepValue: savedPresent ? saved : "",
      placeholder: saved && !savedPresent
        ? "Saved model is unavailable — Connect again"
        : "Select a model",
      selectFirst: !saved,
    });
    state.aiModelBlocked = !verified;
    if (els.aiLocalStatus) {
      const when = Number(record.checkedAt) > 0
        ? new Date(record.checkedAt).toLocaleString() : "an earlier session";
      els.aiLocalStatus.textContent = verified
        ? `✓ ${saved} was verified on ${when}. Reconnect after changing models.`
        : `Saved model metadata from ${when}. Reconnect to verify the selected model.`;
    }
    state.lastAiResolve = {
      provider,
      backend_supported: true,
      key_status: "not_required",
      models_verified: true,
      models,
      verification_source: "saved_snapshot",
      verified_model: verifiedModel,
      checked_at: Number(record.checkedAt) || 0,
    };
    renderCapacity();
    toggleUi();
    return true;
  };

  const savedModel = () => {
    const model = String(state.desiredAiModel || "").trim();
    return model && model.toLowerCase() !== "auto" ? model : "";
  };

  const isCurrentProviderLocal = () =>
    Boolean(localAiPreset(String(els.aiProvider?.value || "").trim().toLowerCase())) ||
    String(els.aiProvider?.value || "").trim().toLowerCase() === "customlocal";

  const setBusy = (busy) => {
    if (els.aiLocalTest) els.aiLocalTest.disabled = Boolean(busy);
  };

  const invalidate = (message) => {
    if (!state.localConnectInFlight) return;
    state.localConnectSeq += 1;
    state.localConnectInFlight = null;
    setBusy(false);
    if (els.aiLocalStatus) els.aiLocalStatus.textContent = message;
  };

  const showFallback = (message) => {
    clearCapacity();
    const saved = savedModel();
    if (els.aiLocalModelId) els.aiLocalModelId.value = saved;
    setModelOptions(saved ? [saved] : [], {
      keepValue: saved,
      placeholder: "No model list loaded — type an exact ID below",
    });
    setFieldMessage(
      els.aiModelWrap,
      "warn",
      saved
        ? `⚠ Model list unavailable. Keeping your saved exact ID: ${saved}`
        : message ||
            "⚠ No model list loaded. Type the exact ID of an installed model.",
    );
  };

  const connect = async () => {
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    clearResolveTimer();
    const sequence = ++state.localConnectSeq;
    let requestIdentity = "";
    try {
      const adapter =
        provider === "customlocal"
          ? parseLocalAiAdapterJson(els.aiLocalAdapter?.value)
          : normalizeLocalAiAdapter(
              {
                ...(localAiPreset(provider) || {}),
                baseUrl: els.aiBaseUrl?.value,
              },
              { provider },
            );
      if (provider === "customlocal" && els.aiBaseUrl)
        els.aiBaseUrl.value = adapter.baseUrl;
      requestIdentity = identity(provider, adapter.baseUrl);
      state.localConnectInFlight = { seq: sequence, identity: requestIdentity };
      setBusy(true);
      els.aiLocalStatus.textContent = "Testing the local server…";
      clearCapacity();
      await persist({
        localAiAdapter: adapter,
        aiBaseUrl: adapter.baseUrl,
      });
      const response = await sendMessage({
        type: "TP_LOCAL_AI_DISCOVER",
        adapter,
        provider,
        model: String(state.desiredAiModel || els.aiModel?.value || savedModel() || "").trim(),
        apiBase: normalizeUrl(els.apiUrl.value),
      });
      if (sequence !== state.localConnectSeq) return;
      if (identity() !== requestIdentity) {
        els.aiLocalStatus.textContent =
          "Connection test cancelled because the Local AI provider or URL changed.";
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
          ? { ...response.capability, provider, baseUrl: adapter.baseUrl }
          : null;
      const saved = savedModel();
      const desired = String(state.desiredAiModel || els.aiModel?.value || saved || "").trim();
      const desiredPresent = Boolean(desired && models.includes(desired));
      setModelOptions(models, {
        keepValue: desiredPresent ? desired : "",
        placeholder: desired && !desiredPresent
          ? "Selected model is unavailable — choose another"
          : "Select a model",
        selectFirst: !desired,
      });
      if (els.aiLocalModelId) els.aiLocalModelId.value = desired;
      const selected = String(els.aiModel?.value || "").trim();
      const verified = verification.status === "passed" &&
        String(verification.model || "").trim() === selected;
      state.aiModelBlocked = !verified;
      if (selected && selected !== state.desiredAiModel) {
        state.desiredAiModel = selected;
        profile.selectModel(selected);
        await renderPrompt(state.desiredLang);
        state.modelDirty = true;
        scheduleSave();
      }
      const verificationMessages = {
        passed: ["info", `✓ ${selected} generated a test response successfully`],
        model_unavailable: ["error", "✕ Selected model is not exposed by this Local AI server"],
        timeout: ["error", "✕ Selected model did not answer the verification request in time"],
        rejected: ["error", "✕ Selected model rejected the verification request"],
        invalid_output: ["error", "✕ Selected model returned no usable text"],
        unreachable: ["error", "✕ Selected model could not complete a generation test"],
        not_tested: ["warn", "⚠ Select a model and Reconnect to verify it"],
      };
      const modelMessage = verificationMessages[verification.status] ||
        ["error", "✕ Selected model could not be verified"];
      setFieldMessage(els.aiModelWrap, ...modelMessage);
      els.aiLocalStatus.textContent = verified
        ? `✓ Connected to ${adapter.baseUrl} · ${selected} verified · ${models.length} installed model(s)`
        : `⚠ Connected to ${adapter.baseUrl}, but the selected model is not verified`;
      renderCapacity();
      toggleUi();
      await persistSnapshot({
        provider,
        endpoint: adapter.baseUrl,
        capability: state.localAiCapability,
        models,
        verification,
      });
      await persistCapacity();
    } catch (error) {
      if (sequence !== state.localConnectSeq) return;
      state.localAiCapability = null;
      await forgetSnapshot(provider, els.aiBaseUrl?.value).catch(() => {});
      els.aiLocalStatus.textContent = `✕ ${error.message}. Check that the runtime is running and allows extension CORS.`;
      showFallback();
    } finally {
      if (state.localConnectInFlight?.seq === sequence) {
        state.localConnectInFlight = null;
        setBusy(false);
      }
    }
  };

  let adapterSaveRevision = 0;
  let adapterSaves = Promise.resolve();
  const saveCustomAdapter = () => {
    const provider = String(els.aiProvider?.value || "").trim().toLowerCase();
    if (provider !== "customlocal") return Promise.resolve();
    const revision = ++adapterSaveRevision;
    const transition = state.providerTransitionRevision;
    const draft = String(els.aiLocalAdapter?.value || "");
    const oldEndpoint = String(els.aiBaseUrl?.value || "");
    const current = () => revision === adapterSaveRevision &&
      transition === state.providerTransitionRevision &&
      String(els.aiProvider?.value || "").trim().toLowerCase() === provider &&
      String(els.aiLocalAdapter?.value || "") === draft &&
      String(els.aiBaseUrl?.value || "") === oldEndpoint;
    // Keep the draft editable, but do not publish its endpoint/capability until
    // the single storage patch succeeds. A newer edit owns its own UI result.
    adapterSaves = adapterSaves.catch(() => {}).then(async () => {
      if (!current()) return;
      try {
        const adapter = parseLocalAiAdapterJson(draft);
        const stored = await getStorage([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
        if (!current()) return;
        const records = { ...(stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] || {}) };
        delete records[identity(provider, oldEndpoint)];
        delete records[identity(provider, adapter.baseUrl)];
        state.aiMetaSeq += 1;
        invalidate("Connection test cancelled because the Custom Local AI adapter changed.");
        await persist({ localAiAdapter: adapter, aiBaseUrl: adapter.baseUrl,
          aiLocalCapabilityHint: null, [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: records });
        if (!current()) return;
        els.aiLocalAdapter.value = serializeLocalAiAdapter(adapter);
        els.aiBaseUrl.value = adapter.baseUrl;
        state.localAiCapability = null;
        clearCapacity();
        setFieldMessage(els.aiEndpointWrap, "info",
          "✓ Custom adapter saved. Connect to verify its models.");
        toggleUi();
      } catch (error) {
        if (current()) setFieldMessage(els.aiEndpointWrap, "error",
          `✕ Not saved: ${error.message}`);
      }
    });
    return adapterSaves;
  };

  const selectExactModel = async () => {
    const model = String(els.aiLocalModelId.value || "").trim();
    if (!model) return;
    state.desiredAiModel = model;
    state.aiModelBlocked = true;
    profile.selectModel(model);
    await renderPrompt(state.desiredLang);
    state.modelDirty = true;
    scheduleSave();
    setFieldMessage(els.aiModelWrap, "warn",
      `⚠ ${model} is not verified. Reconnect before translating.`);
    if (els.aiLocalStatus)
      els.aiLocalStatus.textContent = "Model changed — Reconnect to verify this exact model.";
    renderCapacity();
    toggleUi();
    await persistCapacity();
  };

  const markModelChanged = (model = els.aiModel?.value) => {
    if (!isCurrentProviderLocal()) return;
    const selected = String(model || "").trim();
    state.aiModelBlocked = true;
    if (els.aiLocalStatus)
      els.aiLocalStatus.textContent = "Model changed — Reconnect before translating.";
    setFieldMessage(els.aiModelWrap, "warn",
      selected ? `⚠ ${selected} has not been verified for this connection. Reconnect.`
        : "⚠ Select a model and Reconnect before translating.");
    toggleUi();
  };

  const bind = () => {
    els.aiLocalAdapter?.addEventListener("blur", saveCustomAdapter);
    els.aiLocalTest?.addEventListener("click", connect);
    els.aiLocalModelId?.addEventListener("change", selectExactModel);
  };

  return {
    bind,
    identity,
    invalidate,
    showFallback,
    savedModel,
    isCurrentProviderLocal,
    restoreSnapshot,
    markModelChanged,
  };
}
