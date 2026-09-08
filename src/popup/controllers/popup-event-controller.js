import { normalizeUrl } from "../../shared/url.js";
import { ensureApiDefaults } from "../../shared/api-defaults.js";
import { getStorage, setStorage } from "../../shared/storage.js";
import { effectiveEngineMode } from "../../shared/engine-mode.js";
import {
  AI_USAGE_STORAGE_KEY,
  persistUsageReset,
} from "../../shared/ai-usage.js";
import {
  localAiPreset,
  normalizeLocalAiAdapter,
} from "../../shared/ai/providers/local-registry.js";
import { createTab, queryTabs } from "../../shared/browser-api.js";
import { broadcast, sendRuntimeMessage } from "../../shared/messaging.js";
import { isLocalAiProvider } from "../../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  normalizeAiModel,
  normalizePrompt,
  promptHistoryBack,
  promptHistoryForward,
} from "../../shared/prompt.js";
import {
  defaultEndpointFor,
  isKnownLocalEndpoint,
} from "./provider-model-display.js";

export function bindPopupEvents(deps) {
  const {
    els,
    state,
    profileController,
    profilePagehideFlush,
    usageController,
    providerMetaController,
    localConnectionController,
    apiHealthController,
    applyPromptForLang,
    applyPromptHistoryResult,
    refreshPromptHistoryButtons,
    resetPromptForLang,
    updateAiPromptWarning,
    updateAiPromptModeHint,
    updatePromptCount,
    fieldMessageType,
    setFieldMessage,
    setEmojiStatus,
    setModelOptions,
    toggleUi,
    canUseAiUi,
    validateAiKey,
    ensureAiAvailableOrFallback,
    flushPromptForLang,
    flushPendingAiEditsForSwitch,
    scheduleSaveApi,
    scheduleSaveAi,
    selectedUsageTarget,
    renderLocalCapacityHint,
    persistSelectedLocalCapacityHint,
    clearLocalCapacitySnapshot,
    rateSettingsController,
    renderAiUsage,
    refreshSeriesMemory,
    openAiUsageHistory,
    closeAiUsageHistory,
    isRemoteDefaultApiUrl,
    traceProviderTransition,
    setProviderTransitionPending,
  } = deps;
  let endpointTimer = null;
  els.aiPromptReset?.addEventListener("click", () =>
    resetPromptForLang(els.lang.value),
  );

  // Expand / collapse the style editor for comfortable long-prompt editing.
  els.aiPromptStudio?.addEventListener("click", () => {
    const lang = encodeURIComponent(els.lang.value || "en");
    const model = encodeURIComponent(
      state.desiredAiModel || els.aiModel?.value || "auto",
    );
    const identity = encodeURIComponent(
      profileController.currentProviderIdentity(),
    );
    chrome.tabs?.create?.({
      url: chrome.runtime.getURL(
        `prompt/prompt.html?lang=${lang}&model=${model}&identity=${identity}`,
      ),
    });
  });

  els.aiPromptExpand?.addEventListener("click", () => {
    const ta = els.aiPrompt;
    if (!ta) return;
    const expanded = ta.classList.toggle("expanded");
    els.aiPromptExpand.setAttribute(
      "aria-pressed",
      expanded ? "true" : "false",
    );
    els.aiPromptExpand.title = expanded ? "Collapse editor" : "Expand editor";
    els.aiPromptExpand.textContent = expanded ? "⤡" : "⤢";
    if (expanded) ta.focus();
  });

  els.mode.addEventListener("change", async () => {
    await setStorage({ mode: els.mode.value });
    state.modelDirty = false;
    toggleUi();
    await applyPromptForLang(state.desiredLang);
    providerMetaController.refresh();
  });

  els.lang.addEventListener("change", async () => {
    const prevLang = state.desiredLang;
    state.desiredLang = els.lang.value || state.desiredLang;
    if (canUseAiUi()) await flushPromptForLang(prevLang, state.desiredAiModel);
    await setStorage({ lang: state.desiredLang });
    state.modelDirty = false;
    await applyPromptForLang(state.desiredLang);
    toggleUi();
    providerMetaController.refresh();
  });

  els.sources.addEventListener("change", async () => {
    if (canUseAiUi())
      await flushPromptForLang(state.desiredLang, state.desiredAiModel);
    state.modelDirty = false;
    const ok = ensureAiAvailableOrFallback();
    state.desiredSources = els.sources.value || state.desiredSources;
    await setStorage({ sources: state.desiredSources });
    toggleUi();
    if (ok) await applyPromptForLang(state.desiredLang);
    providerMetaController.refresh();
    broadcast({ type: "AI_SETTINGS_CHANGED" });
  });

  els.apiUrl.addEventListener("input", (e) => {
    state.lastApiOk = false;
    state.healthSeq += 1;
    setEmojiStatus("loading", "Not checked for this URL yet");
    scheduleSaveApi(e.target.value);
    // The local-API switch appears as soon as the URL becomes a local one.
    toggleUi();
  });
  els.apiUrl.addEventListener("blur", (e) => scheduleSaveApi(e.target.value));

  els.aiKey.addEventListener("input", () => {
    state.pendingCredentialSave = true;
    state.modelDirty = false;
    state.lastAiResolve = null;
    state.lastAiProbe = null;
    validateAiKey();
    scheduleSaveAi();
    providerMetaController.schedule();
  });
  els.aiKey.addEventListener("blur", () => {
    validateAiKey();
    scheduleSaveAi();
    providerMetaController.schedule({ immediate: true });
  });

  els.aiProvider?.addEventListener("change", async () => {
    const provider = (els.aiProvider.value || "").trim();
    const local = isLocalAiProvider(provider);
    const revision = ++state.providerTransitionRevision;
    const previous = {
      provider: state.activeAiProvider,
      endpoint: String(els.aiBaseUrl?.value || ""),
      model: String(state.desiredAiModel || "auto"),
    };
    const pendingEdits = flushPendingAiEditsForSwitch(
      state.desiredLang,
      state.desiredAiModel,
    );
    setProviderTransitionPending(true);
    setFieldMessage(els.aiProviderWrap, "", "");
    const usageTarget = {
      runtime: local ? "local" : "cloud",
      provider: provider || "unknown",
      model: "auto",
    };
    // Invalidate old-provider discovery and debounced writes before the first
    // await. A slow Ollama reply must never repopulate the Model UI after the
    // user has already switched to LM Studio (or another provider).
    state.aiMetaSeq += 1;
    localConnectionController.invalidate(
      "Connection test cancelled because the Local AI provider changed.",
    );
    providerMetaController.cancelSchedule();
    clearTimeout(endpointTimer);
    state.pendingAiSave = false;
    state.pendingCredentialSave = false;
    clearLocalCapacitySnapshot({ persist: false });
    const previousProvider = state.activeAiProvider;
    state.activeAiProvider = provider;
    state.lastAiResolve = null;
    state.lastAiProbe = null;
    if (els.aiLocalStatus)
      els.aiLocalStatus.textContent = local
        ? "Not connected for this provider yet. Click Connect & load models."
        : "Local AI is not selected.";
    if (provider !== previousProvider) {
      // A model ID belongs to its runtime/provider. Never carry a Gemini model
      // into Ollama (or an Ollama ID into LM Studio) merely because the provider
      // selector changed.
      state.desiredAiModel = "auto";
      state.modelDirty = false;
      if (els.aiLocalModelId) els.aiLocalModelId.value = "";
      setModelOptions([], {
        placeholder: local ? "Connect to load models" : "Loading models…",
      });
    }
    // Pre-fill the local endpoint when a local provider is picked and the field
    // is empty (or still holds another provider's default).
    const def = defaultEndpointFor(provider);
    if (els.aiBaseUrl) {
      const cur = (els.aiBaseUrl.value || "").trim();
      const isAnyDefault = isKnownLocalEndpoint(cur);
      if (def) {
        if (!cur || isAnyDefault) els.aiBaseUrl.value = def;
      } else if (isAnyDefault && provider) {
        // Switching to a CLOUD provider: a local default left in the (now
        // hidden) endpoint field is still sent to /ai/resolve, where it reads as
        // "send this provider's key to localhost" and the request is refused.
        // Only a value this popup filled in is cleared; a URL the user typed
        // themselves is theirs to keep.
        els.aiBaseUrl.value = "";
      }
    }
    const preset = localAiPreset(provider);
    if (els.aiLocalAdapter && preset)
      els.aiLocalAdapter.value = JSON.stringify(preset, null, 2);
    // Render the selected Provider + Model profile before any persistence or
    // network work. This prevents a slow discovery reply from showing options
    // belonging to the previous provider.
    // Provider-dependent controls must match the dropdown before the first
    // asynchronous storage operation. This also removes stale Local controls
    // immediately when switching Ollama -> OpenRouter.
    toggleUi();
    traceProviderTransition("pending", { provider, revision, local });
    let transition = null;
    try {
      const flushed = await pendingEdits;
      if (flushed?.ok === false)
        throw flushed.error || new Error("Pending AI settings were not saved");
      transition = profileController.beginProviderTransition(
        provider,
        (els.aiBaseUrl?.value || "").trim(),
      );
      const selectedProfile = transition.selected;
      if (els.aiBaseUrl) els.aiBaseUrl.value = selectedProfile.endpoint;
      state.desiredAiModel = selectedProfile.model;
      setModelOptions([], {
        keepValue: selectedProfile.model,
        placeholder: local ? "Connect to load models" : "Loading models…",
      });
      els.aiKey.value = profileController.credentialForCurrent();
      updatePromptCount(AI_PROMPT_MAX_CHARS, els.aiPrompt.value);
      await transition.commit({
        aiLocalCapabilityHint: null,
        ...(preset ? { localAiAdapter: preset } : {}),
      });
      if (
        revision !== state.providerTransitionRevision ||
        String(els.aiProvider.value || "").trim() !== provider
      )
        return;
      state.activeAiProvider = provider;
      await applyPromptForLang(state.desiredLang);
      if (local) {
        const storedSnapshots = await getStorage(["aiLocalCapabilitySnapshotsV1"]);
        localConnectionController.restoreSnapshot(
          storedSnapshots.aiLocalCapabilitySnapshotsV1,
        );
      }
      void usageController.select(
        { ...usageTarget, reason: "provider_switch" },
        () => selectedUsageTarget("auto"),
      );
      traceProviderTransition("committed", { provider, revision, local });
      rateSettingsController.renderHint();
      validateAiKey();
      providerMetaController.schedule({ immediate: true });
    } catch (error) {
      if (revision !== state.providerTransitionRevision) return;
      transition?.rollback();
      els.aiProvider.value = previous.provider;
      if (els.aiBaseUrl) els.aiBaseUrl.value = previous.endpoint;
      state.desiredAiModel = previous.model;
      state.activeAiProvider = previous.provider;
      profileController.selectProvider(previous.provider, previous.endpoint);
      setModelOptions([], {
        keepValue: previous.model,
        placeholder: isLocalAiProvider(previous.provider)
          ? "Connect to load models"
          : "Loading models…",
      });
      els.aiKey.value = profileController.credentialForCurrent();
      toggleUi();
      setFieldMessage(
        els.aiProviderWrap,
        "error",
        "Provider change was not saved. Previous provider restored.",
      );
      traceProviderTransition("rolled_back", {
        provider,
        revision,
        local,
        error,
      });
    } finally {
      if (revision === state.providerTransitionRevision)
        setProviderTransitionPending(false);
    }
  });

  els.aiBaseUrl?.addEventListener("input", () => {
    state.aiMetaSeq += 1;
    localConnectionController.invalidate(
      "Connection test cancelled because the Local AI URL changed.",
    );
    clearLocalCapacitySnapshot();
    state.lastAiResolve = null;
    state.lastAiProbe = null;
    if (els.aiLocalStatus)
      els.aiLocalStatus.textContent =
        "URL changed — connection status cleared. Click Connect & load models.";
    clearTimeout(endpointTimer);
    endpointTimer = setTimeout(async () => {
      const baseUrl = (els.aiBaseUrl.value || "").trim();
      const provider = String(els.aiProvider?.value || "").trim();
      let adapter = null;
      if (provider !== "customlocal") {
        try {
          adapter = normalizeLocalAiAdapter(
            { ...(localAiPreset(provider) || {}), baseUrl },
            { provider },
          );
        } catch {
          /* incomplete input is stored, then reported by preflight/test */
        }
      }
      const bound = profileController.bindConnection({
        provider,
        endpoint: baseUrl,
      });
      els.aiKey.value = bound.credential;
      await profileController.saveConnection({ provider, endpoint: baseUrl });
      await setStorage({
        aiLocalCapabilityHint: null,
        ...(adapter ? { localAiAdapter: adapter } : {}),
      });
      providerMetaController.schedule();
    }, 400);
  });
  els.aiBaseUrl?.addEventListener("blur", async () => {
    state.aiMetaSeq += 1;
    clearLocalCapacitySnapshot();
    const baseUrl = (els.aiBaseUrl.value || "").trim();
    const provider = String(els.aiProvider?.value || "").trim();
    let adapter = null;
    try {
      adapter = normalizeLocalAiAdapter(
        { ...(localAiPreset(provider) || {}), baseUrl },
        { provider },
      );
    } catch {
      /* shown by connection test */
    }
    const bound = profileController.bindConnection({
      provider,
      endpoint: baseUrl,
    });
    els.aiKey.value = bound.credential;
    await profileController.saveConnection({ provider, endpoint: baseUrl });
    await setStorage({
      aiLocalCapabilityHint: null,
      ...(adapter ? { localAiAdapter: adapter } : {}),
    });
    if (isLocalAiProvider(provider)) {
      const storedSnapshots = await getStorage(["aiLocalCapabilitySnapshotsV1"]);
      localConnectionController.restoreSnapshot(
        storedSnapshots.aiLocalCapabilitySnapshotsV1,
      );
    }
    providerMetaController.schedule({ immediate: true });
  });

  els.aiPageImage?.addEventListener("change", async () => {
    await profileController.saveProfile({
      pageImage: els.aiPageImage.checked ? "always" : "off",
    });
  });

  // Reading direction + rate limit

  els.relayoutTranslated?.addEventListener("change", async () => {
    await setStorage({
      relayoutTranslated: Boolean(els.relayoutTranslated.checked),
    });
  });

  els.engineMode?.addEventListener("change", async () => {
    // Reject synthetic/programmatic selection too, without overwriting a saved
    // API preference while the option is temporarily unavailable.
    els.engineMode.value = effectiveEngineMode(els.engineMode.value);
  });

  els.aiLocalCapacityMode?.addEventListener("change", async () => {
    const aiLocalCapacityMode = ["auto", "safe", "manual"].includes(
      els.aiLocalCapacityMode.value,
    )
      ? els.aiLocalCapacityMode.value
      : "auto";
    const max = Math.min(
      4,
      Math.max(1, Number(els.aiLocalManualConcurrency?.value) || 1),
    );
    await profileController.saveProfile({
      concurrency: { mode: aiLocalCapacityMode, max },
    });
    toggleUi();
    broadcast({ type: "AI_SETTINGS_CHANGED" });
  });

  els.aiLocalManualConcurrency?.addEventListener("change", async () => {
    const aiLocalManualConcurrency = Math.min(
      4,
      Math.max(1, Number(els.aiLocalManualConcurrency.value) || 1),
    );
    els.aiLocalManualConcurrency.value = String(aiLocalManualConcurrency);
    await profileController.saveProfile({
      concurrency: {
        mode: els.aiLocalCapacityMode?.value || "auto",
        max: aiLocalManualConcurrency,
      },
    });
    broadcast({ type: "AI_SETTINGS_CHANGED" });
  });

  els.apiLocalUnlimited?.addEventListener("change", async () => {
    await setStorage({
      apiLocalUnlimited: Boolean(els.apiLocalUnlimited.checked),
    });
  });

  els.aiThinking?.addEventListener("change", async () => {
    const value = els.aiThinking.value === "on" ? "on" : "off";
    await profileController.saveProfile({ thinking: value });
  });

  els.aiMemoryMode?.addEventListener("change", async () => {
    const mode = ["off", "terms", "full"].includes(els.aiMemoryMode.value)
      ? els.aiMemoryMode.value
      : "off";
    // Keep the legacy boolean in sync so older code paths still behave.
    await profileController.saveProfile({ memoryMode: mode });
  });

  els.aiModel.addEventListener("change", async () => {
    const prevModel = state.desiredAiModel;
    const nextModel = normalizeAiModel(els.aiModel.value || prevModel);
    const flushed = await flushPendingAiEditsForSwitch(
      state.desiredLang,
      prevModel,
    );
    if (flushed?.ok === false) {
      els.aiModel.value = prevModel;
      setFieldMessage(
        els.aiModelWrap,
        "error",
        "Model change stopped because current settings were not saved.",
      );
      return;
    }
    state.desiredAiModel = nextModel;
    const selectedProfile = profileController.selectModel(nextModel);
    updatePromptCount(AI_PROMPT_MAX_CHARS, selectedProfile.value);
    const usageTarget = selectedUsageTarget(state.desiredAiModel);
    void usageController.select(
      { ...usageTarget, reason: "model_switch" },
      selectedUsageTarget,
    );
    state.modelDirty = true;
    state.lastAiProbe = null;
    renderLocalCapacityHint();
    await persistSelectedLocalCapacityHint();
    await applyPromptForLang(state.desiredLang);
    scheduleSaveAi();
    if (isLocalAiProvider(els.aiProvider?.value))
      localConnectionController.markModelChanged(nextModel);
    else
      providerMetaController.refresh();
    toggleUi();
  });

  els.aiUsageReset?.addEventListener("click", async () => {
    const usageTarget = selectedUsageTarget();
    await usageController.reset(
      usageTarget,
      persistUsageReset,
      selectedUsageTarget,
    );
  });

  els.aiUsageHistory?.addEventListener(
    "click",
    () => void openAiUsageHistory(),
  );
  els.aiUsageHistoryClose?.addEventListener("click", closeAiUsageHistory);
  els.aiUsageHistoryDialog?.addEventListener("click", (event) => {
    if (event.target === els.aiUsageHistoryDialog) closeAiUsageHistory();
  });

  els.aiPrompt.addEventListener("input", () => {
    state.aiPromptDirtyByLang[
      profileController.promptKey(state.desiredLang, state.desiredAiModel)
    ] = true;
    updatePromptCount(AI_PROMPT_MAX_CHARS);
    // Typing makes Back available (returns to the last saved version) and
    // invalidates Forward — cheap sync toggle, no storage read per keystroke.
    if (els.aiPromptBack) els.aiPromptBack.disabled = false;
    if (els.aiPromptForward) els.aiPromptForward.disabled = true;
    // Typing clears a stale fetch error; refresh the empty-prompt warning live.
    if (
      String(els.aiPrompt.value || "").trim() &&
      fieldMessageType(els.aiPromptWrap) === "error"
    ) {
      setFieldMessage(els.aiPromptWrap, "", "");
    }
    updateAiPromptWarning();
    scheduleSaveAi();
  });

  els.aiPromptBack?.addEventListener("click", async () => {
    const key = profileController.promptKey(
      state.desiredLang,
      state.desiredAiModel,
    );
    const res = await promptHistoryBack(key, String(els.aiPrompt.value || ""));
    if (res) await applyPromptHistoryResult(key, res);
    else await refreshPromptHistoryButtons();
  });

  els.aiPromptForward?.addEventListener("click", async () => {
    const key = profileController.promptKey(
      state.desiredLang,
      state.desiredAiModel,
    );
    const res = await promptHistoryForward(key);
    if (res) await applyPromptHistoryResult(key, res);
    else await refreshPromptHistoryButtons();
  });
  els.aiPrompt.addEventListener("blur", async () => {
    state.aiPromptDirtyByLang[
      profileController.promptKey(state.desiredLang, state.desiredAiModel)
    ] = true;
    updatePromptCount(AI_PROMPT_MAX_CHARS);
    await flushPromptForLang(state.desiredLang, state.desiredAiModel);
    scheduleSaveAi();
  });

  // Page actions (for sites that block right-click)
  // "Translate all images on this page" = the img_all context-menu flow,
  // triggered from the popup instead of a right-click.
  els.translatePageBtn?.addEventListener("click", async () => {
    if (state.providerTransitionPending) return;
    els.translatePageBtn.disabled = true;
    try {
      const tabs = await queryTabs({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab?.id) return;
      await sendRuntimeMessage({ type: "TP_RUN_TRANSLATE_ALL", tabId: tab.id });
      // Close the popup so the user sees the on-page progress toast.
      window.close();
    } finally {
      els.translatePageBtn.disabled = state.providerTransitionPending;
    }
  });

  // Toggle the per-image 🔍 buttons. Content scripts on every page react to the
  // storage change themselves — no broadcast needed.
  els.imgButtonsToggle?.addEventListener("change", async () => {
    await setStorage({
      imgButtonsEnabled: Boolean(els.imgButtonsToggle.checked),
    });
  });

  // Auto translate: its own full-page tab, with its own saved mode/language/source.
  els.openAutoTranslate?.addEventListener("click", async () => {
    await createTab({ url: chrome.runtime.getURL("auto/auto.html") });
    window.close();
  });
  els.resetApi.addEventListener("click", () => {
    setEmojiStatus("loading", "Fetching remote default...");
    ensureApiDefaults({ force: true })
      .then((d) => {
        state.apiDefaults = d || state.apiDefaults;
        const def =
          state.apiDefaults.resetApiUrl ||
          state.apiDefaults.defaultApiUrl ||
          "";
        const normalized = normalizeUrl(def);
        els.apiUrl.value = normalized;

        // Reset means "go back to the remote-managed default", not
        // "copy the current remote value into customApiUrl". Keeping customApiUrl
        // empty allows later REMOTE_DEFAULTS_URL changes to take effect.
        setStorage({ customApiUrl: "" });
        state.lastSavedApiUrl = "";
        state.userInteractedApi = false;

        broadcast({ type: "API_URL_CHANGED" });
        if (normalized) {
          setEmojiStatus("loading", "Reset to remote default");
          apiHealthController.check(normalized);
        } else {
          setEmojiStatus("error", "Remote default unavailable");
        }
        els.apiUrl.focus();
      })
      .catch(() => {
        setEmojiStatus("error", "Could not fetch remote default");
      });
  });

  // Save anything still pending when the popup closes.
  window.addEventListener("pagehide", () => {
    try {
      if (state.pendingApiSave) {
        const rawTrim = String(els.apiUrl.value || "").trim();
        const normalized = normalizeUrl(els.apiUrl.value);
        // Typed-but-invalid on close: leave the saved value as-is (don't clear to
        // remote default) — same no-silent-fallback rule as the debounced save.
        if (rawTrim && !normalized) {
          /* keep last good value */
        } else if (!normalized || isRemoteDefaultApiUrl(normalized)) {
          setStorage({ customApiUrl: "" });
        } else {
          setStorage({ customApiUrl: normalized });
        }
      }
      const aiKey = (els.aiKey.value || "").trim();
      const aiModel = normalizeAiModel(
        (els.aiModel.value || "").trim() || state.desiredAiModel || "auto",
      );
      if ((els.mode.value || "lens_text") === "lens_text") {
        const key = profileController.promptKey(
          state.desiredLang || els.lang.value || "en",
          aiModel,
        );
        const dirty = state.aiPromptDirtyByLang[key];
        if (dirty) {
          state.aiPromptByLang[key] = {
            text: normalizePrompt(String(els.aiPrompt.value || "")),
            mode: "replace",
          };
          state.aiPromptDirtyByLang[key] = false;
        }
        if (state.modelDirty || state.pendingCredentialSave || dirty) {
          void profilePagehideFlush.flush({
            credential: aiKey,
            saveCredential: state.pendingCredentialSave,
            language: state.desiredLang || els.lang.value || "en",
            model: aiModel,
            prompt: state.aiPromptByLang[key]?.text || "",
            promptMode: "replace",
            savePrompt: dirty,
          });
        }
      } else if (state.modelDirty || state.pendingCredentialSave) {
        void profilePagehideFlush.flush({
          credential: aiKey,
          saveCredential: state.pendingCredentialSave,
          language: state.desiredLang || els.lang.value || "en",
          model: aiModel,
        });
      }
    } catch {
      /* best-effort */
    }
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.aiSeriesMemory) {
      void refreshSeriesMemory();
    }
    if (changes[AI_USAGE_STORAGE_KEY]) void renderAiUsage();
    // Prompt Studio edits the canonical Provider+Model prompt map.
    if (changes.aiProfilePromptsV1) {
      const next = changes.aiProfilePromptsV1.newValue;
      state.aiPromptByLang = next && typeof next === "object" ? next : {};
      if (canUseAiUi()) applyPromptForLang(els.lang.value);
    }
  });

  window.addEventListener("offline", () => {
    state.lastApiOk = false;
    setEmojiStatus("error", "No internet");
    apiHealthController.markBrowserOffline?.();
  });
  window.addEventListener("online", () => {
    if (els.apiUrl.value) apiHealthController.check(els.apiUrl.value);
  });
}
