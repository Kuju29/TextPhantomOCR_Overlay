/**
 * Popup orchestrator.
 *
 * Owns the popup's state and wires the UI: it loads settings, checks the API,
 * resolves AI provider/model/prompt, persists changes (debounced), and
 * launches the local viewer. Pure helpers live in `dom.js` (rendering) and
 * `api.js` (network).
 */

import { normalizeUrl } from "../shared/url.js";
import { resolveSeriesKey, refineSeriesKeyWithTitle } from "../shared/series.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { getStorage, setStorage } from "../shared/storage.js";
import { broadcast, sendRuntimeMessage } from "../shared/messaging.js";
import {
  MODES,
  FALLBACK_LANGS,
  FALLBACK_SOURCES,
  PINNED_LANG_CODES,
  API_PATHS,
} from "../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  makePromptKey,
  migratePromptMap,
  normalizeAiModel,
  normalizePrompt,
  promptHistoryBack,
  promptHistoryForward,
  promptHistoryPush,
  promptHistoryState,
} from "../shared/prompt.js";
import {
  filterImageFiles,
  saveLocalSession,
  sortLocalPages,
  toLocalPageRecord,
} from "../shared/local-gallery.js";
import {
  els,
  setSelectOptions,
  orderLanguages,
  setModelOptions,
  setEmojiStatus,
  updatePromptCount,
  toggleUi as toggleUiDom,
  renderBatchStatus,
} from "./dom.js";
import {
  buildUrl,
  fetchJson,
  checkHealthOnce,
  warmup,
  fetchDefaultPrompt,
  HEALTH_TIMEOUT_MS,
  AI_META_TIMEOUT_MS,
  RETRY_DELAYS_MS,
} from "./api.js";

// --- State -----------------------------------------------------------------
const state = {
  userInteractedApi: false,
  lastApiOk: false,
  lastSavedApiUrl: "",
  retryTimer: null,
  metaCache: null,
  modelDirty: false,
  aiMetaSeq: 0,
  promptSeq: 0,
  lastResolvedProvider: "",
  lastResolvedKey: "",
  desiredLang: "en",
  desiredSources: "translated",
  desiredAiModel: "auto",
  aiPromptByLang: {},
  seriesKey: "default",
  seriesMemory: { glossary: [], characters: [] },
  aiPromptDefaultsByLang: {},
  aiPromptDirtyByLang: {},
  pendingApiSave: false,
  pendingAiSave: false,
  apiDefaults: { defaultApiUrl: "", resetApiUrl: "", fetchedAt: 0 },
  healthSeq: 0,
};
let apiDebounce = null;
let aiDebounce = null;
let aiResolveDebounce = null;
const warmedApi = new Set();

function isRemoteDefaultApiUrl(url) {
  const normalized = normalizeUrl(url);
  const remoteDefault = normalizeUrl(state.apiDefaults?.defaultApiUrl || "");
  const remoteReset = normalizeUrl(state.apiDefaults?.resetApiUrl || "");
  return Boolean(normalized && (normalized === remoteDefault || normalized === remoteReset));
}

// --- Small helpers ---------------------------------------------------------
const toggleUi = () => toggleUiDom({ hasEnvKey: Boolean(state.metaCache?.has_env_ai_key) });

// Default localhost endpoints for the popular local runtimes (mirrors the
// backend PROVIDER_DEFAULTS) so picking a local provider pre-fills its URL.
const LOCAL_ENDPOINTS = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  localai: "http://localhost:8080/v1",
  jan: "http://localhost:1337/v1",
  textgen: "http://localhost:5000/v1",
  koboldcpp: "http://localhost:5001/v1",
  vllm: "http://localhost:8000/v1",
  llamafile: "http://localhost:8080/v1",
  gpt4all: "http://localhost:4891/v1",
};
function defaultEndpointFor(provider) {
  return LOCAL_ENDPOINTS[String(provider || "").trim().toLowerCase()] || "";
}
function renderSeriesMemory() {
  if (!els.aiCharactersCount) return;
  const mem = state.seriesMemory || {};
  const chars = Array.isArray(mem.characters) ? mem.characters : [];
  const terms = Array.isArray(mem.glossary) ? mem.glossary : [];
  if (!chars.length && !terms.length) {
    els.aiCharactersCount.textContent = `No memory for this series yet (${state.seriesKey})`;
    return;
  }
  const names = chars.slice(-5).map((c) => c?.name).filter(Boolean).join(", ");
  els.aiCharactersCount.textContent =
    `${state.seriesKey} — ${chars.length} character${chars.length === 1 ? "" : "s"}` +
    `${names ? ` (${names})` : ""}, ${terms.length} term${terms.length === 1 ? "" : "s"}`;
}

