import { normalizeUrl } from "../../shared/url.js";
import { broadcast } from "../../shared/messaging.js";
import {
  // AI_PROMPT_MAX_CHARS,
  normalizeAiModel,
  normalizePrompt,
  promptHistoryPush,
} from "../../shared/prompt.js";
import {
  KNOWN_KEY_PREFIXES,
  SK_STYLE_PROVIDERS,
  providerFromKey,
  providerLabel,
} from "./provider-model-display.js";
import { createAiProfilePagehideFlush } from "./ai-profile-controller.js";

export function createSettingsPersistenceController(deps) {
  const {
    els,
    state,
    profileController,
    providerMetaController,
    apiHealthController,
    persist,
    setStatus,
    setFieldMessage,
    // fieldMessageType,
    toggleUi,
    canUseAiUi,
    isRemoteDefaultApiUrl,
    refreshPromptHistoryButtons,
  } = deps;
  let apiDebounce = null;
  let aiDebounce = null;
  const profilePagehideFlush = createAiProfilePagehideFlush({
    controller: profileController,
    persist,
    cancelPending: () => {
      clearTimeout(aiDebounce);
      state.pendingAiSave = false;
      state.pendingCredentialSave = false;
    },
  });
  const promptRecord = (key, text = els.aiPrompt?.value || "") => {
    const current = state.aiPromptByLang[key];
    return {
      text: normalizePrompt(String(text || "")),
      mode: "replace",
    };
  };
  function validateAiKey() {
    if (!els.aiKeyWrap) return;
    if (els.aiKeyWrap.style.display === "none") {
      setFieldMessage(els.aiKeyWrap, "", "");
      return;
    }
    const key = (els.aiKey.value || "").trim();
    if (!key) {
      if (state.metaCache?.has_env_ai_key) {
        setFieldMessage(els.aiKeyWrap, "", "");
      } else {
        setFieldMessage(
          els.aiKeyWrap,
          "warn",
          "⚠ No API key set — AI won’t run",
        );
      }
      return;
    }
    if (/\s/.test(key)) {
      setFieldMessage(
        els.aiKeyWrap,
        "error",
        "The key contains whitespace — please double-check it",
      );
      return;
    }
    const provider = (els.aiProvider?.value || "").trim().toLowerCase();
    // const known = KNOWN_KEY_PREFIXES.some((p) => key.startsWith(p));
    if (!provider) {
      setFieldMessage(
        els.aiKeyWrap,
        "warn",
        "⚠ Select the provider that issued this key",
      );
      return;
    }
    // A key whose prefix names a DIFFERENT provider is not a style question: the
    // request would be sent to the selected provider with a credential it cannot
    // accept, and the only symptom would be a 401 per image mid-batch.
    const keyProvider = providerFromKey(key);
    if (keyProvider && keyProvider !== provider) {
      setFieldMessage(
        els.aiKeyWrap,
        "error",
        `✕ This is a ${providerLabel(keyProvider)} key but the provider is set to ` +
          `${providerLabel(provider)} — paste a ${providerLabel(provider)} key, or switch the provider back.`,
      );
      return;
    }
    // The reverse case: an sk- key with a provider that does not use one.
    if (
      !keyProvider &&
      key.startsWith("sk-") &&
      !SK_STYLE_PROVIDERS.has(provider)
    ) {
      setFieldMessage(
        els.aiKeyWrap,
        "error",
        `✕ ${providerLabel(provider)} does not use an sk- key — this looks like an OpenAI-style key.`,
      );
      return;
    }
    setFieldMessage(els.aiKeyWrap, "", "");
  }

  /**
   * Warn when the stored language/source is not offered by the server (or the
   * fallback list) — otherwise the request silently uses whatever the <select>
   * snapped to, not what the user chose.
   */
  function validateLangSource() {
    // Skip until the <select>s are populated, so the initial empty state during
    // load never flashes a false "not supported" warning.
    if (
      els.langWrap &&
      els.langWrap.style.display !== "none" &&
      els.lang.options.length
    ) {
      const want = String(state.desiredLang || "");
      const present = [...els.lang.options].some((o) => o.value === want);
      setFieldMessage(
        els.langWrap,
        present ? "" : "warn",
        present ? "" : `⚠ Language "${want}" is not in the supported list`,
      );
    }
    if (
      els.sourcesWrap &&
      els.sourcesWrap.style.display !== "none" &&
      els.sources.options.length
    ) {
      const want = String(state.desiredSources || "");
      const present = [...els.sources.options].some((o) => o.value === want);
      setFieldMessage(
        els.sourcesWrap,
        present ? "" : "warn",
        present ? "" : `⚠ Source "${want}" is not in the list`,
      );
    }
  }

  /** Persist the in-textarea prompt for (lang, model) if it was edited. */
  async function flushPromptForLang(lang, model = null) {
    if (!canUseAiUi()) return;
    const l =
      (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
    const key = profileController.promptKey(
      l,
      normalizeAiModel(model || state.desiredAiModel),
    );
    if (!state.aiPromptDirtyByLang[key]) return;
    const next = promptRecord(key);
    const current = state.aiPromptByLang[key];
    state.aiPromptDirtyByLang[key] = false;
    if (
      current?.text === next.text &&
          (current?.mode || "replace") === next.mode
    ) return;
    state.aiPromptByLang[key] = next;
    await profileController.savePrompt(
      l,
      state.aiPromptByLang[key].text,
      state.aiPromptByLang[key].mode,
    );
    // Each saved edit becomes a history version (browser-like: truncates any
    // forward branch left over from earlier Back navigation).
    void promptHistoryPush(key, state.aiPromptByLang[key].text).then(
      refreshPromptHistoryButtons,
    );
  }

  /** Flush edits against the identity that owned them before a Provider/Model switch. */
  function flushPendingAiEditsForSwitch(lang, model) {
    const language = String(lang || "en").trim() || "en";
    const selectedModel = normalizeAiModel(model || "auto");
    const key = profileController.promptKey(language, selectedModel);
    const dirty = Boolean(state.aiPromptDirtyByLang[key]);
    if (dirty)
      state.aiPromptByLang[key] = promptRecord(key);
    const saveCredential = Boolean(state.pendingCredentialSave);
    if (!dirty && !saveCredential && !state.modelDirty) {
      return Promise.resolve({ ok: true, status: "nothing_pending" });
    }
    state.aiPromptDirtyByLang[key] = false;
    return profilePagehideFlush.flush({
      credential: String(els.aiKey.value || "").trim(),
      saveCredential,
      language,
      model: selectedModel,
      prompt: state.aiPromptByLang[key]?.text || "",
      promptMode: "replace",
      savePrompt: dirty,
    });
  }

  // Debounced persistence
  function scheduleSaveApi(raw) {
    clearTimeout(apiDebounce);
    state.pendingApiSave = true;
    apiDebounce = setTimeout(async () => {
      state.pendingApiSave = false;
      const rawTrim = String(raw || "").trim();
      const normalized = normalizeUrl(raw);

      // Typed-but-invalid URL: do NOT silently fall back to the remote default
      // (that would hide the user's mistake and make a bad URL look accepted).
      // Surface the error and keep the last good saved value untouched.
      if (rawTrim && !normalized) {
        setStatus(
          "error",
          "Invalid API URL format (must start with http:// or https://)",
        );
        return;
      }

      // Empty field, or the same value as the remote default/reset URL, means
      // "use REMOTE_DEFAULTS_URL". Do not store that value as customApiUrl,
      // otherwise future remote changes are hidden by the copied custom value.
      if (!normalized || isRemoteDefaultApiUrl(normalized)) {
        const effective =
          normalized || normalizeUrl(state.apiDefaults?.defaultApiUrl || "");
        await persist({ customApiUrl: "" });
        state.lastSavedApiUrl = "";
        state.userInteractedApi = false;
        broadcast({ type: "API_URL_CHANGED" });
        if (effective) {
          setStatus("loading", "Checking API...");
          apiHealthController.check(effective);
          providerMetaController.refresh();
        }
        return;
      }

      if (normalized === state.lastSavedApiUrl) {
        apiHealthController.check(normalized);
        return;
      }
      state.userInteractedApi = true;
      await persist({ customApiUrl: normalized });
      state.lastSavedApiUrl = normalized;
      broadcast({ type: "API_URL_CHANGED" });
      setStatus("loading", "Checking API...");
      apiHealthController.check(normalized);
      providerMetaController.refresh();
    }, 800);
  }

  function scheduleSaveAi() {
    clearTimeout(aiDebounce);
    state.pendingAiSave = true;
    aiDebounce = setTimeout(async () => {
      state.pendingAiSave = false;
      const saveCredential = state.pendingCredentialSave;
      const aiKey = (els.aiKey.value || "").trim();
      const aiModel = normalizeAiModel(
        (els.aiModel.value || "").trim() || state.desiredAiModel || "auto",
      );
      state.desiredAiModel = aiModel;
      const lang = state.desiredLang || els.lang.value || "en";
      const key = profileController.promptKey(lang, aiModel);
      const wasPromptDirty = Boolean(state.aiPromptDirtyByLang[key]);
      const nextPrompt = wasPromptDirty ? promptRecord(key) : null;
      const currentPrompt = state.aiPromptByLang[key];
      const promptChanged = Boolean(
        nextPrompt &&
          (currentPrompt?.text !== nextPrompt.text ||
            (currentPrompt?.mode || "replace") !== nextPrompt.mode),
      );
      state.aiPromptDirtyByLang[key] = false;
      if (promptChanged) state.aiPromptByLang[key] = nextPrompt;
      const modelChanged = Boolean(state.modelDirty);
      if (!saveCredential && !promptChanged && !modelChanged) {
        state.pendingCredentialSave = false;
        return;
      }
      await profilePagehideFlush.flush({
        credential: aiKey,
        saveCredential,
        language: lang,
        model: aiModel,
        prompt: promptChanged ? nextPrompt.text : "",
        promptMode: "replace",
        savePrompt: promptChanged,
      });
      state.pendingCredentialSave = false;
      state.modelDirty = false;
      broadcast({ type: "AI_SETTINGS_CHANGED" });
      toggleUi();
      providerMetaController.renderStatus();
      // Provider/model discovery is scheduled by the specific key/provider/model
      // event that changed it. Prompt edits also use this saver and must not
      // accidentally clear a completed model probe by refreshing AI metadata.
    }, 400);
  }
  return {
    validateAiKey,
    validateLangSource,
    flushPromptForLang,
    flushPendingAiEditsForSwitch,
    scheduleSaveApi,
    scheduleSaveAi,
    profilePagehideFlush,
  };
}
