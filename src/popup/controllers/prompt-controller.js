import {
  AI_PROMPT_MAX_CHARS,
  normalizeAiModel,
  normalizePrompt,
  promptHistoryPush,
  promptHistoryState,
} from "../../shared/prompt.js";

/** Coordinates the prompt editor without owning popup event registration. */
export function createPromptController(deps) {
  const {
    els,
    state,
    canUseAiUi,
    fetchDefaultPrompt,
    setStorage,
    broadcast,
    updatePromptCount,
    setFieldMessage,
    fieldMessageType,
    keyForPrompt = (lang) => String(lang || "en"),
    saveProfilePrompt = null,
  } = deps;
  const invalidate = () => { state.promptSeq = (Number(state.promptSeq) || 0) + 1; };
  for (const key of ["aiProvider", "aiModel", "aiPaidModel", "aiService", "lang", "apiUrl", "aiBaseUrl"])
    els[key]?.addEventListener?.("change", invalidate);
  for (const key of ["aiPrompt", "apiUrl", "aiBaseUrl"])
    els[key]?.addEventListener?.("input", invalidate);

  const recordFor = (key) => {
    const value = state.aiPromptByLang[key];
    if (value && typeof value === "object")
      return {
        text: normalizePrompt(String(value.text || "")),
        mode: "replace",
      };
    return { text: normalizePrompt(String(value || "")), mode: "replace" };
  };
  const setRecord = (key, text) => {
    state.aiPromptByLang[key] = {
      text: normalizePrompt(String(text || "")),
      mode: "replace",
    };
    return state.aiPromptByLang[key];
  };

  function updateModeHint() {}

  async function refreshHistoryButtons() {
    if (!els.aiPromptBack && !els.aiPromptForward) return;
    try {
      const key = keyForPrompt(state.desiredLang, state.desiredAiModel);
      const revision = state.promptSeq;
      const snapshot = await promptHistoryState(
        key,
        String(els.aiPrompt.value || ""),
      );
      if (revision !== state.promptSeq || key !== keyForPrompt(state.desiredLang, state.desiredAiModel)) return;
      if (els.aiPromptBack) els.aiPromptBack.disabled = !snapshot.canBack;
      if (els.aiPromptForward)
        els.aiPromptForward.disabled = !snapshot.canForward;
    } catch {
      /* history is best-effort */
    }
  }

  async function applyHistoryResult(key, result, originalText = null, revision = null) {
    if (!result) return;
    if ((revision !== null && revision !== state.promptSeq) || key !== keyForPrompt(state.desiredLang, state.desiredAiModel) ||
        (originalText !== null && String(els.aiPrompt.value || "") !== originalText)) return;
    els.aiPrompt.value = result.text;
    setRecord(key, result.text);
    state.aiPromptDirtyByLang[key] = false;
    updatePromptCount(AI_PROMPT_MAX_CHARS, result.text);
    const appliedRevision = state.promptSeq;
    if (saveProfilePrompt)
      await saveProfilePrompt(state.desiredLang, result.text);
    else await setStorage({ aiPromptByLang: state.aiPromptByLang });
    broadcast({ type: "AI_SETTINGS_CHANGED" });
    if (appliedRevision !== state.promptSeq || key !== keyForPrompt(state.desiredLang, state.desiredAiModel) ||
        String(els.aiPrompt.value || "") !== result.text) return;
    if (els.aiPromptBack) els.aiPromptBack.disabled = !result.canBack;
    if (els.aiPromptForward) els.aiPromptForward.disabled = !result.canForward;
  }

  function updateWarning() {
    if (!els.aiPromptWrap || fieldMessageType(els.aiPromptWrap) === "error")
      return;
    const empty = !String(els.aiPrompt?.value || "").trim();
    if (canUseAiUi() && empty) {
      setFieldMessage(
        els.aiPromptWrap,
        "info",
        "Built-in translation style will be used. Reload only when you want to edit the default.",
      );
    } else if (["warn", "info"].includes(fieldMessageType(els.aiPromptWrap))) {
      setFieldMessage(els.aiPromptWrap, "", "");
    }
  }

  // A model/language without a saved prompt loads the built-in style by
  // itself (as if Reload were pressed), once per popup session and key.
  const autoLoaded = new Set();
  function applyForLang(lang) {
    if (!canUseAiUi()) return;
    const selectedLang =
      (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
    const key = keyForPrompt(selectedLang, state.desiredAiModel);
    if (state.aiPromptDirtyByLang[key]) return;
    const hasSaved = Object.prototype.hasOwnProperty.call(state.aiPromptByLang, key);
    const saved = hasSaved ? recordFor(key).text : "";
    els.aiPrompt.value = saved;
    updateModeHint();
    updatePromptCount(AI_PROMPT_MAX_CHARS, saved);
    void promptHistoryPush(key, saved).then(refreshHistoryButtons);
    updateWarning();
    if (!saved.trim() && !autoLoaded.has(key) && typeof fetchDefaultPrompt === "function") {
      autoLoaded.add(key);
      // Best effort: the built-in style is used anyway; Reload stays available.
      void resetForLang(selectedLang, {auto: true}).catch(() => updateWarning());
    }
  }

  async function resetForLang(lang, {auto = false} = {}) {
    if (!canUseAiUi()) return;
    const selectedLang =
      (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
    const model = normalizeAiModel(state.desiredAiModel);
    const key = keyForPrompt(selectedLang, model);
    const originalText = String(els.aiPrompt.value || "");
    const apiBase = els.apiUrl.value;
    const sequence = ++state.promptSeq;
    const current = () => sequence === state.promptSeq && canUseAiUi() &&
      selectedLang === state.desiredLang && apiBase === els.apiUrl.value &&
      key === keyForPrompt(state.desiredLang, state.desiredAiModel) &&
      String(els.aiPrompt.value || "") === originalText;
    const fetched = await fetchDefaultPrompt(
      els.apiUrl.value,
      selectedLang,
      model,
    );
    if (!current()) return;
    if (fetched === null) {
      // Automatic load: the built-in style is still used; Reload stays available.
      if (auto) { updateWarning(); return; }
      setFieldMessage(
        els.aiPromptWrap,
        "error",
        "Reset failed: API unreachable — keeping your current prompt",
      );
      return;
    }
    const value = normalizePrompt(fetched);
    if (!current()) return;
    setFieldMessage(els.aiPromptWrap, "", "");
    setRecord(key, value);
    updateModeHint();
    state.aiPromptDirtyByLang[key] = false;
    els.aiPrompt.value = value;
    updatePromptCount(AI_PROMPT_MAX_CHARS, value);
    if (saveProfilePrompt)
      await saveProfilePrompt(selectedLang, value);
    else await setStorage({ aiPromptByLang: state.aiPromptByLang });
    broadcast({ type: "AI_SETTINGS_CHANGED" });
    void promptHistoryPush(key, value).then(refreshHistoryButtons);
    updateWarning();
  }

  return {
    applyForLang,
    applyHistoryResult,
    refreshHistoryButtons,
    resetForLang,
    updateModeHint,
    updateWarning,
  };
}
