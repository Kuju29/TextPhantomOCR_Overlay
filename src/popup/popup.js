import { normalizeUrl } from "../shared/url.js";
import { getStorage, removeStorage, setStorage as writeStorage } from "../shared/storage.js";
import { createAiProfileStorageWriter } from "./controllers/ai-profile-storage-writer.js";
const setStorage = createAiProfileStorageWriter(writeStorage, {
  onError: () => {
    state.aiProfileBlocked = true; state.aiProfileErrorCode = "AI_PROFILE_SAVE_FAILED";
    setEmojiStatus("error", "Could not save AI settings. Your edits are retained; try saving again.");
  },
  onSaved: () => {
    if (state.aiProfileErrorCode === "AI_PROFILE_SAVE_FAILED") {state.aiProfileBlocked=false;state.aiProfileErrorCode="";}
  },
});
import { ensureApiDefaults } from "../shared/api-defaults.js";
import {
  AI_USAGE_STORAGE_KEY,
  currentUsage,
  flushUsageReceiptJournal,
  persistUsageSelectionBoundary,
  usageHistoryRows,
  usageDetailedRows,
  usageToday,
  persistPricingSettings,
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
  RETRY_DELAYS_MS,
} from "./api.js";
import { createAiUsageController } from "./controllers/ai-usage-controller.js";
import { createPromptController } from "./controllers/prompt-controller.js";
import { createAiProfileController } from "./controllers/ai-profile-controller.js";
import { createFontScaleController } from "./controllers/font-scale-controller.js";
import { createLocalPickerController } from "./controllers/local-picker-controller.js";
import { createSeriesMemoryController } from "./controllers/series-memory-controller.js";
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
import { createResetDefaultsController } from "./controllers/reset-defaults-controller.js";
import { createUpdateBannerController } from "./controllers/update-banner-controller.js";
import { createPaidServiceController } from "./controllers/paid-service-controller.js";
import { createAccountLockController } from "./controllers/account-lock-controller.js";
import { createDiagnosticsController } from "./controllers/diagnostics-controller.js";
import {
  protocolLabel,
  providerLabel,
} from "./controllers/provider-model-display.js";
import { initHoverTips } from "../shared/hover-tip.js";
initHoverTips(); // 10496: option explanations on the option name (hover, focus, tap)
const state = {
  userInteractedApi: false,
  lastApiOk: false,
  lastSavedApiUrl: "",
  retryTimer: null,
  metaCache: null,
  modelDirty: false,
  aiMetaSeq: 0,
  lastAiResolve: null,
  manualModelBlock: null,
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
  localConnectSeq: 0,
  localConnectInFlight: null,
  activeAiProvider: "",
  providerTransitionPending: false,
  providerTransitionRevision: 0,
  aiProfileBlocked: false, aiModelBlocked: false,
  aiProfileErrorCode: "",
  paidActive: false, paidReady: false,
};
const usageViewController = createUsageViewController({
  els,
  state,
  isLocalProvider: isLocalAiProvider,
  getStorage,
  storageKey: AI_USAGE_STORAGE_KEY, sendMessage: sendRuntimeMessage,
  currentUsage,
  historyRows: usageHistoryRows,
  detailedRows: usageDetailedRows,
  todayUsage: usageToday,
  persistPricingSettings,
  flushUsage: flushUsageReceiptJournal,
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
  notifyBackground: (message) => void sendRuntimeMessage(message),
});
const seriesMemoryController = createSeriesMemoryController({
  els,
  state,
  getStorage,
  setStorage,
  queryTabs,
  sendMessage: sendRuntimeMessage,
});
const resetDefaultsController = createResetDefaultsController({ els,
  remove: async keys => { await setStorage.whenIdle(); await removeStorage(keys); },
  resetLive: () => sendRuntimeMessage({ type: "TP_RESET_ADAPTIVE_SCHEDULER" }) });
const updateBannerController = createUpdateBannerController({ els, getDefaults: ensureApiDefaults,
  getCurrentVersion: () => chrome.runtime.getManifest().version });
const openAiUsageHistory = usageViewController.openHistory, closeAiUsageHistory = usageViewController.closeHistory;
const openAiUsageDetailed = usageViewController.openDetailed, closeAiUsageDetailed = usageViewController.closeDetailed;

