import { normalizeUrl } from "../shared/url.js";
import { ensureApiDefaults } from "../shared/api_defaults.js";
import { AI_PROMPT_MAX_CHARS, makePromptKey, migratePromptMap, normalizeAiModel, normalizePrompt } from "../shared/prompt.js";

const MODES = [
  { id: "lens_images", name: "Google Lens (image)", needLang: true },
  { id: "lens_text", name: "Google Lens (text)", needLang: true },
];

const FALLBACK_LANGS = [
  { code: "en", name: "English" },
  { code: "th", name: "Thai" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh-CN", name: "Chinese (Simplified)" },
  { code: "vi", name: "Vietnamese" },
  { code: "es", name: "Spanish" },
  { code: "de", name: "German" },
  { code: "fr", name: "French" },
];

const FALLBACK_SOURCES = [
  { id: "original", name: "Original" },
  { id: "translated", name: "Translated" },
  { id: "ai", name: "Ai" },
];

const HEALTH_PATH = "/health";
const META_PATH = "/meta";
const AI_RESOLVE_PATH = "/ai/resolve";
const AI_PROMPT_DEFAULT_PATH = "/ai/prompt/default";
const WARMUP_PATH = "/warmup";

const HEALTH_TIMEOUT_MS = 5000;
const AI_META_TIMEOUT_MS = 8000;
const PROMPT_TIMEOUT_MS = 8000;
const WARMUP_TIMEOUT_MS = 2500;
const RETRY_DELAYS_MS = [600, 1200, 2500, 5000];

const modeSel = document.getElementById("mode");
const langSel = document.getElementById("lang");
const sourcesSel = document.getElementById("sources");
const langWrap = document.getElementById("lang-wrap");
const sourcesWrap = document.getElementById("sources-wrap");
const aiKeyWrap = document.getElementById("ai-key-wrap");
const aiKeyInput = document.getElementById("ai-key");
const aiModelWrap = document.getElementById("ai-model-wrap");
const aiModelSel = document.getElementById("ai-model");
const aiPromptWrap = document.getElementById("ai-prompt-wrap");
const aiPromptInput = document.getElementById("ai-prompt");
const aiPromptCountEl = document.getElementById("ai-prompt-count");
const aiPromptResetBtn = document.getElementById("ai-prompt-reset");
const apiInput = document.getElementById("api-url");
const emojiEl = document.getElementById("api-status-emoji");
const resetBtn = document.getElementById("reset-api");

const runStatusTextEl = document.getElementById("run-status-text");
const runProgressEl = document.querySelector(".run-progress");
const runProgressBarEl = document.getElementById("run-progress-bar");
const runStatusSubEl = document.getElementById("run-status-sub");

aiPromptResetBtn?.addEventListener("click", async () => {
  await resetPromptForLang(langSel.value);
});

let userInteractedApi = false;
let lastApiOk = false;
let lastSavedApiUrl = "";
let retryTimer = null;
let metaCache = null;
let modelDirty = false;
let aiMetaSeq = 0;
let promptSeq = 0;
let lastResolvedProvider = "";
let lastResolvedKey = "";

let desiredLang = "en";
let desiredSources = "translated";
let desiredAiModel = "auto";

let aiPromptByLangState = {};
let aiPromptDefaultsByLang = {};
let aiPromptDirtyByLang = {};

let pendingApiSave = false;
let pendingAiSave = false;
let aiResolveDebounce = null;

let apiDefaults = { defaultApiUrl: "", resetApiUrl: "", fetchedAt: 0 };

const inFlight = {
  seq: 0,
  controller: null,
};

function updatePromptCount(text = null) {
  if (!aiPromptCountEl) return;
  const s = typeof text === "string" ? text : String(aiPromptInput?.value || "");
  aiPromptCountEl.textContent = `${s.length}/${AI_PROMPT_MAX_CHARS}`;
}

function buildUrl(path, params = null) {
  const base = normalizeUrl(apiInput?.value);
  if (!base) return "";
  const u = new URL(`${base}${path}`);
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      const vv = String(v ?? "").trim();
      if (vv) u.searchParams.set(k, vv);
    }
  }
  return u.toString();
}

function setEmojiStatus(type, detail) {
  if (!emojiEl) return;
  if (type === "loading") {
    emojiEl.textContent = "⏳";
    emojiEl.title = detail || "Checking API...";
  } else if (type === "ok") {
    emojiEl.textContent = "✅";
    emojiEl.title = detail || "Online";
  } else {
    emojiEl.textContent = "❌";
    emojiEl.title = detail || "Offline / Not reachable";
  }
}

