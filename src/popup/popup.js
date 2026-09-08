import { mountTranslationSessionStatus } from './controllers/translation-session-controller.js';
import { normalizeUrl } from "../shared/url.js";
import { getStorage, setStorage } from "../shared/storage.js";
import {
  AI_USAGE_STORAGE_KEY,
  currentUsage,
  persistUsageSelectionBoundary,
  usageHistoryRows,
} from "../shared/ai-usage.js";
import {
  localAiPreset,
  normalizeLocalAiAdapter,
} from "../shared/ai/providers/local-registry.js";
import { createTab, queryTabs } from "../shared/browser-api.js";
import { broadcast, sendRuntimeMessage } from "../shared/messaging.js";
import {
  FALLBACK_LANGS,
  FALLBACK_SOURCES,
  PINNED_LANG_CODES,
  API_PATHS,
  RATE_RPM_MIN,
  RATE_RPM_MAX,
  RATE_BURST_MIN,
  RATE_BURST_MAX,
  RATE_PRESETS,
  RATE_PRESET_DEFAULT,
  isLocalAiProvider,
} from "../shared/constants.js";
import {
  els,
  setSelectOptions,
  orderLanguages,
  setModelOptions,
  setEmojiStatus,
  updatePromptCount,
  setFieldMessage,
  fieldMessageType,
  toggleUi as toggleUiDom,
} from "./dom.js";
import {
  fetchJson,
  checkHealthOnce,
  fetchDefaultPrompt,
  HEALTH_TIMEOUT_MS,
  AI_META_TIMEOUT_MS,
  AI_PROBE_TIMEOUT_MS,
  RETRY_DELAYS_MS,
} from "./api.js";
import { createAiUsageController } from "./controllers/ai-usage-controller.js";
import { createPromptController } from "./controllers/prompt-controller.js";
import { createAiProfileController } from "./controllers/ai-profile-controller.js";
import { createFontScaleController } from "./controllers/font-scale-controller.js";
import { createLocalPickerController } from "./controllers/local-picker-controller.js";
import { createSeriesMemoryController } from "./controllers/series-memory-controller.js";
import { createRateSettingsController } from "./controllers/rate-settings-controller.js";
import { createLocalConnectionController } from "./controllers/local-connection-controller.js";
import { createApiHealthController } from "./controllers/api-health-controller.js";
import { createProviderMetaController } from "./controllers/provider-meta-controller.js";
import { bindPopupEvents } from "./controllers/popup-event-controller.js";
import { createUsageViewController } from "./controllers/usage-view-controller.js";
import { loadPopupSettings } from "./controllers/settings-hydration-controller.js";
import { createSettingsPersistenceController } from "./controllers/settings-persistence-controller.js";
import { createLocalCapacityController } from "./controllers/local-capacity-controller.js";
import { createPopupUiController } from "./controllers/popup-ui-controller.js";
import { createApiAvailabilityGate } from "./controllers/api-availability-gate.js";
import {
  protocolLabel,
  providerFromKey,
  providerLabel,
} from "./controllers/provider-model-display.js";

const state = {
  userInteractedApi: false,
  lastApiOk: false,
  lastSavedApiUrl: "",
  retryTimer: null,
  metaCache: null,
  modelDirty: false,
  aiMetaSeq: 0,
  aiProbeSeq: 0,
  lastAiResolve: null,
  lastAiProbe: null,
  promptSeq: 0,
  lastResolvedProvider: "",
  lastResolvedKey: "",
  desiredLang: "en",
  desiredSources: "translated",
  desiredAiModel: "",
  aiPromptByLang: {},
  seriesKey: "default",
  seriesMemory: { glossary: [], characters: [] },
  aiPromptDirtyByLang: {},
  pendingApiSave: false,
  pendingAiSave: false,
  pendingCredentialSave: false,
  apiDefaults: { defaultApiUrl: "", resetApiUrl: "", fetchedAt: 0 },
  healthSeq: 0,
  localAiCapability: null,
  // Explicit Local-AI connection tests have a separate generation from
  // background metadata refreshes.  A health/meta refresh must never make a
  // user click disappear without a terminal status.
  localConnectSeq: 0,
  localConnectInFlight: null,
  activeAiProvider: "",
  providerTransitionPending: false,
  providerTransitionRevision: 0,
  aiProfileBlocked: false, aiModelBlocked: false,
  aiProfileErrorCode: "",
};