function isRemoteDefaultApiUrl(url) {
  const normalized = normalizeUrl(url);
  const remoteDefault = normalizeUrl(state.apiDefaults?.defaultApiUrl || "");
  const remoteReset = normalizeUrl(state.apiDefaults?.resetApiUrl || "");
  return Boolean(
    normalized && (normalized === remoteDefault || normalized === remoteReset),
  );
}

let apiAvailabilityGate = null;
let paidServiceController = null;
const popupUiController = createPopupUiController({
  els,
  state,
  isLocalProvider: isLocalAiProvider,
  toggleDom: toggleUiDom,
  updatePromptWarning: () => promptController.updateWarning(),
  validateAiKey: () => settingsPersistenceController.validateAiKey(),
  validateLangSource: () => settingsPersistenceController.validateLangSource(),
  applyApiAvailabilityGate: () => apiAvailabilityGate?.apply(),
  applyPaidMode: () => paidServiceController?.applyVisibility(),
});
const toggleUi = popupUiController.toggle;
paidServiceController = createPaidServiceController({
  els, state, getStorage, setStorage, toggleUi,
  onProfileContext: context => profileController.setPaidContext(context),
  beforeSwitch: () => settingsPersistenceController.flushPendingAiEditsForSwitch(state.desiredLang, state.desiredAiModel),
  onUsageSelection: async () => {
    await usageController.select(selectedUsageTarget(), selectedUsageTarget);
    await usageViewController.refreshPassive();
  },
  recheckApi: () => apiHealthController?.check(els.apiUrl?.value),
});
const traceProviderTransition = popupUiController.traceProviderTransition;
const setProviderTransitionPending =
  popupUiController.setProviderTransitionPending;


const localCapacityController = createLocalCapacityController({
  els,
  // The Local token ceiling default is the loaded context of this model.
  onRender: () => profileController.renderTokenCeiling?.(),
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
  saveProfilePrompt: (lang, text) =>
    profileController.savePrompt(lang, text),
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
  paidAvailability: (available, base, details) => paidServiceController.setAvailability(available, base, details),
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
  },
  provider: { isLocal: isLocalAiProvider, label: providerLabel, protocolLabel },
  profile: profileController,
  prompt: {
    render: applyPromptForLang,
    scheduleSave: () => settingsPersistenceController.scheduleSaveAi(),
  },
  local: {
    savedModel: localConnectionController.savedModel, showFallback: localConnectionController.showFallback,
    connect: localConnectionController.connect,
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
resetDefaultsController.bind();
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
  renderAiUsage: usageViewController.refresh,
  refreshSeriesMemory: seriesMemoryController.refresh,
  openAiUsageHistory,
  closeAiUsageHistory,
  openAiUsageDetailed,
  closeAiUsageDetailed,
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
  usageViewController,
  providerMetaController,
  apiHealthController,
  paidServiceController,
  refreshPromptHistoryButtons,
  toggleUi,
  localConnectionController,
  isRemoteDefaultApiUrl,
  canUseAiUi,
  applyPromptForLang,
}).catch((error) => {
  console.error("[TextPhantom][popup] settings hydration failed:",
    String(error?.name || "Error"), String(error?.code || ""),
    String(error?.message || "Unknown settings error"));
  setEmojiStatus("error", "Settings could not be loaded. Reopen the popup.");
});
// 10495: one account gate. Account controls are greyed while data use is not
// allowed (a click opens the consent screen); diagnostics confirm before on.
const accountLockController = createAccountLockController({
  whenReady: () => paidServiceController.whenReady?.(),
  loginProvider: () => state.loginProvider || "",
});
void accountLockController.initialize().catch(() => {});
const diagnosticsController = createDiagnosticsController({ el: els.diagnosticsUpload });
void diagnosticsController.initialize().catch(() => {});
window.addEventListener("pagehide", () => {
  accountLockController.dispose();
  diagnosticsController.dispose();
  paidServiceController.dispose();
  apiHealthController.dispose();
  apiAvailabilityGate.dispose();
}, { once: true });

void updateBannerController.refresh();
