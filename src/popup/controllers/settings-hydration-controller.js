import { normalizeUrl } from "../../shared/url.js";
import { ensureApiDefaults } from "../../shared/api-defaults.js";
import { getStorage, setStorage } from "../../shared/storage.js";
import { effectiveEngineMode } from "../../shared/engine-mode.js";
import {
  localAiPreset,
  normalizeLocalAiAdapter,
} from "../../shared/ai/providers/local-registry.js";
import { sendRuntimeMessage } from "../../shared/messaging.js";
import {
  MODES,
  FALLBACK_LANGS,
  FALLBACK_SOURCES,
  PINNED_LANG_CODES,
  DEFAULT_RELAYOUT_TRANSLATED,
  DEFAULT_RATE_LIMIT_ENABLED,
  DEFAULT_RATE_RPM,
  DEFAULT_RATE_BURST,
} from "../../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  migratePromptMap,
  promptHistoryPush,
} from "../../shared/prompt.js";
import {
  setSelectOptions,
  orderLanguages,
  setModelOptions,
  setEmojiStatus,
  updatePromptCount,
  renderLocalProviderOptions,
  setFieldMessage,
} from "../dom.js";
import {
  providerFromKey,
  defaultEndpointFor,
  isKnownLocalEndpoint,
} from "./provider-model-display.js";

export async function activateAiProfileSafely({
  profileController,
  stored,
  els,
  state,
  writeCompatibility = null,
  showError = null,
}) {
  try {
    const activatedProfile = await profileController.initialize(stored);
    state.aiProfileBlocked = false;
    state.aiProfileErrorCode = "";
    state.desiredAiModel = activatedProfile.model;
    if (els.aiBaseUrl && activatedProfile.endpoint !== undefined)
      els.aiBaseUrl.value = activatedProfile.endpoint;
    if (els.aiKey)
      els.aiKey.value =
        profileController.credentialForCurrent() || els.aiKey.value;
    await writeCompatibility?.();
    return { ready: true, activatedProfile };
  } catch (error) {
    if (!["AI_PROFILE_INVALID", "AI_PROFILE_INCOMPLETE", "AI_PROFILE_MIGRATION_CONFLICT", "AI_PROFILE_MIGRATION_INCOMPLETE"].includes(error?.code))
      throw error;
    state.aiProfileBlocked = true;
    state.aiProfileErrorCode = error.code;
    state.lastAiResolve = null;
    state.lastAiProbe = null;
    profileController.beginRecovery?.(stored);
    const message = error.code === "AI_PROFILE_MIGRATION_CONFLICT"
      ? "✕ Saved AI profiles conflict (AI_PROFILE_MIGRATION_CONFLICT). Open Provider and select/save the intended Provider and Model."
      : ["AI_PROFILE_INCOMPLETE", "AI_PROFILE_MIGRATION_INCOMPLETE"].includes(error.code)
        ? `✕ AI profile is incomplete (${error.code}). Open Provider and select/save a Provider and Model.`
        : "✕ AI profile is invalid (AI_PROFILE_INVALID). Reset or reconfigure Provider and save valid AI settings; no translation was started.";
    showError?.(error.code, message);
    return { ready: false, errorCode: error.code };
  }
}