const usageViewController = createUsageViewController({
  els,
  state,
  isLocalProvider: isLocalAiProvider,
  getStorage,
  storageKey: AI_USAGE_STORAGE_KEY,
  currentUsage,
  historyRows: usageHistoryRows,
});
const selectedUsageTarget = usageViewController.target;
const usageController = createAiUsageController({
  persistBoundary: persistUsageSelectionBoundary,
  readCurrentUsage: currentUsage,
  renderUsage: usageViewController.render,
});
const profileController = createAiProfileController({ els, state, setStorage });
const fontScaleController = createFontScaleController({
  els,
  persist: setStorage,
  broadcast,
});
const localPickerController = createLocalPickerController({
  els,
  createTab,
  runtimeUrl: (path) => chrome.runtime.getURL(path),
  closeWindow: () => window.close(),
  randomId: () => crypto.randomUUID(),
});
const seriesMemoryController = createSeriesMemoryController({
  els,
  state,
  getStorage,
  setStorage,
  queryTabs,
});

const renderAiUsage = usageViewController.refresh;
const openAiUsageHistory = usageViewController.openHistory;
const closeAiUsageHistory = usageViewController.closeHistory;

function isRemoteDefaultApiUrl(url) {
  const normalized = normalizeUrl(url);
  const remoteDefault = normalizeUrl(state.apiDefaults?.defaultApiUrl || "");
  const remoteReset = normalizeUrl(state.apiDefaults?.resetApiUrl || "");
  return Boolean(
    normalized && (normalized === remoteDefault || normalized === remoteReset),
  );
}

let apiAvailabilityGate = null;
const popupUiController = createPopupUiController({
  els,
  state,
  isLocalProvider: isLocalAiProvider,
  toggleDom: toggleUiDom,
  updatePromptWarning: () => promptController.updateWarning(),
  validateAiKey: () => settingsPersistenceController.validateAiKey(),
  validateLangSource: () => settingsPersistenceController.validateLangSource(),
  applyApiAvailabilityGate: () => apiAvailabilityGate?.apply(),
});
const toggleUi = popupUiController.toggle;
const traceProviderTransition = popupUiController.traceProviderTransition;
const setProviderTransitionPending =
  popupUiController.setProviderTransitionPending;

const rateSettingsController = createRateSettingsController({
  els,
  constants: {
    presets: RATE_PRESETS,
    fallback: RATE_PRESET_DEFAULT,
    rpmMin: RATE_RPM_MIN,
    rpmMax: RATE_RPM_MAX,
    burstMin: RATE_BURST_MIN,
    burstMax: RATE_BURST_MAX,
  },
  persist: setStorage,
  toggleUi,
});

const localCapacityController = createLocalCapacityController({
  els,
  state,
  isLocalProvider: isLocalAiProvider,
  persist: setStorage,
});
const renderLocalCapacityHint = localCapacityController.render;
const persistSelectedLocalCapacityHint = localCapacityController.persistSelected;
const clearLocalCapacitySnapshot = localCapacityController.clear;

function canUseAiUi() {
  return (
    (els.mode.value || "lens_text") === "lens_text" &&
    (els.sources.value || "").trim() === "ai"
  );
}

const promptController = createPromptController({
  els,
  state,
  canUseAiUi,
  fetchDefaultPrompt,
  setStorage,
  broadcast,
  updatePromptCount,
  setFieldMessage,
  fieldMessageType,
  keyForPrompt: (lang, model) => profileController.promptKey(lang, model),
  saveProfilePrompt: (lang, text, mode) =>
    profileController.savePrompt(lang, text, mode),
});
const applyPromptForLang = promptController.applyForLang;
const applyPromptHistoryResult = promptController.applyHistoryResult;
const refreshPromptHistoryButtons = promptController.refreshHistoryButtons;
const resetPromptForLang = promptController.resetForLang;
const updateAiPromptWarning = promptController.updateWarning;
const updateAiPromptModeHint = promptController.updateModeHint;

function ensureAiAvailableOrFallback() {
  if (!canUseAiUi()) return true;
  toggleUi();
  return true;
}