/** Resolve the active tab's series key + memory into state and render. */
async function refreshSeriesMemory() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    // Must match the key logic used when jobs are created (context-menu.js):
    // URL first, then refine bare host keys with the tab title.
    state.seriesKey =
      refineSeriesKeyWithTitle(await resolveSeriesKey(tab?.url || ""), tab?.title || "") ||
      "default";
  } catch {
    state.seriesKey = "default";
  }
  try {
    const store = await getStorage(["aiSeriesMemory"]);
    const all = store.aiSeriesMemory && typeof store.aiSeriesMemory === "object" ? store.aiSeriesMemory : {};
    const m = all[state.seriesKey] || {};
    state.seriesMemory = {
      glossary: Array.isArray(m.glossary) ? m.glossary : [],
      characters: Array.isArray(m.characters) ? m.characters : [],
    };
  } catch {
    state.seriesMemory = { glossary: [], characters: [] };
  }
  renderSeriesMemory();
}

/** True when the AI sub-UI is relevant (lens_text + source "ai"). */
function canUseAiUi() {
  return (els.mode.value || "lens_text") === "lens_text" && (els.sources.value || "").trim() === "ai";
}

/** Warm up an API base once per popup session. */
function warmupOnce(base) {
  const b = normalizeUrl(base);
  if (b && !warmedApi.has(b)) {
    warmedApi.add(b);
    warmup(b);
  }
}

// --- Health check ----------------------------------------------------------
function scheduleHealthRetry(url, attemptIndex) {
  clearTimeout(state.retryTimer);
  if (attemptIndex >= RETRY_DELAYS_MS.length) return;
  state.retryTimer = setTimeout(() => {
    if (normalizeUrl(els.apiUrl.value) === url) checkHealth(url, attemptIndex + 1);
  }, RETRY_DELAYS_MS[attemptIndex]);
}

async function checkHealth(url, attemptIndex = 0) {
  const cleaned = normalizeUrl(url);
  if (!cleaned) return;
  const seq = ++state.healthSeq;
  setEmojiStatus("loading", state.userInteractedApi ? "Checking API..." : "Waiting…");

  try {
    const healthy = await checkHealthOnce(cleaned);
    if (seq !== state.healthSeq) return;
    state.lastApiOk = healthy;
    if (healthy) {
      clearTimeout(state.retryTimer);
      setEmojiStatus("ok", "Online");
      warmupOnce(cleaned);
      refreshMeta(cleaned);
    } else {
      setEmojiStatus("error", state.userInteractedApi ? "Health failed" : "Waiting…");
      scheduleHealthRetry(cleaned, attemptIndex);
    }
  } catch (err) {
    if (seq !== state.healthSeq) return;
    state.lastApiOk = false;
    const msg = err?.name === "AbortError" ? "Timed out" : err?.message || "Offline";
    setEmojiStatus(state.userInteractedApi ? "error" : "loading", state.userInteractedApi ? msg : "Waiting…");
    scheduleHealthRetry(cleaned, attemptIndex);
  }
}

// --- Meta (languages / sources) -------------------------------------------
async function refreshMeta(baseUrl) {
  try {
    const data = await fetchJson(`${baseUrl}${API_PATHS.META}`, null, HEALTH_TIMEOUT_MS);
    if (!data?.ok) return;
    state.metaCache = data;

    const langs = Array.isArray(data.languages) && data.languages.length ? data.languages : FALLBACK_LANGS;
    const sources = Array.isArray(data.sources) && data.sources.length ? data.sources : FALLBACK_SOURCES;
    setSelectOptions(els.lang, orderLanguages(langs, PINNED_LANG_CODES), { valueKey: "code", labelKey: "name", keepValue: state.desiredLang });
    setSelectOptions(els.sources, sources, { valueKey: "id", labelKey: "name", keepValue: state.desiredSources });

    const patch = {};
    if (els.lang.value && els.lang.value !== state.desiredLang) {
      state.desiredLang = els.lang.value;
      patch.lang = state.desiredLang;
    }
    if (els.sources.value && els.sources.value !== state.desiredSources) {
      state.desiredSources = els.sources.value;
      patch.sources = state.desiredSources;
    }
    if (Object.keys(patch).length) await setStorage(patch);
    toggleUi();
  } catch {
    /* meta is optional */
  }
}

/** When AI is selected but no key is available, hide the AI sub-UI. */
function ensureAiAvailableOrFallback() {
  if (!canUseAiUi()) return true;
  const hasKey = (els.aiKey.value || "").trim().length > 0;
  if (hasKey || state.metaCache?.has_env_ai_key) return true;
  toggleUi();
  return false;
}

