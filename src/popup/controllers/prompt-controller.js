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

  const recordFor = (key) => {
    const value = state.aiPromptByLang[key];
    if (value && typeof value === "object")
      return {
        text: normalizePrompt(String(value.text || "")),
        mode: "replace",
      };
    return { text: normalizePrompt(String(value || "")), mode: "replace" };
  };
  const selectedMode = () => "replace";
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
      const snapshot = await promptHistoryState(
        key,
        String(els.aiPrompt.value || ""),
      );
      if (els.aiPromptBack) els.aiPromptBack.disabled = !snapshot.canBack;
      if (els.aiPromptForward)
        els.aiPromptForward.disabled = !snapshot.canForward;
    } catch {
      /* history is best-effort */
    }
  }

  async function applyHistoryResult(key, result) {
    if (!result) return;
    els.aiPrompt.value = result.text;
    setRecord(key, result.text);
    state.aiPromptDirtyByLang[key] = false;
    updatePromptCount(AI_PROMPT_MAX_CHARS, result.text);
    if (saveProfilePrompt)
      await saveProfilePrompt(state.desiredLang, result.text, selectedMode());
    else await setStorage({ aiPromptByLang: state.aiPromptByLang });
    broadcast({ type: "AI_SETTINGS_CHANGED" });
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
        "warn",
        "⚠ [AI option > Set prompt] is empty — click Reload, then save",
      );
    } else if (fieldMessageType(els.aiPromptWrap) === "warn") {
      setFieldMessage(els.aiPromptWrap, "", "");
    }
  }

  function applyForLang(lang) {
    if (!canUseAiUi()) return;
    const selectedLang =
      (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
    const key = keyForPrompt(selectedLang, state.desiredAiModel);
    if (state.aiPromptDirtyByLang[key]) return;
    const saved = Object.prototype.hasOwnProperty.call(
      state.aiPromptByLang,
      key,
    )
      ? recordFor(key).text
      : "";
    els.aiPrompt.value = saved;
    updateModeHint();
    updatePromptCount(AI_PROMPT_MAX_CHARS, saved);
    void promptHistoryPush(key, saved).then(refreshHistoryButtons);
    updateWarning();
  }

  async function resetForLang(lang) {
    if (!canUseAiUi()) return;
    const selectedLang =
      (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
    const model = normalizeAiModel(state.desiredAiModel);
    const key = keyForPrompt(selectedLang, model);
    const sequence = ++state.promptSeq;
    const fetched = await fetchDefaultPrompt(
      els.apiUrl.value,
      selectedLang,
      model,
    );
    if (sequence !== state.promptSeq) return;
    if (fetched === null) {
      setFieldMessage(
        els.aiPromptWrap,
        "error",
        "Reset failed: API unreachable — keeping your current prompt",
      );
      return;
    }
    const value = normalizePrompt(fetched);
    if (sequence !== state.promptSeq) return;
    setFieldMessage(els.aiPromptWrap, "", "");
    setRecord(key, value);
    updateModeHint();
    state.aiPromptDirtyByLang[key] = false;
    els.aiPrompt.value = value;
    updatePromptCount(AI_PROMPT_MAX_CHARS, value);
    if (saveProfilePrompt)
      await saveProfilePrompt(selectedLang, value, "replace");
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