let apiHealthController;
apiAvailabilityGate = createApiAvailabilityGate({
  els,
  checkApi: () => {
    const url = normalizeUrl(els.apiUrl?.value || "");
    if (url) return apiHealthController?.check(url); },
});
apiHealthController = createApiHealthController({
  els,
  state,
  normalizeUrl,
  checkHealthOnce,
  fetchJson,
  paths: API_PATHS,
  timeout: HEALTH_TIMEOUT_MS,
  retryDelays: RETRY_DELAYS_MS,
  setStatus: setEmojiStatus,
  setSelectOptions,
  orderLanguages,
  languages: FALLBACK_LANGS,
  sources: FALLBACK_SOURCES,
  pinnedLanguages: PINNED_LANG_CODES,
  persist: setStorage,
  toggleUi,
  availabilityGate: apiAvailabilityGate,
});

const localConnectionController = createLocalConnectionController({
  els, state,
  profile: profileController,
  persist: setStorage, getStorage,
  sendMessage: sendRuntimeMessage, normalizeUrl,
  setModelOptions, setFieldMessage,
  renderPrompt: applyPromptForLang,
  scheduleSave: () => settingsPersistenceController.scheduleSaveAi(),
  clearResolveTimer: () => providerMetaController.cancelSchedule(),
  clearCapacity: clearLocalCapacitySnapshot,
  renderCapacity: renderLocalCapacityHint,
  persistCapacity: persistSelectedLocalCapacityHint,
  toggleUi,
});

const providerMetaController = createProviderMetaController({
  els,
  state,
  api: {
    fetchJson,
    getStorage,
    sendMessage: sendRuntimeMessage,
    localPreset: localAiPreset,
    normalizeLocalAdapter: normalizeLocalAiAdapter,
  },
  constants: {
    paths: API_PATHS,
    metaTimeout: AI_META_TIMEOUT_MS,
    probeTimeout: AI_PROBE_TIMEOUT_MS,
  },
  provider: { isLocal: isLocalAiProvider, label: providerLabel, protocolLabel },
  profile: profileController,
  prompt: {
    render: applyPromptForLang,
    scheduleSave: () => settingsPersistenceController.scheduleSaveAi(),
  },
  local: {
    savedModel: localConnectionController.savedModel,
    showFallback: localConnectionController.showFallback,
    renderCapacity: renderLocalCapacityHint,
    persistCapacity: persistSelectedLocalCapacityHint,
  },
  usage: usageController,
  persist: setStorage,
  normalizeUrl,
  setModelOptions,
  setFieldMessage,
  setStatus: setEmojiStatus,
  toggleUi,
});

const settingsPersistenceController = createSettingsPersistenceController({
  els,
  state,
  profileController,
  providerMetaController,
  apiHealthController,
  persist: setStorage,
  setStatus: setEmojiStatus,
  setFieldMessage,
  fieldMessageType,
  toggleUi,
  canUseAiUi,
  isRemoteDefaultApiUrl,
  refreshPromptHistoryButtons,
});

fontScaleController.bind();
localPickerController.bind();
seriesMemoryController.bind();
rateSettingsController.bind();
localConnectionController.bind();
bindPopupEvents({
  els,
  state,
  profileController,
  profilePagehideFlush: settingsPersistenceController.profilePagehideFlush,
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
  validateAiKey: settingsPersistenceController.validateAiKey,
  ensureAiAvailableOrFallback,
  flushPromptForLang: settingsPersistenceController.flushPromptForLang,
  flushPendingAiEditsForSwitch:
    settingsPersistenceController.flushPendingAiEditsForSwitch,
  scheduleSaveApi: settingsPersistenceController.scheduleSaveApi,
  scheduleSaveAi: settingsPersistenceController.scheduleSaveAi,
  selectedUsageTarget,
  renderLocalCapacityHint,
  persistSelectedLocalCapacityHint,
  clearLocalCapacitySnapshot,
  rateSettingsController,
  renderAiUsage,
  refreshSeriesMemory: seriesMemoryController.refresh,
  openAiUsageHistory,
  closeAiUsageHistory,
  isRemoteDefaultApiUrl,
  traceProviderTransition,
  setProviderTransitionPending,
});
void loadPopupSettings({
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
}).catch((error) => {
  console.error("[TextPhantom][popup] settings hydration failed", {
    errorType: String(error?.name || "Error"),
  });
  setEmojiStatus("error", "Settings could not be loaded. Reopen the popup.");
});

mountTranslationSessionStatus();