// --- AI meta (provider / model resolution) ---------------------------------
async function refreshAiMeta() {
  if ((els.mode.value || "lens_text") !== "lens_text") return;
  if (!ensureAiAvailableOrFallback()) return;

  const base = normalizeUrl(els.apiUrl.value);
  if (!base) return;
  if ((els.sources.value || "").trim() !== "ai") {
    setModelOptions([], { keepValue: "auto" });
    return;
  }

  const seq = ++state.aiMetaSeq;
  try {
    const lang = els.lang.value || "en";
    const aiKey = (els.aiKey.value || "").trim();
    const currentModel = (els.aiModel.value || "").trim() || state.desiredAiModel || "auto";

    const selectedProvider = (els.aiProvider?.value || "auto").trim();
    const selectedBaseUrl = (els.aiBaseUrl?.value || "").trim();
    const data = await fetchJson(
      `${base}${API_PATHS.AI_RESOLVE}`,
      { api_key: aiKey, model: currentModel, lang, provider: selectedProvider, base_url: selectedBaseUrl },
      AI_META_TIMEOUT_MS,
    );
    if (seq !== state.aiMetaSeq) return;

    if (!data?.ok) {
      setModelOptions([], { keepValue: currentModel, strict: false });
      toggleUi();
      return;
    }

    const provider = String(data.provider || "").trim();
    const providerChanged = Boolean(
      state.lastResolvedProvider &&
        provider &&
        provider !== state.lastResolvedProvider &&
        aiKey !== state.lastResolvedKey,
    );
    if (provider) state.lastResolvedProvider = provider;
    state.lastResolvedKey = aiKey;

    const models = Array.isArray(data.models) ? data.models : [];
    let preferred =
      (state.modelDirty ? (els.aiModel.value || "").trim() : (state.desiredAiModel || "").trim()) ||
      currentModel ||
      "auto";
    // When the user has explicitly pinned a model, never drop it just because
    // the /ai/resolve model list happens to omit it (some providers don't
    // enumerate every model). Keep it as a selectable option so it survives —
    // otherwise the selection silently resets to "auto" on each refresh.
    let userPinned = Boolean(preferred && preferred !== "auto");
    // EXCEPTION: the server says this exact model was retired/replaced (e.g.
    // a stored gemini-2.0-flash after Google shut the 2.0 family down). Adopt
    // the replacement so the UI shows what actually runs, and tell the user
    // instead of silently answering with a different model.
    const requestedModel = String(data.requested_model || "").trim();
    const remapped = Boolean(data.model_remapped) && requestedModel && requestedModel === preferred && data.model;
    if (remapped) {
      preferred = String(data.model).trim();
      userPinned = true;
      setEmojiStatus("ok", `Model ${requestedModel} was retired → using ${preferred}`);
    }
    setModelOptions(models, { keepValue: preferred, strict: !userPinned });

    const optionValues = [...els.aiModel.options].map((o) => o.value);
    let nextModel = (els.aiModel.value || "").trim() || "auto";
    if (!optionValues.includes(nextModel) || nextModel === "") {
      const suggested = String(data.model || "").trim();
      nextModel = suggested && optionValues.includes(suggested) ? suggested : "auto";
    } else if (providerChanged && nextModel !== "auto" && !optionValues.includes(nextModel)) {
      nextModel = "auto";
    }
    if ((els.aiModel.value || "").trim() !== nextModel) els.aiModel.value = nextModel;

    if (nextModel !== currentModel) {
      state.desiredAiModel = nextModel;
      await setStorage({ aiKey, aiModel: nextModel });
    } else {
      await setStorage({ aiKey });
    }
    toggleUi();
  } catch {
    /* resolve is optional */
  }
}

function scheduleResolveAiMeta({ immediate = false } = {}) {
  clearTimeout(aiResolveDebounce);
  const run = () => {
    if ((els.mode.value || "lens_text") === "lens_text" && (els.sources.value || "").trim() === "ai") {
      refreshAiMeta();
    }
  };
  if (immediate) run();
  else aiResolveDebounce = setTimeout(run, 350);
}

// --- AI prompt (per language/model) ---------------------------------------

/** Enable/disable the prompt back/forward buttons from the stored history. */
async function refreshPromptHistoryButtons() {
  if (!els.aiPromptBack && !els.aiPromptForward) return;
  try {
    const key = makePromptKey(state.desiredLang, state.desiredAiModel);
    const st = await promptHistoryState(key, String(els.aiPrompt.value || ""));
    if (els.aiPromptBack) els.aiPromptBack.disabled = !st.canBack;
    if (els.aiPromptForward) els.aiPromptForward.disabled = !st.canForward;
  } catch {
    /* history is best-effort */
  }
}

/** Apply a history navigation result to the editor + storage. */
async function applyPromptHistoryResult(key, res) {
  if (!res) return;
  els.aiPrompt.value = res.text;
  state.aiPromptByLang[key] = normalizePrompt(res.text);
  state.aiPromptDirtyByLang[key] = false;
  updatePromptCount(AI_PROMPT_MAX_CHARS, res.text);
  await setStorage({ aiPromptByLang: state.aiPromptByLang });
  broadcast({ type: "AI_SETTINGS_CHANGED" });
  if (els.aiPromptBack) els.aiPromptBack.disabled = !res.canBack;
  if (els.aiPromptForward) els.aiPromptForward.disabled = !res.canForward;
}

