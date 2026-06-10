/**
 * Prompt Studio — a full-page editor for the per-(language, model) AI Style
 * prompt.  It reads/writes the SAME storage the popup uses
 * (`aiPromptByLang` keyed by `lang::model`), so edits here show up in the
 * popup's small "AI Style" box and vice-versa.  This page just gives a much
 * bigger workspace for long prompts.
 */

import { getStorage, setStorage } from "../shared/storage.js";
import { FALLBACK_LANGS, API_PATHS } from "../shared/constants.js";
import {
  AI_PROMPT_MAX_CHARS,
  makePromptKey,
  migratePromptMap,
  normalizeAiModel,
  normalizePrompt,
} from "../shared/prompt.js";

const els = {
  lang: document.getElementById("ps-lang"),
  model: document.getElementById("ps-model"),
  api: document.getElementById("ps-api"),
  loadDefault: document.getElementById("ps-load-default"),
  clear: document.getElementById("ps-clear"),
  save: document.getElementById("ps-save"),
  text: document.getElementById("ps-text"),
  count: document.getElementById("ps-count"),
  key: document.getElementById("ps-key"),
  status: document.getElementById("ps-status"),
};

const state = {
  promptByLang: {},
  apiUrl: "",
};

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "ps-status" + (kind ? " " + kind : "");
}

function currentKey() {
  return makePromptKey(els.lang.value || "en", normalizeAiModel(els.model.value));
}

function updateCount() {
  const len = els.text.value.length;
  els.count.textContent = `${len.toLocaleString()} / ${AI_PROMPT_MAX_CHARS.toLocaleString()}`;
  els.count.classList.toggle("warn", len > AI_PROMPT_MAX_CHARS * 0.95);
  els.key.textContent = currentKey().replace("::", " · ");
}

/** Load the saved prompt for the current (lang, model) into the editor. */
function loadCurrent() {
  const key = currentKey();
  const saved = Object.prototype.hasOwnProperty.call(state.promptByLang, key)
    ? String(state.promptByLang[key] || "")
    : "";
  els.text.value = saved;
  updateCount();
}

async function save() {
  const key = currentKey();
  const value = normalizePrompt(els.text.value, AI_PROMPT_MAX_CHARS);
  state.promptByLang[key] = value;
  els.text.value = value;
  updateCount();
  await setStorage({ aiPromptByLang: state.promptByLang });
  try {
    chrome.runtime?.sendMessage?.({ type: "AI_SETTINGS_CHANGED" });
  } catch {
    /* popup may be closed */
  }
  setStatus("Saved ✓", "ok");
  setTimeout(() => setStatus(""), 1800);
}

/** Fetch the built-in default style for the current language from the API. */
async function loadBuiltinDefault() {
  const base = String(els.api.value || "").trim().replace(/\/+$/, "");
  if (!base) {
    setStatus("Set the API URL first", "err");
    return;
  }
  const lang = els.lang.value || "en";
  setStatus("Loading default…");
  try {
    const url = `${base}${API_PATHS.AI_PROMPT_DEFAULT}?lang=${encodeURIComponent(lang)}`;
    const r = await fetch(url, { method: "GET" });
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

// --- init -------------------------------------------------------------------
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
    "aiModel",
    "customApiUrl",
  ]);

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
  els.model.value = normalizeAiModel(stored.aiModel);
  els.api.value = String(stored.customApiUrl || "");
  state.apiUrl = els.api.value;

  loadCurrent();

  // read query params (?lang=&model=) so the popup can deep-link.
  const q = new URLSearchParams(location.search);
  if (q.get("lang")) els.lang.value = q.get("lang");
  if (q.get("model")) els.model.value = normalizeAiModel(q.get("model"));
  loadCurrent();
}

// --- events -----------------------------------------------------------------
els.lang.addEventListener("change", loadCurrent);
els.model.addEventListener("input", updateCount);
els.model.addEventListener("change", loadCurrent);
els.text.addEventListener("input", updateCount);
els.api.addEventListener("change", async () => {
  await setStorage({ customApiUrl: String(els.api.value || "").trim() });
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
