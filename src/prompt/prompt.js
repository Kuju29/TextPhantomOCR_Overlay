/**
 *
 * Prompt Studio — full-page editor for Provider + Model + language prompt.
 */

import { getStorage, setStorage } from "../shared/storage.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { normalizeUrl } from "../shared/url.js";
import { FALLBACK_LANGS, API_PATHS } from "../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  makeProfilePromptKey,
  migratePromptMap,
  normalizePrompt,
  promptHistoryBack,
  promptHistoryForward,
  promptHistoryPush,
  promptHistoryState,
} from "../shared/prompt.js";

const els = {
  lang: document.getElementById("ps-lang"),
  loadDefault: document.getElementById("ps-load-default"),
  clear: document.getElementById("ps-clear"),
  back: document.getElementById("ps-back"),
  forward: document.getElementById("ps-forward"),
  save: document.getElementById("ps-save"),
  text: document.getElementById("ps-text"),
  count: document.getElementById("ps-count"),
  key: document.getElementById("ps-key"),
  status: document.getElementById("ps-status"),
};

const state = {
  prompts: {},
  legacyPrompts: {},
  providerIdentity: "",
  model: "auto",
  activeLanguage: "en",
  dirty: false,
  // API base used only to fetch the built-in default style. It is taken from the
  // same setting the popup uses — this page no longer has its own URL field.
  apiUrl: "",
  apiDefaults: { defaultApiUrl: "", resetApiUrl: "", fetchedAt: 0 },
};
let saveQueue = Promise.resolve();

function promptRecord(value) {
  if (value && typeof value === "object")
    return {
      text: normalizePrompt(String(value.text || "")),
      mode: "replace",
    };
  return { text: normalizePrompt(String(value || "")), mode: "replace" };
}

function persistPromptMaps() {
  const patch = {
    aiProfilePromptsV1: { ...state.prompts },
  };
  const write = () => setStorage(patch);
  saveQueue = saveQueue.then(write, write);
  return saveQueue;
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "ps-status" + (kind ? " " + kind : "");
}

function currentKey(language = state.activeLanguage) {
  return makeProfilePromptKey(
    state.providerIdentity,
    state.model,
    language || "en",
  );
}

function updateCount() {
  const len = els.text.value.length;
  els.count.textContent = `${len.toLocaleString()} / ${AI_PROMPT_MAX_CHARS.toLocaleString()}`;
  els.count.classList.toggle("warn", len > AI_PROMPT_MAX_CHARS * 0.95);
  els.key.textContent = currentKey();
}

/** Enable/disable Back/Forward from the stored history for the current key. */
async function refreshHistoryButtons() {
  if (!els.back && !els.forward) return;
  try {
    const st = await promptHistoryState(
      currentKey(),
      String(els.text.value || ""),
    );
    if (els.back) els.back.disabled = !st.canBack;
    if (els.forward) els.forward.disabled = !st.canForward;
  } catch {
    /* history is best-effort */
  }
}

/** Load the saved prompt for the current language into the editor. */
function loadCurrent(language = els.lang.value || "en") {
  state.activeLanguage = language;
  const key = currentKey(language);
  const hasProfilePrompt = Object.prototype.hasOwnProperty.call(
    state.prompts,
    key,
  );
  const record = hasProfilePrompt
    ? promptRecord(state.prompts[key])
    : promptRecord(state.legacyPrompts[language]);
  const saved = record.text;
  if (!hasProfilePrompt && Object.hasOwn(state.legacyPrompts, language)) {
    state.prompts[key] = record;
    void setStorage({ aiProfilePromptsV1: state.prompts }).catch(() => {
      setStatus("Could not migrate this saved prompt.", "err");
    });
  }
  els.text.value = saved;
  state.dirty = false;
  updateCount();
  // Seed the history baseline (dedupes) and sync the nav buttons.
  void promptHistoryPush(key, saved).then(refreshHistoryButtons);
}

async function saveLanguage(
  language = state.activeLanguage,
  { announce = true } = {},
) {
  const key = currentKey(language);
  const value = normalizePrompt(els.text.value, AI_PROMPT_MAX_CHARS);
  state.prompts[key] = {
    text: value,
    mode: "replace",
  };
  els.text.value = value;
  state.dirty = false;
  updateCount();
  await persistPromptMaps();
  // Every save is a history version (truncates any forward branch).
  void promptHistoryPush(key, value).then(refreshHistoryButtons);
  try {
    chrome.runtime?.sendMessage?.({ type: "AI_SETTINGS_CHANGED" });
  } catch {
    /* popup may be closed */
  }
  if (announce) {
    setStatus("Saved ✓", "ok");
    setTimeout(() => setStatus(""), 1800);
  }
}

const save = () => saveLanguage(state.activeLanguage);