async function applyPromptForLang(lang, { forceFetch = false } = {}) {
  if (!canUseAiUi()) return;
  const l = (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
  const key = makePromptKey(l, normalizeAiModel(state.desiredAiModel));
  if (state.aiPromptDirtyByLang[key]) return;

  if (!forceFetch && Object.prototype.hasOwnProperty.call(state.aiPromptByLang, key)) {
    const saved = String(state.aiPromptByLang[key] || "");
    els.aiPrompt.value = saved;
    updatePromptCount(AI_PROMPT_MAX_CHARS, saved);
    // Seed the edit history with the loaded baseline so the first Back after
    // an edit can return to it (push dedupes identical tips).
    void promptHistoryPush(key, saved).then(refreshPromptHistoryButtons);
    return;
  }
  if (!forceFetch && Object.prototype.hasOwnProperty.call(state.aiPromptDefaultsByLang, key)) {
    const def = String(state.aiPromptDefaultsByLang[key] || "");
    els.aiPrompt.value = def;
    updatePromptCount(AI_PROMPT_MAX_CHARS, def);
    return;
  }

  const def = await fetchDefaultPrompt(els.apiUrl.value, l, state.desiredAiModel);
  state.aiPromptDefaultsByLang[key] = def;
  els.aiPrompt.value = def;
  updatePromptCount(AI_PROMPT_MAX_CHARS, def);
}

async function resetPromptForLang(lang) {
  if (!canUseAiUi()) return;
  const l = (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
  const model = normalizeAiModel(state.desiredAiModel);
  const key = makePromptKey(l, model);
  const seq = ++state.promptSeq;

  const cached = String(state.aiPromptDefaultsByLang[key] || "").trim();
  const def = cached ? normalizePrompt(cached) : await fetchDefaultPrompt(els.apiUrl.value, l, model);
  if (seq !== state.promptSeq) return;

  state.aiPromptDefaultsByLang[key] = def;
  state.aiPromptByLang[key] = def;
  state.aiPromptDirtyByLang[key] = false;
  els.aiPrompt.value = def;
  updatePromptCount(AI_PROMPT_MAX_CHARS, def);
  await setStorage({ aiPromptByLang: state.aiPromptByLang });
  broadcast({ type: "AI_SETTINGS_CHANGED" });
  void promptHistoryPush(key, def).then(refreshPromptHistoryButtons);
}

/** Persist the in-textarea prompt for (lang, model) if it was edited. */
async function flushPromptForLang(lang, model = null) {
  if (!canUseAiUi()) return;
  const l = (lang || state.desiredLang || els.lang.value || "en").trim() || "en";
  const key = makePromptKey(l, normalizeAiModel(model || state.desiredAiModel));
  if (!state.aiPromptDirtyByLang[key]) return;
  state.aiPromptByLang[key] = normalizePrompt(String(els.aiPrompt.value || ""));
  state.aiPromptDirtyByLang[key] = false;
  await setStorage({ aiPromptByLang: state.aiPromptByLang });
  // Each saved edit becomes a history version (browser-like: truncates any
  // forward branch left over from earlier Back navigation).
  void promptHistoryPush(key, state.aiPromptByLang[key]).then(refreshPromptHistoryButtons);
}

// --- Debounced persistence -------------------------------------------------
function scheduleSaveApi(raw) {
  clearTimeout(apiDebounce);
  state.pendingApiSave = true;
  apiDebounce = setTimeout(async () => {
    state.pendingApiSave = false;
    const normalized = normalizeUrl(raw);

    // Empty field, or the same value as the remote default/reset URL, means
    // "use REMOTE_DEFAULTS_URL". Do not store that value as customApiUrl,
    // otherwise future remote changes are hidden by the copied custom value.
    if (!normalized || isRemoteDefaultApiUrl(normalized)) {
      const effective = normalized || normalizeUrl(state.apiDefaults?.defaultApiUrl || "");
      await setStorage({ customApiUrl: "" });
      state.lastSavedApiUrl = "";
      state.userInteractedApi = false;
      broadcast({ type: "API_URL_CHANGED" });
      if (effective) {
        setEmojiStatus("loading", "Checking API...");
        checkHealth(effective);
        refreshAiMeta();
      }
      return;
    }

    if (normalized === state.lastSavedApiUrl) {
      checkHealth(normalized);
      return;
    }
    state.userInteractedApi = true;
    await setStorage({ customApiUrl: normalized });
    state.lastSavedApiUrl = normalized;
    broadcast({ type: "API_URL_CHANGED" });
    setEmojiStatus("loading", "Checking API...");
    checkHealth(normalized);
    refreshAiMeta();
  }, 800);
}

function scheduleSaveAi() {
  clearTimeout(aiDebounce);
  state.pendingAiSave = true;
  aiDebounce = setTimeout(async () => {
    state.pendingAiSave = false;
    const aiKey = (els.aiKey.value || "").trim();
    const aiModel = normalizeAiModel((els.aiModel.value || "").trim() || state.desiredAiModel || "auto");
    state.desiredAiModel = aiModel;

    if ((els.mode.value || "lens_text") !== "lens_text") {
      await setStorage({ aiKey, aiModel });
      broadcast({ type: "AI_SETTINGS_CHANGED" });
      return;
    }

    const lang = state.desiredLang || els.lang.value || "en";
    const key = makePromptKey(lang, aiModel);
    if (state.aiPromptDirtyByLang[key]) {
      state.aiPromptByLang[key] = normalizePrompt(String(els.aiPrompt.value || ""));
      state.aiPromptDirtyByLang[key] = false;
    }
    await setStorage({ aiKey, aiModel, aiPromptByLang: state.aiPromptByLang });
    broadcast({ type: "AI_SETTINGS_CHANGED" });
    state.modelDirty = true;
    toggleUi();
    if ((els.sources.value || "").trim() === "ai") refreshAiMeta();
  }, 400);
}

// --- Local viewer ----------------------------------------------------------
async function openLocalViewerFromFiles(fileList, sourceLabel) {
  const images = filterImageFiles(fileList);
  if (!images.length) return;
  const session = await saveLocalSession({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    title: sourceLabel,
    pages: sortLocalPages(images.map((file, i) => toLocalPageRecord(file, i))),
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`viewer/viewer.html?sid=${encodeURIComponent(session.id)}`),
  });
  window.close();
}

async function handleLocalPickerChange(input, sourceLabel) {
  const files = [...(input?.files || [])];
  if (input) input.value = "";
  await openLocalViewerFromFiles(files, sourceLabel);
}

// --- WebSocket status (popup just reflects it in the emoji) ---------------
function handleWsStatus(status) {
  if (state.lastApiOk) return;
  if (status === "connected") setEmojiStatus("ok", "WS connected");
  else if (status === "connecting") setEmojiStatus("loading", "Connecting…");
  else setEmojiStatus("error", "WS disconnected");
}

// --- Run-status panel ------------------------------------------------------
function initRunStatus() {
  sendRuntimeMessage({ type: "GET_BATCH_STATUS" }).then((resp) => renderBatchStatus(resp?.batch));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "BATCH_STATUS_UPDATE") renderBatchStatus(msg.batch);
  });
}

