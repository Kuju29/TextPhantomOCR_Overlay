/** User-editable configuration only. Usage, prompt history, traces and repair sessions are preserved. */
export const SETTINGS_RESET_KEYS = Object.freeze([
  "mode", "lang", "sources", "maxConcurrency",
  "customApiUrl", "apiUrlDefault", "apiUrlReset", "apiDefaultsFetchedAt",
  "latestVersion", "updateUrl",
  "aiKey", "aiCloudKey", "aiModel", "aiProvider", "aiBaseUrl",
  "localAiAdapter", "aiGlossary", "aiCharMemory", "aiMemoryMode",
  "aiSendImage", "aiPageImage", "aiOnDevice", "aiThinking", "aiLocalThinking",
  "aiPrompt", "aiPromptByLang", "relayoutTranslated",
  "rateLimitEnabled", "rateProfile", "rateRpm", "rateBurst",
  "aiLocalCapacityMode", "aiLocalManualConcurrency", "aiLocalCapabilityHint",
  "aiLocalCapabilitySnapshotsV1", "aiConcurrencyLearningV1", "apiLocalUnlimited", "engineMode",
  "aiProfilesV1", "aiProfileStorageVersion", "aiProfileCredentialsV1",
  "aiProfilePromptsV1", "fontScale", "imgButtonsEnabled",
  "uploadFormat", "uploadQuality",
  "autoMode", "autoLang", "autoSource", "autoShowRaw", "autoRawTab", "autoWidth",
]);

export function createResetDefaultsController({
  els,
  remove,
  resetLive = async () => {},
  confirmReset = (message) => globalThis.confirm(message),
  reload = () => globalThis.location.reload(),
} = {}) {
  async function reset() {
    if (!confirmReset("Reset all TextPhantom settings to current defaults?")) return false;
    if (els.resetDefaults) els.resetDefaults.disabled = true;
    if (els.resetDefaultsStatus) els.resetDefaultsStatus.textContent = "Resetting…";
    try {
      await resetLive();
      await remove(SETTINGS_RESET_KEYS);
      if (els.resetDefaultsStatus) els.resetDefaultsStatus.textContent = "Settings reset.";
      reload();
      return true;
    } catch {
      if (els.resetDefaultsStatus)
        els.resetDefaultsStatus.textContent = "Reset failed. Settings were not changed.";
      if (els.resetDefaults) els.resetDefaults.disabled = false;
      return false;
    }
  }

  function bind() {
    els.resetDefaults?.addEventListener("click", reset);
  }

  return { bind, reset };
}