/** Apply a history navigation result: restore text AND save it. */
async function applyHistoryResult(res) {
  if (!res) return refreshHistoryButtons();
  const key = currentKey();
  els.text.value = res.text;
  const current = promptRecord(state.prompts[key]);
  state.prompts[key] = {
    text: normalizePrompt(res.text, AI_PROMPT_MAX_CHARS),
    mode: current.mode,
  };
  state.dirty = false;
  updateCount();
  await persistPromptMaps();
  try {
    chrome.runtime?.sendMessage?.({ type: "AI_SETTINGS_CHANGED" });
  } catch {
    /* popup may be closed */
  }
  if (els.back) els.back.disabled = !res.canBack;
  if (els.forward) els.forward.disabled = !res.canForward;
  setStatus("Restored version ✓", "ok");
  setTimeout(() => setStatus(""), 1800);
}

/** Fetch the built-in default style for the current language from the API. */
async function loadBuiltinDefault() {
  const base = String(state.apiUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    setStatus("No API URL configured (set it in the popup)", "err");
    return;
  }
  const lang = els.lang.value || "en";
  setStatus("Loading default…");
  try {
    const url = `${base}${API_PATHS.AI_PROMPT_DEFAULT}?lang=${encodeURIComponent(lang)}`;
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const def = String(data?.prompt_editable_default || "").trim();
    if (!def) throw new Error("empty default");
    els.text.value = def;
    state.dirty = true;
    updateCount();
    setStatus("Loaded built-in default (not yet saved)", "ok");
  } catch (e) {
    setStatus("Could not load default: " + (e?.message || "error"), "err");
  }
}

// init
async function init() {
  // language options
  for (const l of FALLBACK_LANGS) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    els.lang.appendChild(opt);
  }

  const stored = await getStorage([
    "aiPromptByLang",
    "aiProfilePromptsV1",
    "lang",
    "customApiUrl",
    "apiUrlDefault",
    "apiUrlReset",
  ]);
  state.apiDefaults = await ensureApiDefaults();

  const migration = migratePromptMap(
    stored.aiPromptByLang && typeof stored.aiPromptByLang === "object"
      ? stored.aiPromptByLang
      : {},
  );
  state.legacyPrompts = migration.map;
  state.prompts =
    stored.aiProfilePromptsV1 && typeof stored.aiProfilePromptsV1 === "object"
      ? { ...stored.aiProfilePromptsV1 }
      : {};

  const q = new URLSearchParams(location.search);
  state.providerIdentity = String(q.get("identity") || "").trim();
  state.model = String(q.get("model") || "auto").trim() || "auto";
  if (!state.providerIdentity) {
    setStatus(
      "Open Prompt Studio from AI options to select a Provider and Model.",
      "err",
    );
    els.save.disabled = true;
    return;
  }

  els.lang.value =
    typeof stored.lang === "string" && stored.lang ? stored.lang : "en";
  if (![...els.lang.options].some((o) => o.value === els.lang.value)) {
    els.lang.value = "en";
  }

  // API base for "Load built-in default" — reuse the popup's configured URL.
  const customApi = normalizeUrl(stored.customApiUrl || "");
  const defaultApi = normalizeUrl(
    state.apiDefaults.defaultApiUrl || stored.apiUrlDefault || "",
  );
  const resetApi = normalizeUrl(
    state.apiDefaults.resetApiUrl || stored.apiUrlReset || "",
  );
  state.apiUrl =
    customApi && customApi !== defaultApi && customApi !== resetApi
      ? customApi
      : defaultApi || resetApi || customApi || "";

  if (q.get("lang")) els.lang.value = q.get("lang");
  state.activeLanguage = els.lang.value || "en";
  const profileKey = currentKey();
  const legacyKey = els.lang.value || "en";
  if (
    !Object.hasOwn(state.prompts, profileKey) &&
    Object.hasOwn(state.legacyPrompts, legacyKey)
  ) {
    state.prompts[profileKey] = promptRecord(state.legacyPrompts[legacyKey]);
    await setStorage({ aiProfilePromptsV1: state.prompts });
  }
  loadCurrent();
}

// events
els.lang.addEventListener("change", async () => {
  const previous = state.activeLanguage;
  const next = els.lang.value || "en";
  els.lang.disabled = true;
  try {
    if (state.dirty) await saveLanguage(previous, { announce: false });
    loadCurrent(next);
  } catch (error) {
    els.lang.value = previous;
    state.dirty = true;
    setStatus(
      `Could not save ${previous}: ${error?.message || "storage error"}`,
      "err",
    );
  } finally {
    els.lang.disabled = false;
  }
});

els.text.addEventListener("input", () => {
  state.dirty = true;
  updateCount();
  // Typing makes Back available (returns to the last saved version) and
  // invalidates Forward until the edit is saved.
  if (els.back) els.back.disabled = false;
  if (els.forward) els.forward.disabled = true;
});
els.back?.addEventListener("click", async () => {
  const res = await promptHistoryBack(
    currentKey(),
    String(els.text.value || ""),
  );
  await applyHistoryResult(res);
});
els.forward?.addEventListener("click", async () => {
  const res = await promptHistoryForward(currentKey());
  await applyHistoryResult(res);
});
els.save.addEventListener("click", save);
els.loadDefault.addEventListener("click", loadBuiltinDefault);
els.clear.addEventListener("click", () => {
  els.text.value = "";
  state.dirty = true;
  updateCount();
  els.text.focus();
});

// Ctrl/Cmd+S saves.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

init();