// --- Initial load ----------------------------------------------------------
async function loadSettings() {
  setSelectOptions(els.mode, MODES, { valueKey: "id", labelKey: "name", keepValue: els.mode.value });
  setEmojiStatus("loading", "Initializing…");

  const stored = await getStorage([
    "mode",
    "lang",
    "sources",
    "customApiUrl",
    "aiKey",
    "aiModel",
    "aiProvider",
    "aiBaseUrl",
    "aiCharMemory",
    "aiSendImage",
    "aiPageImage",
    "aiThinking",
    "aiPromptByLang",
    "fontScale",
  ]);

  renderFontScale(stored.fontScale ?? 1);

  els.mode.value = stored.mode || "lens_text";
  state.desiredLang = typeof stored.lang === "string" && stored.lang ? stored.lang : "en";
  state.desiredSources =
    typeof stored.sources === "string" && stored.sources ? stored.sources : "translated";
  state.desiredAiModel =
    typeof stored.aiModel === "string" && stored.aiModel ? stored.aiModel : "auto";

  setSelectOptions(els.lang, orderLanguages(FALLBACK_LANGS, PINNED_LANG_CODES), { valueKey: "code", labelKey: "name", keepValue: state.desiredLang });
  setSelectOptions(els.sources, FALLBACK_SOURCES, { valueKey: "id", labelKey: "name", keepValue: state.desiredSources });
  els.lang.value = state.desiredLang;
  els.sources.value = state.desiredSources;

  const storedCustom = String(stored.customApiUrl || "");
  state.lastSavedApiUrl = storedCustom;
  els.apiUrl.value = storedCustom;
  if (storedCustom) state.userInteractedApi = true;

  // Prompt map (migrate the legacy shape if needed).
  const migration = migratePromptMap(
    stored.aiPromptByLang && typeof stored.aiPromptByLang === "object" ? stored.aiPromptByLang : {},
  );
  state.aiPromptByLang = migration.map;
  if (migration.changed) await setStorage({ aiPromptByLang: state.aiPromptByLang });

  const promptKey = makePromptKey(state.desiredLang, state.desiredAiModel);
  els.aiKey.value = String(stored.aiKey || "");
  // Restore AI provider + local endpoint + translation memory.
  if (els.aiProvider) els.aiProvider.value = String(stored.aiProvider || "auto");
  if (els.aiBaseUrl) {
    els.aiBaseUrl.value = String(stored.aiBaseUrl || "");
    if (!els.aiBaseUrl.value) els.aiBaseUrl.value = defaultEndpointFor(els.aiProvider?.value || "auto");
  }
  void refreshSeriesMemory();
  if (els.aiCharMemory) els.aiCharMemory.checked = stored.aiCharMemory !== false;
  // AI thinking mode — "default" = think normally, "off" = fastest.
  if (els.aiThinking) {
    els.aiThinking.value = stored.aiThinking === "off" ? "off" : "default";
  }
  if (els.aiPageImage) {
    els.aiPageImage.checked =
      stored.aiPageImage === "always" ||
      (stored.aiPageImage == null && Boolean(stored.aiSendImage));
  }
  // Keep the stored model selectable before the model list is fetched, so a
  // pinned model isn't briefly shown as "auto" on popup open.
  setModelOptions([], {
    keepValue: state.desiredAiModel,
    strict: !(state.desiredAiModel && state.desiredAiModel !== "auto"),
  });
  const prompt = Object.prototype.hasOwnProperty.call(state.aiPromptByLang, promptKey)
    ? String(state.aiPromptByLang[promptKey] || "")
    : "";
  els.aiPrompt.value = prompt;
  updatePromptCount(AI_PROMPT_MAX_CHARS, prompt);
  void promptHistoryPush(promptKey, prompt).then(refreshPromptHistoryButtons);

  toggleUi();

  if (normalizeUrl(els.apiUrl.value)) checkHealth(els.apiUrl.value);

  // Fill in a default API URL from the remote config if none is set.
  // Also repair older installs where Reset copied the remote URL into
  // customApiUrl; that copied value would otherwise block future remote changes.
  ensureApiDefaults()
    .then(async (d) => {
      state.apiDefaults = d || state.apiDefaults;
      const def = normalizeUrl(state.apiDefaults.defaultApiUrl || "");
      const storedCustomNorm = normalizeUrl(storedCustom);

      if (storedCustomNorm && isRemoteDefaultApiUrl(storedCustomNorm)) {
        await setStorage({ customApiUrl: "" });
        state.lastSavedApiUrl = "";
        state.userInteractedApi = false;
        els.apiUrl.value = def || storedCustomNorm;
        checkHealth(els.apiUrl.value);
        return;
      }

      if (storedCustomNorm) return;
      if (def && !normalizeUrl(els.apiUrl.value)) {
        els.apiUrl.value = def;
        checkHealth(def);
      }
    })
    .catch(() => {});

  if (canUseAiUi()) {
    applyPromptForLang(state.desiredLang).catch(() => {});
    refreshAiMeta();
  }

  sendRuntimeMessage({ type: "GET_API_STATUS" }).then((resp) => {
    if (resp?.ok) {
      state.lastApiOk = true;
      setEmojiStatus("ok", "Online");
    }
  });
  sendRuntimeMessage({ type: "GET_WS_STATUS" }).then((resp) => {
    if (resp && typeof resp.status === "string") handleWsStatus(resp.status);
  });
}

