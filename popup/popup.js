import { normalizeUrl } from "../shared/url.js";
import { ensureApiDefaults } from "../shared/api_defaults.js";

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
const aiPromptResetBtn = document.getElementById("ai-prompt-reset");
const apiInput = document.getElementById("api-url");
const emojiEl = document.getElementById("api-status-emoji");
const resetBtn = document.getElementById("reset-api");

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
  const needLang = MODES.find((m) => m.id === modeId)?.needLang ?? true;
  langWrap.style.display = needLang ? "" : "none";

  const isText = modeId === "lens_text";
  sourcesWrap.style.display = isText ? "" : "none";

  const source = (sourcesSel.value || "").trim() || "translated";
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
      setModelOptions([], { keepValue: currentModel });
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

    if ((aiModelSel.value || "").trim() !== nextModel)
      aiModelSel.value = nextModel;
    desiredAiModel = nextModel;

    await chrome.storage.local.set({ aiKey, aiModel: nextModel });

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

async function fetchDefaultPromptForLang(lang) {
  const base = normalizeUrl(apiInput.value);
  if (!base) return "";
  const seq = ++promptSeq;
  try {
    const data = await fetchJson(
      `${base}${AI_PROMPT_DEFAULT_PATH}?lang=${encodeURIComponent(lang)}`,
      null,
      PROMPT_TIMEOUT_MS,
    );
    if (seq !== promptSeq) return "";
    return String(data?.prompt_editable_default || "").trim();
  } catch {
    return "";
  }
}

async function applyPromptForLang(lang, { forceFetch = false } = {}) {
  if (!canUseAiUi()) return;
  const key = (lang || "en").trim() || "en";
  if (aiPromptDirtyByLang[key]) return;
  if (Object.prototype.hasOwnProperty.call(aiPromptByLangState, key)) {
    aiPromptInput.value = String(aiPromptByLangState[key] || "");
    return;
  }
  if (
    !forceFetch &&
    Object.prototype.hasOwnProperty.call(aiPromptDefaultsByLang, key)
  ) {
    aiPromptInput.value = String(aiPromptDefaultsByLang[key] || "");
    return;
  }
  const prompt = await fetchDefaultPromptForLang(key);
  if (prompt) {
    aiPromptDefaultsByLang[key] = prompt;
    aiPromptInput.value = prompt;
  } else {
    aiPromptDefaultsByLang[key] = "";
    aiPromptInput.value = "";
  }
}

async function resetPromptForLang(lang) {
  if (!canUseAiUi()) return;
  const key = (lang || "en").trim() || "en";
  delete aiPromptByLangState[key];
  aiPromptDirtyByLang[key] = false;
  await chrome.storage.local.set({ aiPromptByLang: aiPromptByLangState });
  const prompt = await fetchDefaultPromptForLang(key);
  aiPromptDefaultsByLang[key] = prompt;
  aiPromptInput.value = prompt;
  scheduleSaveAi();
}

async function flushPromptForLang(lang) {
  const key = (lang || "en").trim() || "en";
  if (!aiPromptDirtyByLang[key]) return;
  const prompt = String(aiPromptInput.value || "").trim();
  if (prompt) aiPromptByLangState[key] = prompt;
  else delete aiPromptByLangState[key];
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
      const aiModel =
        (aiModelSel.value || "").trim() || desiredAiModel || "auto";
      desiredAiModel = aiModel;
      await chrome.storage.local.set({ aiKey, aiModel });
      chrome.runtime.sendMessage({ type: "AI_SETTINGS_CHANGED" });
      return;
    }

    const source = (sourcesSel.value || "").trim() || "translated";
    const lang = desiredLang || langSel.value || "en";
    const aiKey = (aiKeyInput.value || "").trim();
    const aiModel = (aiModelSel.value || "").trim() || desiredAiModel || "auto";
    desiredAiModel = aiModel;

    if (aiPromptDirtyByLang[lang]) {
      const prompt = String(aiPromptInput.value || "").trim();
      if (prompt) aiPromptByLangState[lang] = prompt;
      else delete aiPromptByLangState[lang];
      aiPromptDirtyByLang[lang] = false;
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
  const prompt = Object.prototype.hasOwnProperty.call(
    aiPromptByLangState,
    desiredLang,
  )
    ? String(aiPromptByLangState[desiredLang] || "")
    : "";

  aiKeyInput.value = aiKey;
  setModelOptions([], { keepValue: desiredAiModel });
  aiPromptInput.value = prompt;

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
    const aiModel = (aiModelSel.value || "").trim() || desiredAiModel || "auto";
    desiredAiModel = aiModel;

    if (modeId === "lens_text") {
      const lang = desiredLang || langSel.value || "en";
      const needSave = pendingAiSave || Boolean(aiPromptDirtyByLang[lang]);
      if (aiPromptDirtyByLang[lang]) {
        const prompt = String(aiPromptInput.value || "").trim();
        if (prompt) aiPromptByLangState[lang] = prompt;
        else delete aiPromptByLangState[lang];
        aiPromptDirtyByLang[lang] = false;
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
  if (canUseAiUi()) await flushPromptForLang(prevLang);
  await chrome.storage.local.set({ lang: desiredLang });
  modelDirty = false;
  await applyPromptForLang(desiredLang, { forceFetch: false });
  toggleUi();
  refreshAiMeta({ forcePrompt: false });
});

sourcesSel.addEventListener("change", async () => {
  if (canUseAiUi()) await flushPromptForLang(desiredLang);
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

aiModelSel.addEventListener("change", () => {
  modelDirty = true;
  scheduleSaveAi();
});

aiPromptInput.addEventListener("input", () => {
  aiPromptDirtyByLang[desiredLang] = true;
  scheduleSaveAi();
});
aiPromptInput.addEventListener("blur", async () => {
  aiPromptDirtyByLang[desiredLang] = true;
  await flushPromptForLang(desiredLang);
  scheduleSaveAi();
});

aiPromptResetBtn?.addEventListener("click", async () => {
  if (!canUseAiUi()) return;
  const lang = (desiredLang || langSel.value || "en").trim() || "en";
  delete aiPromptByLangState[lang];
  aiPromptDirtyByLang[lang] = false;
  await chrome.storage.local.set({ aiPromptByLang: aiPromptByLangState });
  const def = await fetchDefaultPromptForLang(lang);
  aiPromptDefaultsByLang[lang] = def;
  aiPromptInput.value = def;
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
