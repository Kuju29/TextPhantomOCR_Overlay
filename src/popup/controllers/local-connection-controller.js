import {
  localAiPreset,
  normalizeLocalAiAdapter,
  parseLocalAiAdapterJson,
  serializeLocalAiAdapter,
} from "../../shared/ai/providers/local-registry.js";
import { note } from "../../shared/trace.js";
import {
  LOCAL_CAPABILITY_SNAPSHOTS_KEY,
  LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
  buildLocalVerificationSnapshot,
  localVerificationSnapshotStatus,
  normalizeLocalConnectionIdentity,
  savedLocalCapabilitySnapshot,
} from "../../shared/ai/direct-local/verification-snapshot.js";

export {
  LOCAL_CAPABILITY_SNAPSHOTS_KEY,
  normalizeLocalConnectionIdentity,
  savedLocalCapabilitySnapshot,
};

export function classifyLocalEndpointForTrace(value) {
  const raw = String(value || "").trim();
  if (!raw) return "empty";
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
        host === "0.0.0.0" || host.startsWith("127.")) return "loopback";
    if (host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "private";
    return "public";
  } catch {
    return "invalid";
  }
}

function localConnectionErrorCode(stage, error) {
  if (stage === "normalize") return "INVALID_LOCAL_ADAPTER";
  if (stage === "persist") return "LOCAL_SETTINGS_PERSIST_FAILED";
  if (error?.name === "AbortError") return "LOCAL_CONNECTION_CANCELLED";
  if (stage === "model_verify") return "LOCAL_MODEL_VERIFY_FAILED";
  return "LOCAL_DISCOVERY_FAILED";
}