// --- Font-scale control ----------------------------------------------------
//
// The popup writes a single `fontScale` number (1.0 = 100%) to extension
// storage; `overlay.js` reads that on mount and on every `storage.onChanged`,
// applying it as the CSS variable `--tp-font-scale` on `.tp-ol-scope`.  Every
// `.tp-line` in the overlay inherits the scale through `calc(var(...) * Npx)`
// — see `backend/render/tp_html.py:overlay_css`.
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 2.0;
const FONT_SCALE_STEP = 0.1;

/**
 * Coerce any input to a finite scale clamped to [MIN, MAX].
 * Accepts numbers (e.g. 1.2) or percent strings (e.g. "120").
 * @param {unknown} v
 * @returns {number}
 */
function clampFontScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
}

/**
 * Sync the on-screen slider/label/value from a scale (e.g. 1.2) without
 * triggering an `input` event.
 * @param {number} scale
 */
function renderFontScale(scale) {
  const s = clampFontScale(scale);
  const pct = Math.round(s * 100);
  if (els.fontScaleRange) els.fontScaleRange.value = String(pct);
  if (els.fontScaleValue) els.fontScaleValue.textContent = `${pct}%`;
}

let fontScaleDebounce = null;

/**
 * Persist the scale and broadcast to content scripts (debounced so dragging
 * the slider doesn't spam storage).
 * @param {number} scale
 */
function saveFontScale(scale) {
  const s = clampFontScale(scale);
  clearTimeout(fontScaleDebounce);
  fontScaleDebounce = setTimeout(async () => {
    await setStorage({ fontScale: s });
    broadcast({ type: "FONT_SCALE_CHANGED", fontScale: s });
  }, 150);
}

function applyFontScaleDelta(delta) {
  const current = els.fontScaleRange ? Number(els.fontScaleRange.value) / 100 : 1;
  const next = clampFontScale(current + delta);
  renderFontScale(next);
  saveFontScale(next);
}

els.fontScaleRange?.addEventListener("input", (e) => {
  const scale = Number(e.target.value) / 100;
  renderFontScale(scale);
  saveFontScale(scale);
});

els.fontScaleDown?.addEventListener("click", () => applyFontScaleDelta(-FONT_SCALE_STEP));
els.fontScaleUp?.addEventListener("click", () => applyFontScaleDelta(+FONT_SCALE_STEP));
els.fontScaleReset?.addEventListener("click", () => {
  renderFontScale(1);
  saveFontScale(1);
});

// --- Event wiring ----------------------------------------------------------
els.aiPromptReset?.addEventListener("click", () => resetPromptForLang(els.lang.value));