function renderBatchStatus(b) {
  if (!runStatusTextEl || !runProgressEl || !runProgressBarEl) return;
  const batch = b && typeof b === "object" ? b : null;
  const stats = batch && batch.stats && typeof batch.stats === "object" ? batch.stats : null;
  const total = Number(stats?.total) || 0;
  const finished = Number(stats?.finished) || 0;
  const msg = typeof batch?.message === "string" && batch.message ? batch.message : "Idle";
  runStatusTextEl.textContent = msg;
  const pct = total ? Math.max(0, Math.min(100, Math.round((finished / total) * 100))) : 0;
  runProgressBarEl.style.width = pct + "%";
  runProgressEl.setAttribute("aria-valuenow", String(pct));
  if (runStatusSubEl) {
    if (total) {
      const pass = Number(batch?.pass) || 1;
      const stage = typeof batch?.stage === "string" ? batch.stage : "";
      const extra = stage ? `• ${stage}` : "";
      runStatusSubEl.textContent = `pass ${pass} • ${finished}/${total} ${extra}`.trim();
    } else {
      runStatusSubEl.textContent = "";
    }
  }
}

function initRunStatus() {
  try {
    chrome.runtime.sendMessage({ type: "GET_BATCH_STATUS" }, (resp) => {
      renderBatchStatus(resp?.batch);
    });
  } catch {}

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "BATCH_STATUS_UPDATE") renderBatchStatus(msg.batch);
    });
  } catch {}
}