const THINKING_REQUIRED_HELP =
  "✕ This model requires thinking. Open [AI option > AI thinking] and enable thinking; verification will retry automatically.";

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
  traceLocalConnection = (event) => {
    console.info("[TextPhantom][popup] ai.local_connection", event);
    note("popup/local-connection-controller.js", "localConnection", event);
  },
}) {
  const identity = (
    provider = els.aiProvider?.value,
    endpoint = els.aiBaseUrl?.value,
  ) => normalizeLocalConnectionIdentity(provider, endpoint);

  const persistSnapshot = async ({
    provider, endpoint, capability, models, verification = null, thinking = "off",
  }, current = () => true) => {
    const stored = await getStorage([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
    if (!current()) return;
    const records = stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] &&
      typeof stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] === "object"
      ? stored[LOCAL_CAPABILITY_SNAPSHOTS_KEY] : {};
    const key = identity(provider, endpoint);
    await persist({
      [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: {
        ...records,
        [key]: buildLocalVerificationSnapshot({
          provider, endpoint, capability, models, verification, thinking,
        }),
      },
    });
  };

  const forgetSnapshot = async (provider, endpoint, current = () => true) => {
    const stored = await getStorage([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
    if (!current()) return;
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
    const requestedThinking = els.aiThinking?.value === "on" ? "on" : "off";
    const verification = localVerificationSnapshotStatus(record, {
      provider, endpoint, model: saved, thinking: requestedThinking,
      maxAgeMs: LOCAL_MODEL_VERIFICATION_MAX_AGE_MS,
    });
    const verified = Boolean(savedPresent && verification.fresh);
    setModelOptions(models, {
      keepValue: savedPresent ? saved : "",
      placeholder: saved && !savedPresent
        ? "Saved model is unavailable — refreshing installed models"
        : "Select a model",
      selectFirst: !saved,
    });
    state.aiModelBlocked = !verified;
    if (els.aiLocalStatus) {
      const when = Number(record.checkedAt) > 0
        ? new Date(record.checkedAt).toLocaleString() : "an earlier session";
      els.aiLocalStatus.textContent = verified
        ? `✓ ${saved} was verified on ${when}.`
        : `Saved model metadata from ${when}. Verifying the selected model automatically…`;
    }
    state.lastAiResolve = {
      provider,
      backend_supported: true,
      key_status: "not_required",
      models_verified: verified,
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
    setModelOptions(saved ? [saved] : [], {
      keepValue: saved,
      placeholder: "Local model list is unavailable",
      selectFirst: Boolean(saved),
    });
    setFieldMessage(
      els.aiModelWrap,
      "warn",
      saved
        ? `⚠ Could not refresh installed models. Keeping ${saved} selected but translation stays paused until verification succeeds.`
        : message || "⚠ Could not load installed models from this Local AI runtime.",
    );
  };

  const connect = async () => {
    if (state.localConnectInFlight) return;
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    clearResolveTimer();
    const sequence = ++state.localConnectSeq;
    let requestIdentity = "";
    const requestedModel = String(state.desiredAiModel || els.aiModel?.value || "").trim();
    const requestedThinking = els.aiThinking?.value === "on" ? "on" : "off";
    const adapterDraft = String(els.aiLocalAdapter?.value || "");
    const transitionRevision = state.providerTransitionRevision;
    let expectedModel = requestedModel;
    let expectedModelControl = String(els.aiModel?.value || "").trim();
    const current = () => sequence === state.localConnectSeq &&
      identity() === requestIdentity &&
      String(state.desiredAiModel || els.aiModel?.value || "").trim() === expectedModel &&
      String(els.aiModel?.value || "").trim() === expectedModelControl &&
      (els.aiThinking?.value === "on" ? "on" : "off") === requestedThinking &&
      state.providerTransitionRevision === transitionRevision &&
      (provider !== "customlocal" || String(els.aiLocalAdapter?.value || "") === adapterDraft);
    let stage = "normalize";
    let endpoint = String(els.aiBaseUrl?.value || "").trim();
    const endpointSource = provider === "customlocal" ? "custom_adapter" : "provider_field";
    const milestone = (status, extra = {}) => traceLocalConnection({
      status,
      provider: provider || "unknown",
      endpointClass: classifyLocalEndpointForTrace(endpoint),
      endpointSource,
      transitionRevision: Number(state.providerTransitionRevision) || 0,
      stage,
      ...extra,
    });
    try {
      milestone("started");
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
      endpoint = adapter.baseUrl;
      milestone("completed");
      if (provider === "customlocal" && els.aiBaseUrl)
        els.aiBaseUrl.value = adapter.baseUrl;
      requestIdentity = identity(provider, adapter.baseUrl);
      state.localConnectInFlight = {
        seq: sequence, identity: requestIdentity,
        model: requestedModel, thinking: requestedThinking,
      };
      setBusy(true);
      els.aiLocalStatus.textContent = "Loading and verifying Local AI models…";
      state.aiModelBlocked = true;
      clearCapacity();
      toggleUi();
      stage = "persist";
      milestone("started");
      await persist({
        localAiAdapter: adapter,
        aiBaseUrl: adapter.baseUrl,
      });
      if (!current()) return;
      milestone("completed");
      stage = "message";
      milestone("started");
      stage = "discovery";
      const response = await sendMessage({
        type: "TP_LOCAL_AI_DISCOVER",
        adapter,
        provider,
        model: requestedModel,
        thinking: requestedThinking,
        apiBase: normalizeUrl(els.apiUrl.value),
      });
      if (sequence !== state.localConnectSeq) return;
      if (!current()) {
        els.aiLocalStatus.textContent =
          "Connection test cancelled because the Local AI provider or URL changed, or the selected model or thinking setting changed.";
        return;
      }
      milestone("completed", { ok: Boolean(response?.ok) });
      if (!response?.ok) {
        const failure = new Error(
          response?.error ||
            response?.message ||
            "Local server could not be reached",
        );
        failure.code = String(response?.code || "");
        throw failure;
      }
      const models = Array.isArray(response.models) ? response.models : [];
      const verification = response.selectedModelVerification &&
        typeof response.selectedModelVerification === "object"
        ? response.selectedModelVerification : { model: "", status: "not_tested" };
      stage = "model_verify";
      const verificationStatus = String(verification.status || "not_tested");
      milestone(
        ["passed", "not_tested"].includes(verificationStatus) ? "completed" : "failed",
        {
          verificationStatus,
          modelCount: models.length,
          ...(!["passed", "not_tested"].includes(verificationStatus)
            ? { errorCode: "LOCAL_MODEL_VERIFY_FAILED", errorName: "ModelVerificationError" }
            : {}),
        },
      );
      state.localAiCapability =
        response.capability && typeof response.capability === "object"
          ? { ...response.capability, provider, baseUrl: adapter.baseUrl }
          : null;
      const requested = requestedModel;
      const explicitRequested = requested && requested.toLowerCase() !== "auto"
        ? requested : "";
      const verifiedModel = String(verification.model || "").trim();
      const desired = explicitRequested || verifiedModel;
      const desiredPresent = Boolean(desired && models.includes(desired));
      setModelOptions(models, {
        keepValue: desiredPresent ? desired : "",
        placeholder: explicitRequested && !desiredPresent
          ? "Selected model is unavailable — choose another"
          : "Select a model",
        selectFirst: !desiredPresent,
      });
      const selected = String(els.aiModel?.value || "").trim();
      expectedModelControl = selected;
      const verified = verification.status === "passed" &&
        String(verification.model || "").trim() === selected && models.includes(selected);
      state.aiModelBlocked = !verified;
      if (selected && selected !== state.desiredAiModel) {
        state.desiredAiModel = selected;
        expectedModel = selected;
        profile.selectModel(selected);
        await renderPrompt(state.desiredLang);
        if (!current()) return;
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
        thinking_required: ["error", THINKING_REQUIRED_HELP],
        not_tested: ["warn", "⚠ Select a model; verification will start automatically"],
      };
      const modelMessage = verificationMessages[verification.status] ||
        ["error", "✕ Selected model could not be verified"];
      setFieldMessage(els.aiModelWrap, ...modelMessage);
      els.aiLocalStatus.textContent = verification.status === "thinking_required"
        ? THINKING_REQUIRED_HELP
        : verified
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
        thinking: requestedThinking,
      }, current);
      if (!current()) return;
      await persistCapacity();
    } catch (error) {
      if (sequence !== state.localConnectSeq) return;
      if (requestIdentity && !current()) return;
      milestone("failed", {
        errorCode: localConnectionErrorCode(stage, error),
        errorName: String(error?.name || "Error"),
      });
      state.localAiCapability = null;
      state.aiModelBlocked = true;
      await forgetSnapshot(provider, endpoint,
        () => sequence === state.localConnectSeq && (!requestIdentity || current())).catch(() => {});
      if (requestIdentity && !current()) return;
      els.aiLocalStatus.textContent = error?.code === "local_ai_thinking_required"
        ? THINKING_REQUIRED_HELP
        : `✕ ${error.message}. Check that the runtime is running and allows extension CORS.`;
      showFallback();
      toggleUi();
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
          "✓ Custom adapter saved. Loading and verifying its models automatically…");
        toggleUi();
        if (revision === adapterSaveRevision &&
            transition === state.providerTransitionRevision &&
            String(els.aiProvider?.value || "").trim().toLowerCase() === provider &&
            String(els.aiLocalAdapter?.value || "") === serializeLocalAiAdapter(adapter) &&
            String(els.aiBaseUrl?.value || "") === adapter.baseUrl) {
          await connect();
        }
      } catch (error) {
        if (current()) setFieldMessage(els.aiEndpointWrap, "error",
          `✕ Not saved: ${error.message}`);
      }
    });
    return adapterSaves;
  };

  const markModelChanged = async (model = els.aiModel?.value) => {
    if (!isCurrentProviderLocal()) return;
    const selected = String(model || "").trim();
    invalidate("Selected model changed — restarting verification.");
    state.aiModelBlocked = true;
    if (els.aiLocalStatus)
      els.aiLocalStatus.textContent = selected
        ? `Verifying ${selected}…`
        : "Select an installed model.";
    setFieldMessage(els.aiModelWrap, "info",
      selected ? `⏳ Verifying ${selected} with this Local AI runtime…`
        : "Select an installed model.");
    toggleUi();
    if (selected) await connect();
  };

  const bind = () => {
    els.aiLocalAdapter?.addEventListener("blur", saveCustomAdapter);
    els.aiLocalTest?.addEventListener("click", connect);
  };

  return {
    bind,
    identity,
    invalidate,
    showFallback,
    savedModel,
    isCurrentProviderLocal,
    restoreSnapshot,
    connect,
    markModelChanged,
  };
}