// Expand / collapse the style editor for comfortable long-prompt editing.
els.aiPromptStudio?.addEventListener("click", () => {
  const lang = encodeURIComponent(els.lang.value || "en");
  const model = encodeURIComponent((els.aiModel.value || "auto").trim() || "auto");
  chrome.tabs?.create?.({
    url: chrome.runtime.getURL(`prompt/prompt.html?lang=${lang}&model=${model}`),
  });
});

els.aiPromptExpand?.addEventListener("click", () => {
  const ta = els.aiPrompt;
  if (!ta) return;
  const expanded = ta.classList.toggle("expanded");
  els.aiPromptExpand.setAttribute("aria-pressed", expanded ? "true" : "false");
  els.aiPromptExpand.title = expanded ? "Collapse editor" : "Expand editor";
  els.aiPromptExpand.textContent = expanded ? "⤡" : "⤢";
  if (expanded) ta.focus();
});

els.mode.addEventListener("change", async () => {
  await setStorage({ mode: els.mode.value });
  state.modelDirty = false;
  toggleUi();
  await applyPromptForLang(state.desiredLang);
  refreshAiMeta();
});

els.lang.addEventListener("change", async () => {
  const prevLang = state.desiredLang;
  state.desiredLang = els.lang.value || state.desiredLang;
  if (canUseAiUi()) await flushPromptForLang(prevLang, state.desiredAiModel);
  await setStorage({ lang: state.desiredLang });
  state.modelDirty = false;
  await applyPromptForLang(state.desiredLang);
  toggleUi();
  refreshAiMeta();
});

els.sources.addEventListener("change", async () => {
  if (canUseAiUi()) await flushPromptForLang(state.desiredLang, state.desiredAiModel);
  state.modelDirty = false;
  const ok = ensureAiAvailableOrFallback();
  state.desiredSources = els.sources.value || state.desiredSources;
  await setStorage({ sources: state.desiredSources });
  toggleUi();
  if (ok) await applyPromptForLang(state.desiredLang);
  refreshAiMeta();
  broadcast({ type: "AI_SETTINGS_CHANGED" });
});

els.apiUrl.addEventListener("input", (e) => scheduleSaveApi(e.target.value));
els.apiUrl.addEventListener("blur", (e) => scheduleSaveApi(e.target.value));

els.aiKey.addEventListener("input", () => {
  state.modelDirty = false;
  scheduleSaveAi();
  scheduleResolveAiMeta();
});
els.aiKey.addEventListener("blur", () => {
  scheduleSaveAi();
  scheduleResolveAiMeta({ immediate: true });
});

els.aiProvider?.addEventListener("change", async () => {
  const provider = (els.aiProvider.value || "auto").trim();
  // Pre-fill the local endpoint when a local provider is picked and the field
  // is empty (or still holds another provider's default).
  const def = defaultEndpointFor(provider);
  if (def && els.aiBaseUrl) {
    const cur = (els.aiBaseUrl.value || "").trim();
    const isAnyDefault = Object.values(LOCAL_ENDPOINTS).includes(cur);
    if (!cur || isAnyDefault) els.aiBaseUrl.value = def;
  }
  await setStorage({ aiProvider: provider, aiBaseUrl: (els.aiBaseUrl?.value || "").trim() });
  toggleUi();
  scheduleResolveAiMeta({ immediate: true });
});

els.aiBaseUrl?.addEventListener("input", () => {
  clearTimeout(aiDebounce);
  aiDebounce = setTimeout(async () => {
    await setStorage({ aiBaseUrl: (els.aiBaseUrl.value || "").trim() });
    scheduleResolveAiMeta();
  }, 400);
});
els.aiBaseUrl?.addEventListener("blur", async () => {
  await setStorage({ aiBaseUrl: (els.aiBaseUrl.value || "").trim() });
  scheduleResolveAiMeta({ immediate: true });
});

els.aiCharactersClear?.addEventListener("click", async () => {
  // Clear only the ACTIVE series' memory (characters + terms).
  try {
    const store = await getStorage(["aiSeriesMemory"]);
    const all = store.aiSeriesMemory && typeof store.aiSeriesMemory === "object" ? { ...store.aiSeriesMemory } : {};
    delete all[state.seriesKey];
    await setStorage({ aiSeriesMemory: all });
  } catch {
    /* best-effort */
  }
  state.seriesMemory = { glossary: [], characters: [] };
  renderSeriesMemory();
});

els.aiPageImage?.addEventListener("change", async () => {
  await setStorage({ aiPageImage: els.aiPageImage.checked ? "always" : "off" });
});

els.aiThinking?.addEventListener("change", async () => {
  await setStorage({ aiThinking: els.aiThinking.value === "off" ? "off" : "default" });
});

els.aiCharMemory?.addEventListener("change", async () => {
  await setStorage({ aiCharMemory: Boolean(els.aiCharMemory.checked) });
});

