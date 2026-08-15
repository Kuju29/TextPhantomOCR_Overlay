/**
 *
 * Prompt Studio — a full-page editor for the per-LANGUAGE AI Style prompt.
 * It reads/writes the SAME storage the popup uses (`aiPromptByLang`, keyed by
 * language only), so edits here show up in the popup's small "AI Style" box and
 * vice-versa. This page just gives a much bigger workspace for long prompts.
 */

import { getStorage, setStorage } from "../shared/storage.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { normalizeUrl } from "../shared/url.js";
import { FALLBACK_LANGS, API_PATHS } from "../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  makePromptKey,
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
  promptByLang: {},
  // API base used only to fetch the built-in default style. It is taken from the
  // same setting the popup uses — this page no longer has its own URL field.
  apiUrl: "",
  apiDefaults: { defaultApiUrl: "", resetApiUrl: "", fetchedAt: 0 },
};

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "ps-status" + (kind ? " " + kind : "");
}

function currentKey() {
  return makePromptKey(els.lang.value || "en");
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
    const st = await promptHistoryState(currentKey(), String(els.text.value || ""));
    if (els.back) els.back.disabled = !st.canBack;
    if (els.forward) els.forward.disabled = !st.canForward;
  } catch {
    /* history is best-effort */
  }
}

/** Load the saved prompt for the current language into the editor. */
function loadCurrent() {
  const key = currentKey();
  const saved = Object.prototype.hasOwnProperty.call(state.promptByLang, key)
    ? String(state.promptByLang[key] || "")
    : "";
  els.text.value = saved;
  updateCount();
  // Seed the history baseline (dedupes) and sync the nav buttons.
  void promptHistoryPush(key, saved).then(refreshHistoryButtons);
}

async function save() {
  const key = currentKey();
  const value = normalizePrompt(els.text.value, AI_PROMPT_MAX_CHARS);
  state.promptByLang[key] = value;
  els.text.value = value;
  updateCount();
  await setStorage({ aiPromptByLang: state.promptByLang });
  // Every save is a history version (truncates any forward branch).
  void promptHistoryPush(key, value).then(refreshHistoryButtons);
  try {
    chrome.runtime?.sendMessage?.({ type: "AI_SETTINGS_CHANGED" });
  } catch {
    /* popup may be closed */
  }
  setStatus("Saved ✓", "ok");
  setTimeout(() => setStatus(""), 1800);
}

/** Apply a history navigation result: restore text AND save it. */
async function applyHistoryResult(res) {
  if (!res) return refreshHistoryButtons();
  const key = currentKey();
  els.text.value = res.text;
  state.promptByLang[key] = normalizePrompt(res.text, AI_PROMPT_MAX_CHARS);
  updateCount();
  await setStorage({ aiPromptByLang: state.promptByLang });
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
  const base = String(state.apiUrl || "").trim().replace(/\/+$/, "");
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
  state.promptByLang = migration.map;
  if (migration.changed) await setStorage({ aiPromptByLang: state.promptByLang });

  els.lang.value =
    typeof stored.lang === "string" && stored.lang ? stored.lang : "en";
  if (![...els.lang.options].some((o) => o.value === els.lang.value)) {
    els.lang.value = "en";
  }

  // API base for "Load built-in default" — reuse the popup's configured URL.
  const customApi = normalizeUrl(stored.customApiUrl || "");
  const defaultApi = normalizeUrl(state.apiDefaults.defaultApiUrl || stored.apiUrlDefault || "");
  const resetApi = normalizeUrl(state.apiDefaults.resetApiUrl || stored.apiUrlReset || "");
  state.apiUrl =
    customApi && customApi !== defaultApi && customApi !== resetApi
      ? customApi
      : defaultApi || resetApi || customApi || "";

  loadCurrent();

  // Deep-link from the popup — only the language matters now.
  const q = new URLSearchParams(location.search);
  if (q.get("lang")) els.lang.value = q.get("lang");
  loadCurrent();
}

// events
els.lang.addEventListener("change", loadCurrent);
els.text.addEventListener("input", () => {
  updateCount();
  // Typing makes Back available (returns to the last saved version) and
  // invalidates Forward until the edit is saved.
  if (els.back) els.back.disabled = false;
  if (els.forward) els.forward.disabled = true;
});
els.back?.addEventListener("click", async () => {
  const res = await promptHistoryBack(currentKey(), String(els.text.value || ""));
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