const warmedApi = new Set();
async function warmupApi(base) {
  const b = normalizeUrl(base);
  if (!b || warmedApi.has(b)) return;
  warmedApi.add(b);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
  try {
    await fetch(`${b}${WARMUP_PATH}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
  } finally {
    clearTimeout(timeout);
  }
}

function abortInFlight() {
  if (inFlight.controller) {
    try {
      inFlight.controller.abort();
    } catch {}
  }
  inFlight.controller = null;
}

function scheduleRetry(url, attemptIndex) {
  clearTimeout(retryTimer);
  if (attemptIndex >= RETRY_DELAYS_MS.length) return;
  const delay = RETRY_DELAYS_MS[attemptIndex];
  retryTimer = setTimeout(() => {
    if (normalizeUrl(apiInput.value) === url) checkHealth(url, attemptIndex);
  }, delay);
}

async function parseHealth(res) {
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await res.json();
  } catch {}
  try {
    const txt = await res.text();
    return { ok: /\bok\b/i.test(txt), raw: txt };
  } catch {
    return null;
  }
}

async function checkHealthOnce(url, seq) {
  const controller = new AbortController();
  inFlight.controller = controller;
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${HEALTH_PATH}`, {
      method: "GET",
      headers: { accept: "application/json, text/plain;q=0.8" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await parseHealth(res);
    if (!data || !data.ok) throw new Error("unhealthy");
    if (seq !== inFlight.seq) return false;
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkHealth(url, attemptIndex = 0) {
  const cleaned = normalizeUrl(url);
  if (!cleaned) return;
  inFlight.seq += 1;
  const seq = inFlight.seq;
  abortInFlight();
  setEmojiStatus(
    userInteractedApi ? "loading" : "loading",
    userInteractedApi ? "Checking API..." : "Waiting…",
  );
  try {
    const healthy = await checkHealthOnce(cleaned, seq);
    if (seq !== inFlight.seq) return;
    lastApiOk = healthy;
    if (healthy) {
      clearTimeout(retryTimer);
      setEmojiStatus("ok", "Online");
      warmupApi(cleaned);
      refreshMeta(cleaned);
    } else {
      setEmojiStatus("error", userInteractedApi ? "Health failed" : "Waiting…");
      scheduleRetry(cleaned, attemptIndex);
    }
  } catch (err) {
    if (seq !== inFlight.seq) return;
    lastApiOk = false;
    const msg =
      err && err.name === "AbortError"
        ? "Timed out"
        : err?.message || "Offline";
    setEmojiStatus(
      userInteractedApi ? "error" : "loading",
      userInteractedApi ? msg : "Waiting…",
    );
    scheduleRetry(cleaned, attemptIndex);
  }
}

async function fetchJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", accept: "application/json" }
        : { accept: "application/json" },
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function setSelectOptions(
  sel,
  list,
  { valueKey = "id", labelKey = "name", keepValue = "" } = {},
) {
  const prev = keepValue || sel.value || "";
  sel.innerHTML = "";
  const items = Array.isArray(list) ? list : [];
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = String(it?.[valueKey] ?? "");
    opt.textContent = String(it?.[labelKey] ?? opt.value);
    sel.appendChild(opt);
  }
  const canKeep = [...sel.options].some((o) => o.value === prev);
  if (canKeep) sel.value = prev;
}

function populateModes() {
  setSelectOptions(modeSel, MODES, {
    valueKey: "id",
    labelKey: "name",
    keepValue: modeSel.value,
  });
}

function toggleUi() {
  const modeId = modeSel.value || "lens_text";
  const isText = modeId === "lens_text";
  sourcesWrap.style.display = isText ? "" : "none";

  const source = (sourcesSel.value || "").trim() || "translated";
  const needLang = MODES.find((m) => m.id === modeId)?.needLang ?? true;
  const showLang = needLang && !(isText && source === "original");
  langWrap.style.display = showLang ? "" : "none";
  const showAi = isText && source === "ai";

  const hasEnv = Boolean(metaCache?.has_env_ai_key);
  const hasKey = (aiKeyInput.value || "").trim().length > 0;
  const canConfigureAi = hasKey || hasEnv;

  aiKeyWrap.style.display = showAi ? "" : "none";
  aiModelWrap.style.display = showAi && canConfigureAi ? "" : "none";
  aiPromptWrap.style.display = showAi && canConfigureAi ? "" : "none";
}

async function refreshMeta(baseUrl) {
  const url = `${baseUrl}${META_PATH}`;
  try {
    const data = await fetchJson(url, null, HEALTH_TIMEOUT_MS);
    if (data && data.ok) {
      metaCache = data;
      const langs =
        Array.isArray(data.languages) && data.languages.length
          ? data.languages
          : FALLBACK_LANGS;
      const sources =
        Array.isArray(data.sources) && data.sources.length
          ? data.sources
          : FALLBACK_SOURCES;
      const beforeLang = langSel.value;
      const beforeSources = sourcesSel.value;
      setSelectOptions(langSel, langs, {
        valueKey: "code",
        labelKey: "name",
        keepValue: desiredLang || beforeLang,
      });
      setSelectOptions(sourcesSel, sources, {
        valueKey: "id",
        labelKey: "name",
        keepValue: desiredSources || beforeSources,
      });

      const afterLang = langSel.value;
      const afterSources = sourcesSel.value;
      const patch = {};
      if (afterLang && afterLang !== desiredLang) {
        desiredLang = afterLang;
        patch.lang = afterLang;
      }
      if (afterSources && afterSources !== desiredSources) {
        desiredSources = afterSources;
        patch.sources = afterSources;
      }
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      toggleUi();
    }
  } catch {}
}

async function ensureAiAvailableOrFallback() {
  const modeId = modeSel.value || "lens_text";
  if (modeId !== "lens_text") return true;

  const source = (sourcesSel.value || "").trim() || "translated";
  if (source !== "ai") return true;

  const hasEnv = Boolean(metaCache?.has_env_ai_key);
  const hasKey = (aiKeyInput.value || "").trim().length > 0;
  if (hasKey || hasEnv) return true;

  toggleUi();
  return false;
}

function setModelOptions(models, { keepValue = "", strict = true } = {}) {
  const prev =
    (keepValue || aiModelSel.value || desiredAiModel || "auto").trim() ||
    "auto";
  aiModelSel.innerHTML = "";
  const base = [{ id: "auto", name: "auto" }];
  const list = (Array.isArray(models) ? models : [])
    .map((m) => ({
      id: String(m || ""),
      name: String(m || ""),
    }))
    .filter((m) => m.id)
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  const canKeep = prev && [...new Set(list.map((m) => m.id))].includes(prev);
  if (!strict && prev && prev !== "auto" && !canKeep)
    list.unshift({ id: prev, name: prev });
  for (const it of base.concat(list)) {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = it.name;
    aiModelSel.appendChild(opt);
  }
  aiModelSel.value = canKeep ? prev : "auto";
}

async function refreshAiMeta({ forcePrompt = false } = {}) {
  const modeId = modeSel.value || "lens_text";
  if (modeId !== "lens_text") return;

  const ok = await ensureAiAvailableOrFallback();
  if (!ok) return;

  const base = normalizeUrl(apiInput.value);
  if (!base) return;

  const source = (sourcesSel.value || "").trim() || "translated";
  if (source !== "ai") {
    setModelOptions([], { keepValue: "auto" });
    return;
  }

  const seq = ++aiMetaSeq;
  try {
    const lang = langSel.value || "en";
    const aiKey = (aiKeyInput.value || "").trim();
    const currentModel =
      (aiModelSel.value || "").trim() || desiredAiModel || "auto";

    const data = await fetchJson(
      `${base}${AI_RESOLVE_PATH}`,
      { api_key: aiKey, model: currentModel, lang },
      AI_META_TIMEOUT_MS,
    );
    if (seq !== aiMetaSeq) return;

    if (!data || !data.ok) {
      setModelOptions([], { keepValue: currentModel, strict: false });
      toggleUi();
      return;
    }

    const provider = String(data.provider || "").trim();
    const keyChanged = aiKey !== lastResolvedKey;
    const providerChanged = Boolean(
      lastResolvedProvider &&
      provider &&
      provider !== lastResolvedProvider &&
      keyChanged,
    );

    if (provider) lastResolvedProvider = provider;
    lastResolvedKey = aiKey;

    const models = Array.isArray(data.models) ? data.models : [];
    const preferred =
      (modelDirty
        ? (aiModelSel.value || "").trim()
        : (desiredAiModel || "").trim()) ||
      currentModel ||
      "auto";
    setModelOptions(models, { keepValue: preferred, strict: true });

    const optionValues = [...aiModelSel.options].map((o) => o.value);
    let nextModel = (aiModelSel.value || "").trim() || "auto";
    if (!optionValues.includes(nextModel) || nextModel === "") {
      const suggested = String(data.model || "").trim();
      if (suggested && optionValues.includes(suggested)) nextModel = suggested;
      else nextModel = "auto";
    } else if (
      providerChanged &&
      nextModel !== "auto" &&
      !optionValues.includes(nextModel)
    ) {
      nextModel = "auto";
    }

    if ((aiModelSel.value || "").trim() !== nextModel) aiModelSel.value = nextModel;

    if (nextModel !== currentModel) {
      desiredAiModel = nextModel;
      await chrome.storage.local.set({ aiKey, aiModel: nextModel });
    } else {
      await chrome.storage.local.set({ aiKey });
    }

    if (forcePrompt) await applyPromptForLang(lang, { forceFetch: true });

    toggleUi();
  } catch {}
}

function canUseAiUi() {
  const modeId = modeSel.value || "lens_text";
  if (modeId !== "lens_text") return false;
  const source = (sourcesSel.value || "").trim() || "translated";
  return source === "ai";
}

async function fetchDefaultPromptForLang(lang, model = 'auto') {
  const l = (lang || 'en').trim() || 'en';
  const m2 = normalizeAiModel(model);
  const url = buildUrl(AI_PROMPT_DEFAULT_PATH, { lang: l, model: m2 });
  if (!url) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROMPT_TIMEOUT_MS);
  const resp = await fetch(url, { signal: ctrl.signal }).catch(() => null);
  clearTimeout(timer);
  const data = resp ? await resp.json().catch(() => null) : null;
  const p2 = data && data.ok ? String(data.prompt_editable_default || '').trim() : '';
  return normalizePrompt(p2);
}

async function resetPromptForLang(lang) {
  if (!canUseAiUi()) return;
  const l = (lang || desiredLang || langSel.value || 'en').trim() || 'en';
  const model = normalizeAiModel(desiredAiModel);
  const key = makePromptKey(l, model);
  const seq = ++promptSeq;

  const cached = String(aiPromptDefaultsByLang[key] || '').trim();
  const def = cached ? normalizePrompt(cached) : await fetchDefaultPromptForLang(l, model);
  if (seq !== promptSeq) return;

  aiPromptDefaultsByLang[key] = def;
  aiPromptByLangState[key] = def;
  aiPromptDirtyByLang[key] = false;

  aiPromptInput.value = def;
  updatePromptCount(def);
  await chrome.storage.local.set({ aiPromptByLang: aiPromptByLangState });
  chrome.runtime.sendMessage({ type: 'AI_SETTINGS_CHANGED' });
}

async function applyPromptForLang(lang, { forceFetch = false } = {}) {
  if (!canUseAiUi()) return;
  const l = (lang || desiredLang || langSel.value || 'en').trim() || 'en';
  const model = normalizeAiModel(desiredAiModel);
  const key = makePromptKey(l, model);
  if (aiPromptDirtyByLang[key]) return;
  if (Object.prototype.hasOwnProperty.call(aiPromptByLangState, key) && !forceFetch) {
    const saved = String(aiPromptByLangState[key] || '');
    aiPromptInput.value = saved;
    updatePromptCount(saved);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(aiPromptDefaultsByLang, key) && !forceFetch) {
    const def = String(aiPromptDefaultsByLang[key] || '');
    aiPromptInput.value = def;
    updatePromptCount(def);
    return;
  }
  const def = await fetchDefaultPromptForLang(l, model);
  aiPromptDefaultsByLang[key] = def;
  aiPromptInput.value = def;
  updatePromptCount(def);
}

async function flushPromptForLang(lang, model = null) {
  if (!canUseAiUi()) return;
  const l = (lang || desiredLang || langSel.value || 'en').trim() || 'en';
  const m2 = normalizeAiModel(model || desiredAiModel);
  const key = makePromptKey(l, m2);
  if (!aiPromptDirtyByLang[key]) return;
  const prompt = normalizePrompt(String(aiPromptInput.value || ''));
  aiPromptByLangState[key] = prompt;
  aiPromptDirtyByLang[key] = false;
  await chrome.storage.local.set({ aiPromptByLang: aiPromptByLangState });
}

let debounceTimer = null;
function scheduleSaveApi(raw) {
  clearTimeout(debounceTimer);
  pendingApiSave = true;
  debounceTimer = setTimeout(async () => {
    pendingApiSave = false;
    const normalized = normalizeUrl(raw);
    if (!normalized) return;

    if (normalized === lastSavedApiUrl) {
      checkHealth(normalized);
      return;
    }

    userInteractedApi = true;
    await chrome.storage.local.set({ customApiUrl: normalized });
    lastSavedApiUrl = normalized;
    chrome.runtime.sendMessage({ type: "API_URL_CHANGED" });
    setEmojiStatus("loading", "Checking API...");
    checkHealth(normalized);
    refreshAiMeta({ forcePrompt: false });
  }, 800);
}

let aiDebounce = null;
function scheduleSaveAi() {
  clearTimeout(aiDebounce);
  pendingAiSave = true;
  aiDebounce = setTimeout(async () => {
    pendingAiSave = false;
    const modeId = modeSel.value || "lens_text";
    if (modeId !== "lens_text") {
      const aiKey = (aiKeyInput.value || "").trim();
      const aiModel = normalizeAiModel((aiModelSel.value || "").trim() || desiredAiModel || "auto");
      desiredAiModel = aiModel;
      await chrome.storage.local.set({ aiKey, aiModel });
      chrome.runtime.sendMessage({ type: "AI_SETTINGS_CHANGED" });
      return;
    }

    const source = (sourcesSel.value || "").trim() || "translated";
    const lang = desiredLang || langSel.value || "en";
    const aiKey = (aiKeyInput.value || "").trim();
    const aiModel = normalizeAiModel((aiModelSel.value || "").trim() || desiredAiModel || "auto");
    desiredAiModel = aiModel;

    const key = makePromptKey(lang, aiModel);
    if (aiPromptDirtyByLang[key]) {
      const prompt = normalizePrompt(String(aiPromptInput.value || ""));
      aiPromptByLangState[key] = prompt;
      aiPromptDirtyByLang[key] = false;
    }

    await chrome.storage.local.set({
      aiKey,
      aiModel,
      aiPromptByLang: aiPromptByLangState,
    });
    chrome.runtime.sendMessage({ type: "AI_SETTINGS_CHANGED" });
    modelDirty = true;
    toggleUi();
    if (source === "ai") refreshAiMeta({ forcePrompt: false });
  }, 400);
}

function scheduleResolveAiMeta({ immediate = false } = {}) {
  if (aiResolveDebounce) clearTimeout(aiResolveDebounce);
  const run = () => {
    if ((modeSel.value || "lens_text") !== "lens_text") return;
    if ((sourcesSel.value || "").trim() !== "ai") return;
    refreshAiMeta({ forcePrompt: false });
  };
  if (immediate) {
    run();
    return;
  }
  aiResolveDebounce = setTimeout(run, 350);
}

function handleWsStatus(status) {
  if (lastApiOk) return;
  if (status === "connected") setEmojiStatus("ok", "WS connected");
  else if (status === "connecting") setEmojiStatus("loading", "Connecting…");
  else setEmojiStatus("error", "WS disconnected");
}

async function loadSettings() {
  populateModes();
  setEmojiStatus("loading", "Initializing…");

  const stored = await chrome.storage.local.get([
    "mode",
    "lang",
    "sources",
    "customApiUrl",
    "aiKey",
    "aiModel",
    "aiPromptByLang",
  ]);

  modeSel.value = stored.mode || "lens_text";
  desiredLang =
    typeof stored.lang === "string" && stored.lang ? stored.lang : "en";
  desiredSources =
    typeof stored.sources === "string" && stored.sources
      ? stored.sources
      : "translated";
  desiredAiModel =
    typeof stored.aiModel === "string" && stored.aiModel
      ? stored.aiModel
      : "auto";

  setSelectOptions(langSel, FALLBACK_LANGS, {
    valueKey: "code",
    labelKey: "name",
    keepValue: desiredLang,
  });
  setSelectOptions(sourcesSel, FALLBACK_SOURCES, {
    valueKey: "id",
    labelKey: "name",
    keepValue: desiredSources,
  });

  langSel.value = desiredLang;
  sourcesSel.value = desiredSources;

  const storedCustom = String(stored.customApiUrl || "");
  lastSavedApiUrl = storedCustom;
  apiInput.value = storedCustom;

  if (storedCustom) userInteractedApi = true;

  const aiKey = String(stored.aiKey || "");
  aiPromptByLangState =
    stored.aiPromptByLang && typeof stored.aiPromptByLang === "object"
      ? stored.aiPromptByLang
      : {};
  const mig = migratePromptMap(aiPromptByLangState);
  aiPromptByLangState = mig.map;
  if (mig.changed) await chrome.storage.local.set({ aiPromptByLang: aiPromptByLangState });

  const key = makePromptKey(desiredLang, desiredAiModel);
  const prompt = Object.prototype.hasOwnProperty.call(aiPromptByLangState, key)
    ? String(aiPromptByLangState[key] || "")
    : "";

  aiKeyInput.value = aiKey;
  setModelOptions([], { keepValue: desiredAiModel });
  aiPromptInput.value = prompt;
  updatePromptCount(prompt);

  toggleUi();

  const initial = normalizeUrl(apiInput.value);
  if (initial) checkHealth(initial);

  ensureApiDefaults()
    .then((d) => {
      apiDefaults = d || apiDefaults;
      if (storedCustom) return;
      const def = apiDefaults.defaultApiUrl || "";
      if (!def) return;
      if (!normalizeUrl(apiInput.value)) {
        apiInput.value = def;
        checkHealth(def);
      }
    })
    .catch(() => {});

  if ((sourcesSel.value || "").trim() === "ai" && modeSel.value === "lens_text") {
    applyPromptForLang(desiredLang, { forceFetch: false }).catch(() => {});
    refreshAiMeta({ forcePrompt: false });
  }

  chrome.runtime.sendMessage({ type: "GET_API_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && typeof resp.ok === "boolean" && resp.ok) {
      lastApiOk = true;
      setEmojiStatus("ok", "Online");
    }
  });

  chrome.runtime.sendMessage({ type: "GET_WS_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && typeof resp.status === "string") handleWsStatus(resp.status);
  });
}

window.addEventListener("offline", () => {
  lastApiOk = false;
  setEmojiStatus("error", "No internet");
});
window.addEventListener("online", () => {
  if (apiInput.value) checkHealth(apiInput.value);
});

window.addEventListener("pagehide", () => {
  try {
    if (pendingApiSave) {
      const normalized = normalizeUrl(apiInput.value);
      if (normalized) chrome.storage.local.set({ customApiUrl: normalized });
    }

    const modeId = modeSel.value || "lens_text";
    const aiKey = (aiKeyInput.value || "").trim();
    const aiModel = normalizeAiModel((aiModelSel.value || "").trim() || desiredAiModel || "auto");
    desiredAiModel = aiModel;

    if (modeId === "lens_text") {
      const lang = desiredLang || langSel.value || "en";
      const key = makePromptKey(lang, aiModel);
      const needSave = pendingAiSave || Boolean(aiPromptDirtyByLang[key]);
      if (aiPromptDirtyByLang[key]) {
        const prompt = normalizePrompt(String(aiPromptInput.value || ""));
        aiPromptByLangState[key] = prompt;
        aiPromptDirtyByLang[key] = false;
      }
      if (needSave)
        chrome.storage.local.set({
          aiKey,
          aiModel,
          aiPromptByLang: aiPromptByLangState,
        });
    } else if (pendingAiSave) {
      chrome.storage.local.set({ aiKey, aiModel });
    }
  } catch {}
});

chrome.runtime.onMessage?.addListener((msg) => {
  if (msg.type === "WS_STATUS_UPDATE") handleWsStatus(msg.status);
  else if (msg.type === "API_STATUS_UPDATE") {
    if (typeof msg.ok === "boolean") {
      lastApiOk = msg.ok;
      if (msg.ok) setEmojiStatus("ok", "Online");
      else
        setEmojiStatus(
          userInteractedApi ? "error" : "loading",
          userInteractedApi ? "API unhealthy" : "Waiting…",
        );
    }
  }
});

modeSel.addEventListener("change", async () => {
  await chrome.storage.local.set({ mode: modeSel.value });
  modelDirty = false;
  toggleUi();
  await applyPromptForLang(desiredLang, { forceFetch: false });
  refreshAiMeta({ forcePrompt: false });
});

langSel.addEventListener("change", async () => {
  const prevLang = desiredLang;
  desiredLang = langSel.value || desiredLang;
  if (canUseAiUi()) await flushPromptForLang(prevLang, desiredAiModel);
  await chrome.storage.local.set({ lang: desiredLang });
  modelDirty = false;
  await applyPromptForLang(desiredLang, { forceFetch: false });
  toggleUi();
  refreshAiMeta({ forcePrompt: false });
});

sourcesSel.addEventListener("change", async () => {
  if (canUseAiUi()) await flushPromptForLang(desiredLang, desiredAiModel);
  modelDirty = false;
  const ok = await ensureAiAvailableOrFallback();
  desiredSources = sourcesSel.value || desiredSources;
  await chrome.storage.local.set({ sources: desiredSources });
  toggleUi();
  if (ok) await applyPromptForLang(desiredLang, { forceFetch: false });
  refreshAiMeta({ forcePrompt: false });
  chrome.runtime.sendMessage({ type: "AI_SETTINGS_CHANGED" });
});

apiInput.addEventListener("input", (e) => scheduleSaveApi(e.target.value));
apiInput.addEventListener("blur", (e) => scheduleSaveApi(e.target.value));

aiKeyInput.addEventListener("input", () => {
  modelDirty = false;
  scheduleSaveAi();
  scheduleResolveAiMeta();
});
aiKeyInput.addEventListener("blur", () => {
  scheduleSaveAi();
  scheduleResolveAiMeta({ immediate: true });
});

aiModelSel.addEventListener("change", async () => {
  const prevModel = desiredAiModel;
  desiredAiModel = normalizeAiModel(aiModelSel.value || prevModel);
  if (canUseAiUi()) await flushPromptForLang(desiredLang, prevModel);
  modelDirty = true;
  await applyPromptForLang(desiredLang, { forceFetch: false });
  scheduleSaveAi();
});

aiPromptInput.addEventListener("input", () => {
  const key = makePromptKey(desiredLang, desiredAiModel);
  aiPromptDirtyByLang[key] = true;
  updatePromptCount();
  scheduleSaveAi();
});
aiPromptInput.addEventListener("blur", async () => {
  const key = makePromptKey(desiredLang, desiredAiModel);
  aiPromptDirtyByLang[key] = true;
  updatePromptCount();
  await flushPromptForLang(desiredLang, desiredAiModel);
  scheduleSaveAi();
});


resetBtn.addEventListener("click", () => {
  ensureApiDefaults({ force: true }).then((d) => {
    apiDefaults = d;
    const def = apiDefaults.resetApiUrl || apiDefaults.defaultApiUrl || "";
    apiInput.value = def;
    const normalized = normalizeUrl(def);
    chrome.storage.local.set({ customApiUrl: normalized });
    lastSavedApiUrl = normalized;
    userInteractedApi = Boolean(normalized);
    setEmojiStatus("loading", "Reset to default");
    chrome.runtime.sendMessage({ type: "API_URL_CHANGED" });
    checkHealth(normalized);
    apiInput.focus();
  });
});

loadSettings();
initRunStatus();