els.aiModel.addEventListener("change", async () => {
  const prevModel = state.desiredAiModel;
  state.desiredAiModel = normalizeAiModel(els.aiModel.value || prevModel);
  if (canUseAiUi()) await flushPromptForLang(state.desiredLang, prevModel);
  state.modelDirty = true;
  await applyPromptForLang(state.desiredLang);
  scheduleSaveAi();
});

els.aiPrompt.addEventListener("input", () => {
  state.aiPromptDirtyByLang[makePromptKey(state.desiredLang, state.desiredAiModel)] = true;
  updatePromptCount(AI_PROMPT_MAX_CHARS);
  // Typing makes Back available (returns to the last saved version) and
  // invalidates Forward — cheap sync toggle, no storage read per keystroke.
  if (els.aiPromptBack) els.aiPromptBack.disabled = false;
  if (els.aiPromptForward) els.aiPromptForward.disabled = true;
  scheduleSaveAi();
});

els.aiPromptBack?.addEventListener("click", async () => {
  const key = makePromptKey(state.desiredLang, state.desiredAiModel);
  const res = await promptHistoryBack(key, String(els.aiPrompt.value || ""));
  if (res) await applyPromptHistoryResult(key, res);
  else await refreshPromptHistoryButtons();
});

els.aiPromptForward?.addEventListener("click", async () => {
  const key = makePromptKey(state.desiredLang, state.desiredAiModel);
  const res = await promptHistoryForward(key);
  if (res) await applyPromptHistoryResult(key, res);
  else await refreshPromptHistoryButtons();
});
els.aiPrompt.addEventListener("blur", async () => {
  state.aiPromptDirtyByLang[makePromptKey(state.desiredLang, state.desiredAiModel)] = true;
  updatePromptCount(AI_PROMPT_MAX_CHARS);
  await flushPromptForLang(state.desiredLang, state.desiredAiModel);
  scheduleSaveAi();
});

els.openLocalImages?.addEventListener("click", () => {
  if (els.localImagesInput) els.localImagesInput.value = "";
  els.localImagesInput?.click();
});
els.openLocalFolder?.addEventListener("click", () => {
  if (els.localFolderInput) els.localFolderInput.value = "";
  els.localFolderInput?.click();
});
els.localImagesInput?.addEventListener("change", () => handleLocalPickerChange(els.localImagesInput, "images"));
els.localFolderInput?.addEventListener("change", () => handleLocalPickerChange(els.localFolderInput, "folder"));

els.resetApi.addEventListener("click", () => {
  setEmojiStatus("loading", "Fetching remote default...");
  ensureApiDefaults({ force: true }).then((d) => {
    state.apiDefaults = d || state.apiDefaults;
    const def = state.apiDefaults.resetApiUrl || state.apiDefaults.defaultApiUrl || "";
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
      checkHealth(normalized);
    } else {
      setEmojiStatus("error", "Remote default unavailable");
    }
    els.apiUrl.focus();
  }).catch(() => {
    setEmojiStatus("error", "Could not fetch remote default");
  });
});

// Save anything still pending when the popup closes.
window.addEventListener("pagehide", () => {
  try {
    if (state.pendingApiSave) {
      const normalized = normalizeUrl(els.apiUrl.value);
      if (!normalized || isRemoteDefaultApiUrl(normalized)) setStorage({ customApiUrl: "" });
      else setStorage({ customApiUrl: normalized });
    }
    const aiKey = (els.aiKey.value || "").trim();
    const aiModel = normalizeAiModel((els.aiModel.value || "").trim() || state.desiredAiModel || "auto");
    if ((els.mode.value || "lens_text") === "lens_text") {
      const key = makePromptKey(state.desiredLang || els.lang.value || "en", aiModel);
      const dirty = state.aiPromptDirtyByLang[key];
      if (dirty) {
        state.aiPromptByLang[key] = normalizePrompt(String(els.aiPrompt.value || ""));
        state.aiPromptDirtyByLang[key] = false;
      }
      if (state.pendingAiSave || dirty) {
        setStorage({ aiKey, aiModel, aiPromptByLang: state.aiPromptByLang });
      }
    } else if (state.pendingAiSave) {
      setStorage({ aiKey, aiModel });
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
  // Prompt Studio (separate tab) edits the same aiPromptByLang map — keep the
  // popup's in-memory copy + textarea in sync when it changes elsewhere.
  if (changes.aiPromptByLang) {
    const next = changes.aiPromptByLang.newValue;
    state.aiPromptByLang = next && typeof next === "object" ? next : {};
    if (canUseAiUi()) applyPromptForLang(els.lang.value, { forceFetch: false });
  }
});

window.addEventListener("offline", () => {
  state.lastApiOk = false;
  setEmojiStatus("error", "No internet");
});
window.addEventListener("online", () => {
  if (els.apiUrl.value) checkHealth(els.apiUrl.value);
});

chrome.runtime.onMessage?.addListener((msg) => {
  if (msg?.type === "WS_STATUS_UPDATE") handleWsStatus(msg.status);
});

// --- Go --------------------------------------------------------------------
loadSettings();
initRunStatus();