export async function loadPopupSettings(deps) {
  const {
    els,
    state,
    profileController,
    fontScaleController,
    seriesMemoryController,
    rateSettingsController,
    usageViewController,
    providerMetaController,
    apiHealthController,
    refreshPromptHistoryButtons,
    toggleUi,
    localConnectionController,
    isRemoteDefaultApiUrl,
    canUseAiUi,
    applyPromptForLang,
  } = deps;
  renderLocalProviderOptions();
  setSelectOptions(els.mode, MODES, {
    valueKey: "id",
    labelKey: "name",
    keepValue: els.mode.value,
  });
  setEmojiStatus("loading", "Initializing…");

  const stored = await getStorage([
    "mode",
    "lang",
    "sources",
    "customApiUrl",
    "apiUrlDefault",
    "apiUrlReset",
    "apiDefaultsFetchedAt",
    "aiKey",
    "aiCloudKey",
    "aiModel",
    "aiProvider",
    "aiBaseUrl",
    "localAiAdapter",
    "aiCharMemory",
    "aiMemoryMode",
    "aiSendImage",
    "aiPageImage",
    "aiThinking",
    "aiLocalThinking",
    "aiPromptByLang",
    "fontScale",
    "imgButtonsEnabled",
    "relayoutTranslated",
    "rateLimitEnabled",
    "rateProfile",
    "rateRpm",
    "rateBurst",
    "aiLocalCapacityMode",
    "aiLocalManualConcurrency",
    "aiLocalCapabilitySnapshotsV1",
    "apiLocalUnlimited",
    "engineMode",
    "aiProfilesV1",
    "aiProfileStorageVersion",
    "aiProfileCredentialsV1",
    "aiProfilePromptsV1",
  ]);

  if (els.imgButtonsToggle)
    els.imgButtonsToggle.checked = Boolean(stored.imgButtonsEnabled);
  if (els.apiLocalUnlimited)
    els.apiLocalUnlimited.checked = stored.apiLocalUnlimited !== false;
  // API execution is temporarily unavailable in the extension UI. Keep the
  // stored preference untouched so it can be restored when the option returns.
  if (els.engineMode)
    els.engineMode.value = effectiveEngineMode(stored.engineMode);

  fontScaleController.render(stored.fontScale ?? 1);

  els.mode.value = stored.mode || "lens_text";
  state.desiredLang =
    typeof stored.lang === "string" && stored.lang ? stored.lang : "en";
  state.desiredSources =
    typeof stored.sources === "string" && stored.sources
      ? stored.sources
      : "translated";
  state.desiredAiModel =
    typeof stored.aiModel === "string" && stored.aiModel
      ? stored.aiModel
      : "auto";
  if (els.aiLocalModelId)
    els.aiLocalModelId.value = localConnectionController.savedModel();

  setSelectOptions(
    els.lang,
    orderLanguages(FALLBACK_LANGS, PINNED_LANG_CODES),
    { valueKey: "code", labelKey: "name", keepValue: state.desiredLang },
  );
  setSelectOptions(els.sources, FALLBACK_SOURCES, {
    valueKey: "id",
    labelKey: "name",
    keepValue: state.desiredSources,
  });
  els.lang.value = state.desiredLang;
  els.sources.value = state.desiredSources;

  const storedCustom = String(stored.customApiUrl || "");
  const storedCustomNorm = normalizeUrl(storedCustom);
  const cachedDefaultApiUrl = normalizeUrl(stored.apiUrlDefault || "");
  const cachedResetApiUrl = normalizeUrl(stored.apiUrlReset || "");

  // Hydrate the cached remote-managed API URL before the first paint that uses
  // this field. Reset intentionally keeps customApiUrl empty so future remote
  // changes can still flow through; therefore reopening the popup must render
  // the cached default immediately instead of waiting for ensureApiDefaults()
  // to complete another async round-trip.
  state.apiDefaults = {
    defaultApiUrl: cachedDefaultApiUrl,
    resetApiUrl: cachedResetApiUrl,
    fetchedAt: Number(stored.apiDefaultsFetchedAt) || 0,
  };
  state.lastSavedApiUrl = storedCustomNorm;
  els.apiUrl.value =
    storedCustomNorm || cachedDefaultApiUrl || cachedResetApiUrl || "";
  if (storedCustomNorm) state.userInteractedApi = true;

  // Prompt map (migrate the legacy shape if needed).
  const migration = migratePromptMap(
    stored.aiPromptByLang && typeof stored.aiPromptByLang === "object"
      ? stored.aiPromptByLang
      : {},
  );
  state.aiPromptByLang = migration.map;
  if (migration.changed)
    await setStorage({ aiPromptByLang: state.aiPromptByLang });

  els.aiKey.value = String(stored.aiCloudKey ?? stored.aiKey ?? "");
  // Restore AI provider + local endpoint + translation memory.
  let storedProviderRaw = "";
  let migratedProvider = "";
  let staleLocalDefault = false;
  if (els.aiProvider) {
    storedProviderRaw = String(stored.aiProvider || "")
      .trim()
      .toLowerCase();
    migratedProvider =
      storedProviderRaw && storedProviderRaw !== "auto"
        ? storedProviderRaw
        : "";
    if (!migratedProvider)
      migratedProvider = providerFromKey(String(stored.aiKey || "").trim());
    els.aiProvider.value = migratedProvider;
    state.activeAiProvider = migratedProvider;
    // Compatibility writes are postponed until strict canonical activation
    // succeeds. A corrupt canonical profile must never be silently repaired
    // from rollback keys.
  }
  if (els.aiBaseUrl) {
    const storedProvider = String(els.aiProvider?.value || "");
    const storedBaseUrl = String(stored.aiBaseUrl || "");
    // Drop a local default that an earlier session left behind on a cloud
    // provider: it is invisible here (the endpoint row is local-only) yet it
    // is still sent to /ai/resolve, which then refuses the request.
    staleLocalDefault =
      Boolean(storedProvider) &&
      !defaultEndpointFor(storedProvider) &&
      isKnownLocalEndpoint(storedBaseUrl);
    els.aiBaseUrl.value = staleLocalDefault ? "" : storedBaseUrl;
    if (!els.aiBaseUrl.value)
      els.aiBaseUrl.value = defaultEndpointFor(storedProvider);
  }
  const activation = await activateAiProfileSafely({
    profileController,
    stored,
    els,
    state,
    writeCompatibility: async () => {
    const compatibilityPatch = {};
    if (migratedProvider !== storedProviderRaw)
      compatibilityPatch.aiProvider = migratedProvider;
    if (staleLocalDefault) compatibilityPatch.aiBaseUrl = "";
    if (Object.keys(compatibilityPatch).length)
      await setStorage(compatibilityPatch);
    },
    showError: (_code, message) => {
      setFieldMessage(els.aiProviderWrap, "error", message);
      setEmojiStatus("error", message.replace(/^✕\s*/, ""));
    },
  });
  const aiProfileReady = activation.ready;
  if (aiProfileReady && els.aiLocalAdapter) {
    try {
      const adapter = normalizeLocalAiAdapter(
        stored.localAiAdapter || localAiPreset(els.aiProvider?.value),
        { provider: els.aiProvider?.value },
      );
      els.aiLocalAdapter.value = JSON.stringify(adapter, null, 2);
    } catch {
      els.aiLocalAdapter.value = "";
    }
  }
  void seriesMemoryController.refresh();
  // Reading-direction defaults on; the optional manual rate cap defaults off.
  if (els.relayoutTranslated) {
    els.relayoutTranslated.checked =
      typeof stored.relayoutTranslated === "boolean"
        ? stored.relayoutTranslated
        : DEFAULT_RELAYOUT_TRANSLATED;
  }
  if (els.rateLimitEnabled) {
    els.rateLimitEnabled.checked =
      typeof stored.rateLimitEnabled === "boolean"
        ? stored.rateLimitEnabled
        : DEFAULT_RATE_LIMIT_ENABLED;
  }
  if (els.rateProfile) {
    els.rateProfile.value = [
      "auto",
      "stable",
      "balanced",
      "fast",
      "custom",
    ].includes(stored.rateProfile)
      ? stored.rateProfile
      : stored.rateLimitEnabled === true
        ? "custom"
        : "auto";
  }
  if (els.rateLimitEnabled &&
      (els.rateProfile?.value === "auto" || Number(stored.rateRpm) <= 0)) {
    els.rateLimitEnabled.checked = false;
    if (stored.rateLimitEnabled === true)
      await setStorage({ rateLimitEnabled: false });
  }
  if (els.rateRpm)
    els.rateRpm.value = String(
      Number(stored.rateRpm) > 0 ? stored.rateRpm : DEFAULT_RATE_RPM,
    );
  if (els.rateBurst) {
    els.rateBurst.value = String(
      Number(stored.rateBurst) > 0 ? stored.rateBurst : DEFAULT_RATE_BURST,
    );
  }
  rateSettingsController.renderHint();
  // Storage is the source of truth during first paint. Live verification is
  // advisory and must never erase a saved selection.
  const hydratedModel = aiProfileReady
    ? String(state.desiredAiModel || "").trim()
    : "";
  setModelOptions(hydratedModel && hydratedModel !== "auto" ? [hydratedModel] : [], {
    keepValue: hydratedModel,
    placeholder: "Select a model",
  });
  if (aiProfileReady)
    localConnectionController.restoreSnapshot(stored.aiLocalCapabilitySnapshotsV1);
  // Direct lookup by language, no fallback: shown value == stored value, or empty.
  const activePromptKey = aiProfileReady
    ? profileController.promptKey(state.desiredLang, state.desiredAiModel)
    : "";
  const promptRecord = Object.prototype.hasOwnProperty.call(
    state.aiPromptByLang,
    activePromptKey,
  )
    ? state.aiPromptByLang[activePromptKey]
    : { text: "", mode: "replace" };
  const prompt = String(
    promptRecord && typeof promptRecord === "object"
      ? promptRecord.text || ""
      : promptRecord || "",
  );
  els.aiPrompt.value = prompt;
  updatePromptCount(AI_PROMPT_MAX_CHARS, prompt);
  if (aiProfileReady)
    void promptHistoryPush(activePromptKey, prompt).then(
      refreshPromptHistoryButtons,
    );

  toggleUi();

  await usageViewController.refresh();
  const initialApiUrl = normalizeUrl(els.apiUrl.value);
  if (initialApiUrl) {
    // Read the background snapshot first. Only a stale/missing snapshot needs
    // a live health request, preventing Online -> Checking popup flicker.
    void sendRuntimeMessage({ type: "GET_API_STATUS" }).then((resp) => {
      if (!apiHealthController.acceptSnapshot(resp, initialApiUrl))
        void apiHealthController.check(initialApiUrl);
    });
  }

  // Fill in a default API URL from the remote config if none is set.
  // Also repair older installs where Reset copied the remote URL into
  // customApiUrl; that copied value would otherwise block future remote changes.
  ensureApiDefaults()
    .then(async (d) => {
      state.apiDefaults = d || state.apiDefaults;
      const def = normalizeUrl(state.apiDefaults.defaultApiUrl || "");

      if (storedCustomNorm && isRemoteDefaultApiUrl(storedCustomNorm)) {
        await setStorage({ customApiUrl: "" });
        state.lastSavedApiUrl = "";
        state.userInteractedApi = false;
        els.apiUrl.value = def || storedCustomNorm;
        apiHealthController.check(els.apiUrl.value);
        return;
      }

      if (storedCustomNorm) return;

      // If the cached default was already painted above, a background refresh
      // may still discover that the remote-managed URL changed. Replace only a
      // value that is still one of the cached managed URLs (or empty); never
      // overwrite text the user started typing while the refresh was running.
      if (state.pendingApiSave || state.userInteractedApi) return;
      const current = normalizeUrl(els.apiUrl.value);
      const wasCachedManaged =
        !current ||
        current === cachedDefaultApiUrl ||
        current === cachedResetApiUrl;
      if (def && wasCachedManaged && current !== def) {
        els.apiUrl.value = def;
        apiHealthController.check(def);
      }
    })
    .catch(() => {});

  if (aiProfileReady && canUseAiUi()) {
    applyPromptForLang(state.desiredLang);
    // Local discovery is explicit (Connect button). Cloud metadata is a
    // read-only, cached verification and has one startup owner here.
    if (!localConnectionController.isCurrentProviderLocal())
      providerMetaController.refresh();
  }
}
